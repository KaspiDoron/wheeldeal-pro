import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { clientIp, SHARED_BUCKET, rateLimit, _resetRateLimit } from "./rate-limit";

// THE LIMITER WAS KEYED ON A VALUE THE ATTACKER WRITES.
//
// Every IP-keyed limit in this app - the forgot-password throttle that exists to
// stop a known account being locked out and its inbox flooded, the feedback
// storage cap, the billed Places proxy - went through clientIp, and clientIp
// returned hop 0 of X-Forwarded-For. Google's front end does not REPLACE that
// header, it APPENDS the address it observed: a request carrying
// `X-Forwarded-For: 1.2.3.4` reaches the container as `1.2.3.4, <real ip>`. So
// hop 0 is whatever the caller typed, and rotating it per request bought an
// attacker an unlimited number of fresh buckets.
//
// These tests run the attack rather than reading the source: they build the
// header exactly as the platform delivers it and assert that the counter still
// closes.

const req = (headers: Record<string, string> = {}) =>
  new Request("https://wheeldeal.pro/api/auth/forgot", { headers });

describe("clientIp reads the hop the platform guarantees, not the one the caller sends", () => {
  const saved = process.env.TRUSTED_PROXY_HOPS;
  afterEach(() => {
    if (saved === undefined) delete process.env.TRUSTED_PROXY_HOPS;
    else process.env.TRUSTED_PROXY_HOPS = saved;
  });

  it("takes the APPENDED address, ignoring everything the client prefixed", () => {
    // This assertion is the inverse of the Wave 0 one, which pinned hop 0 as
    // "newest-hop first". That reading was wrong about the platform: on Cloud
    // Run the newest hop is the LAST one. Same intent (identify the caller),
    // corrected direction.
    expect(clientIp(req({ "x-forwarded-for": "1.2.3.4, 203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientIp(req({ "x-forwarded-for": "9.9.9.9" }))).toBe("9.9.9.9");
  });

  it("a spoofed chain, however long, cannot displace the appended address", () => {
    const spoof = ["10.0.0.1", "evil", "8.8.8.8", "127.0.0.1"].join(", ");
    expect(clientIp(req({ "x-forwarded-for": `${spoof}, 203.0.113.7` }))).toBe("203.0.113.7");
  });

  it("fails CLOSED into one shared bucket when there is no trustworthy value", () => {
    expect(clientIp(req())).toBe(SHARED_BUCKET);
    expect(clientIp(req({ "x-forwarded-for": " , " }))).toBe(SHARED_BUCKET);
    // Not an address - a caller could otherwise mint buckets by writing prose
    // into the position the platform normally fills.
    expect(clientIp(req({ "x-forwarded-for": "not-an-ip" }))).toBe(SHARED_BUCKET);
  });

  it("ignores headers nothing in this deployment writes", () => {
    // x-real-ip / cf-connecting-ip / fly-client-ip were fallbacks; no proxy here
    // sets them, so they were pure attacker input with a trustworthy name.
    expect(
      clientIp(
        req({ "x-real-ip": "1.2.3.4", "cf-connecting-ip": "5.6.7.8", "fly-client-ip": "9.9.9.9" })
      )
    ).toBe(SHARED_BUCKET);
  });

  it("drops the port so one client cannot occupy many buckets", () => {
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.7:51000" }))).toBe("203.0.113.7");
    // REWRITTEN, INTENT PRESERVED (audit F185): this pinned the full /128
    // address as the key, which was the same defect as keeping the port at 64
    // bits of freedom. The key is the /64 routing prefix now - see
    // ipv6-prefix-bucket.test.ts for the attack run end to end.
    expect(clientIp(req({ "x-forwarded-for": "[2001:db8::1]:443" }))).toBe("2001:db8:0:0::/64");
  });

  it("TRUSTED_PROXY_HOPS shifts left by the proxies that append after the client", () => {
    // Put a load balancer in front and it appends its own address too:
    // <spoof>, <client>, <lb>.
    process.env.TRUSTED_PROXY_HOPS = "1";
    expect(clientIp(req({ "x-forwarded-for": "1.2.3.4, 203.0.113.7, 34.1.1.1" }))).toBe(
      "203.0.113.7"
    );
    // And when the chain is too short for that claim, it is the shared bucket -
    // never the value sitting at hop 0.
    expect(clientIp(req({ "x-forwarded-for": "1.2.3.4" }))).toBe(SHARED_BUCKET);
  });
});

describe("ATTACK: rotating X-Forwarded-For no longer buys a fresh window", () => {
  beforeEach(() => _resetRateLimit());

  it("100 requests with a rotated hop 0 still hit the forgot-password ceiling", async () => {
    // The real deployment's shape: the attacker controls the prefix, Google
    // appends their actual address.
    const verdicts: boolean[] = [];
    for (let i = 0; i < 8; i++) {
      const r = req({ "x-forwarded-for": `10.0.0.${i}, 198.51.100.9` });
      // The exact limits /api/auth/forgot applies per IP.
      verdicts.push((await rateLimit("forgot-ip", clientIp(r), 3, 3600)).ok);
    }
    expect(verdicts.slice(0, 3)).toEqual([true, true, true]);
    expect(verdicts.slice(3).every((v) => v === false)).toBe(true);
  });

  it("two genuinely different clients still get their own windows", async () => {
    for (let i = 0; i < 4; i++) {
      await rateLimit("forgot-ip", clientIp(req({ "x-forwarded-for": "1.1.1.1, 198.51.100.9" })), 3, 3600);
    }
    expect(
      (await rateLimit("forgot-ip", clientIp(req({ "x-forwarded-for": "198.51.100.9" })), 3, 3600)).ok
    ).toBe(false);
    expect(
      (await rateLimit("forgot-ip", clientIp(req({ "x-forwarded-for": "203.0.113.7" })), 3, 3600)).ok
    ).toBe(true);
  });

  it("unattributable callers share one window rather than each getting a free one", async () => {
    for (let i = 0; i < 3; i++) {
      expect((await rateLimit("forgot-ip", clientIp(req()), 3, 3600)).ok).toBe(true);
    }
    // A second, unrelated header-less caller lands in the same bucket - the
    // fail-closed direction.
    expect((await rateLimit("forgot-ip", clientIp(req({ "x-real-ip": "1.2.3.4" })), 3, 3600)).ok).toBe(
      false
    );
  });
});
