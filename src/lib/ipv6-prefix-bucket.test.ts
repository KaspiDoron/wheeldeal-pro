import { describe, it, expect, beforeEach } from "vitest";
import { clientIp, SHARED_BUCKET, rateLimit, _resetRateLimit } from "./rate-limit";

// AUDIT F185 - IPv6 callers were bucketed per /128 address, so one routed /64
// (the smallest block any provider hands a single customer) held 2^64 fresh
// rate-limit windows. The apex publishes AAAA records straight at Google, so
// IPv6 reaches the app and the appended hop is the caller's real address:
// binding a new host address per request emptied every IP-keyed cap in the
// app - the feedback LLM+storage cap, the billed Places proxy, the login
// per-IP window.
//
// The key is now the /64 routing prefix. IPv4 is untouched, and the two
// IPv4-in-IPv6 spellings (`::ffff:a.b.c.d` mapped, `::a.b.c.d` compatible,
// in dotted or hex form) unwrap to the IPv4 branch FIRST - a naive high-64-bit
// truncation would have folded the whole IPv4 space into the single prefix
// 0:0:0:0::/64 and locked every real user into one shared window.
//
// Executed: the attack is run through the real clientIp + rateLimit pair with
// the header exactly as the platform delivers it.

const req = (xff: string) =>
  new Request("https://wheeldeal.pro/api/feedback", { headers: { "x-forwarded-for": xff } });

describe("an IPv6 caller is keyed on its /64 prefix", () => {
  it("collapses the host half of the address", () => {
    expect(clientIp(req("2001:db8:1:1::1"))).toBe("2001:db8:1:1::/64");
    expect(clientIp(req("2001:db8:1:1:dead:beef:cafe:1"))).toBe("2001:db8:1:1::/64");
    // Bracket + port form, and case, normalise to the same key.
    expect(clientIp(req("[2001:DB8::1]:443"))).toBe("2001:db8:0:0::/64");
    expect(clientIp(req("2001:db8::1"))).toBe("2001:db8:0:0::/64");
  });

  it("unwraps IPv4-in-IPv6 to the IPv4 branch instead of folding all of IPv4 into one prefix", () => {
    expect(clientIp(req("::ffff:203.0.113.7"))).toBe("203.0.113.7");
    // The hex spelling of the same mapped address.
    expect(clientIp(req("::ffff:cb00:7107"))).toBe("203.0.113.7");
    // The deprecated compatible form.
    expect(clientIp(req("::203.0.113.7"))).toBe("203.0.113.7");
    // ...and they share a window with the plain IPv4 spelling, not with each other's neighbours.
    expect(clientIp(req("::ffff:203.0.113.8"))).toBe("203.0.113.8");
  });

  it("leaves IPv4 exactly as it was", () => {
    expect(clientIp(req("203.0.113.7"))).toBe("203.0.113.7");
    expect(clientIp(req("1.2.3.4, 203.0.113.7:51000"))).toBe("203.0.113.7");
  });

  it("anything that is not a parseable address still fails CLOSED into the shared bucket", () => {
    expect(clientIp(req(":::"))).toBe(SHARED_BUCKET);
    expect(clientIp(req("1:2:3:4:5:6:7:8:9"))).toBe(SHARED_BUCKET);
    expect(clientIp(req("2001:db8::g"))).toBe(SHARED_BUCKET);
    expect(clientIp(req("::ffff:999.0.113.7"))).toBe(SHARED_BUCKET);
    expect(clientIp(req("1::2::3"))).toBe(SHARED_BUCKET);
  });
});

describe("ATTACK: rotating the low 64 bits no longer buys a fresh window", () => {
  beforeEach(() => _resetRateLimit());

  it("REGRESSION: 20 requests from one /64 still hit the forgot-ip ceiling", async () => {
    const verdicts: boolean[] = [];
    for (let i = 1; i <= 20; i++) {
      // The caller controls the prefix, Google appends their real address -
      // which they rotate through their own /64 per request.
      const r = req(`10.0.0.${i}, 2001:db8:1:1::${i.toString(16)}`);
      verdicts.push((await rateLimit("forgot-ip", clientIp(r), 3, 3600)).ok);
    }
    expect(verdicts.slice(0, 3)).toEqual([true, true, true]);
    expect(verdicts.slice(3).every((v) => v === false), "the ceiling must close").toBe(true);
  });

  it("two genuinely different /64s still get their own windows", async () => {
    for (let i = 0; i < 4; i++) {
      await rateLimit("forgot-ip", clientIp(req("2001:db8:1:1::5")), 3, 3600);
    }
    expect((await rateLimit("forgot-ip", clientIp(req("2001:db8:1:1::6")), 3, 3600)).ok).toBe(false);
    expect((await rateLimit("forgot-ip", clientIp(req("2001:db8:1:2::5")), 3, 3600)).ok).toBe(true);
  });
});
