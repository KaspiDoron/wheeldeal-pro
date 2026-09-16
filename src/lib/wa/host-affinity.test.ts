import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { placeHost, serveHost } from "./host-placement";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// HOST AFFINITY - a placed user is never moved between lanes.
//
// The free fleet gives every Evolution lane its OWN Postgres (deploy/fleet/
// docker-compose.yml). A WhatsApp session therefore exists on exactly one box,
// and "failing a user over" to another box cannot resume anything: it creates
// an EMPTY instance there (a phantom the cap never counts), the send fails
// anyway, and on a re-link it PAIRS the number a second time while the first
// box still holds the old registration - two live sockets for one number is
// connectionReplaced, the top-weighted ban signal.
//
// So the rule is: a host still listed in EVOLUTION_HOSTS owns its users,
// healthy or not. Removing the line is what releases them.

const H = (url: string) => ({ url, dialPrefixes: [] as string[] });

describe("a placed user stays on their host through a probe blip", () => {
  it("THE REGRESSION: room elsewhere no longer moves a linked user off a dark host", () => {
    // The old rule kept the stored host only while it was in `healthy`, and
    // otherwise re-placed the user on the emptiest healthy box. With room on
    // `a`, `b`'s one failed probe sent b's user to a. This is the case the
    // existing tests never covered - they pinned only the FULL-fleet exemption.
    const hosts = [H("https://a"), H("https://b")];
    const got = placeHost({
      hosts,
      stored: "https://b",
      counts: { "https://a": 0, "https://b": 20 },
      cap: 25,
      healthy: [hosts[0]], // b's probe blipped, a has 25 free slots
    });
    expect(got?.url, "their own host, not the empty one").toBe("https://b");
  });

  it("the same on a RE-LINK (placement call): no second registration on another box", () => {
    // placeHost has no forPlacement flag - the rule is the same for both, on
    // purpose: a re-link while the user's lane is down must wait for the lane,
    // not pair the number elsewhere beside a live registration.
    const hosts = [H("https://a"), H("https://b")];
    const got = placeHost({
      hosts,
      stored: "https://b",
      counts: { "https://a": 0, "https://b": 20 },
      cap: 25,
      healthy: [hosts[0]],
      digits: "66812345678",
    });
    expect(got?.url).toBe("https://b");
  });

  it("every host dark at once does NOT stampede 200 users onto one box", () => {
    // `healthy` empty used to make pickFrom = hosts and rank every stored user
    // onto the single emptiest host together.
    const hosts = [H("https://a"), H("https://b"), H("https://c")];
    for (const stored of ["https://a", "https://b", "https://c"]) {
      const got = placeHost({
        hosts,
        stored,
        counts: { "https://a": 0, "https://b": 30, "https://c": 30 },
        cap: 50,
        healthy: [],
      });
      expect(got?.url).toBe(stored);
    }
  });

  it("a stored host that is OVER its cap still serves its own occupant", () => {
    // Unchanged from before, pinned so the affinity rewrite cannot lose it.
    const hosts = [H("https://a"), H("https://b")];
    const got = placeHost({
      hosts,
      stored: "https://b",
      counts: { "https://a": 25, "https://b": 40 },
      cap: 25,
      healthy: hosts,
    });
    expect(got?.url).toBe("https://b");
  });
});

describe("removing the host's line is what releases its users", () => {
  it("a stored url no longer in EVOLUTION_HOSTS falls through to fresh placement", () => {
    // The owner retired lane `b` (deploy/fleet/README.md, "Retiring Render"):
    // its line is gone, so `stored` matches nothing and the user is placed
    // like a newcomer - on the emptiest healthy box under cap.
    const hosts = [H("https://a"), H("https://c")];
    const got = placeHost({
      hosts,
      stored: "https://b",
      counts: { "https://a": 10, "https://c": 3 },
      cap: 25,
      healthy: hosts,
    });
    expect(got?.url).toBe("https://c");
  });

  it("...and a retired host's user on a FULL fleet is refused, like any newcomer", () => {
    const hosts = [H("https://a"), H("https://c")];
    const got = placeHost({
      hosts,
      stored: "https://b",
      counts: { "https://a": 25, "https://c": 25 },
      cap: 25,
      healthy: hosts,
    });
    expect(got).toBeNull();
  });

  it("serveHost agrees: the stored host is the answer while it is configured", () => {
    const hosts = [H("https://a"), H("https://b")];
    expect(serveHost({ hosts, stored: "https://b", counts: { "https://a": 0, "https://b": 40 } })?.url).toBe(
      "https://b"
    );
  });
});

describe("resolveHost pays nothing for a placed user", () => {
  // resolveHost is IO-bound (Supabase, the vault, live probes), so the pure
  // rule above is executed and this is the wiring claim: the stored-host
  // return sits ABOVE the probe fan-out, the fleet count, the linked-number
  // read and the mismatch note, so none of them run on a serve call.
  const evo = readCode("src/lib/evolution.ts");
  const fn = evo.slice(evo.indexOf("async function resolveHost("));
  const body = fn.slice(0, fn.indexOf("\nexport async function hostsStatus"));

  it("the stored host returns before any host is probed", () => {
    const ret = body.indexOf("const own = hosts.find((h) => h.url === stored);");
    const probe = body.indexOf("hostHealthy(h)");
    const counts = body.indexOf("await hostUserCounts()");
    const linked = body.indexOf("await linkedNumberFor(email)");
    expect(ret).toBeGreaterThan(-1);
    expect(probe).toBeGreaterThan(-1);
    expect(ret, "probe fan-out must come after the stored return").toBeLessThan(probe);
    expect(ret, "fleet count must come after the stored return").toBeLessThan(counts);
    expect(ret, "linked-number read must come after the stored return").toBeLessThan(linked);
  });

  it("the geo-mismatch note is written on a PLACEMENT only", () => {
    // Unconditional, it was one agent_events row per send, presence beat and
    // status read for the life of the placement.
    expect(body).toMatch(/if \(forPlacement && chosen && digits && affinityFor\(/);
  });

  it("the placement rule itself no longer consults `healthy` for a stored user", () => {
    const hp = readCode("src/lib/wa/host-placement.ts");
    const fn = hp.slice(hp.indexOf("export function placeHost"));
    // The old shape: `healthy.find((x) => x.url === stored)`.
    expect(fn).not.toMatch(/healthy\.find\(\(x\) => x\.url === stored\)/);
    expect(fn).toMatch(/const own = hosts\.find\(\(x\) => x\.url === stored\);/);
  });
});
