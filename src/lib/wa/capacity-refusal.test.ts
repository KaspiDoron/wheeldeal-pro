import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// THE CAP DID NOT APPLY TO THE ONE ARRANGEMENT IT WAS WRITTEN FOR.
//
// Owner report 8 wave A made the per-host cap REFUSE instead of overfilling,
// because with a single Render box and 50 testers every socket landed on
// 512 MB. But resolveHost opened with `if (hosts.length === 1) return
// hosts[0];` above everything, so on a single-host deployment - today's
// deployment, and the exact case in the commit message - neither the cap nor
// the refusal ever ran.

// REWRITTEN AS EXECUTED COVERAGE (owner report 10, test integrity).
//
// Every assertion in this block used to be a regex over evolution.ts, because
// `resolveHost` needs Supabase, the key vault and live health probes to reach.
// That is exactly how this decision shipped THREE defects in a row - the
// single-host cap escape, the "place them anyway" fallback, and the missing
// occupant exemption on the multi-host branch - past a green suite: all three
// are shape errors in a decision tree, and a regex cannot evaluate a tree.
//
// The decision is `placeHost` in wa/host-placement now. These run it.
const H = (url: string, dialPrefixes: string[] = []) => ({ url, dialPrefixes });

describe("one host is not an exemption from the cap", () => {
  it("EXECUTED: a NEW user is refused once the single host is full", async () => {
    const { placeHost } = await import("./host-placement");
    const only = [H("https://a")];
    expect(placeHost({ hosts: only, counts: { "https://a": 24 }, cap: 25 })).toEqual(only[0]);
    // At the cap, the honest answer is null - the caller reports capacity.
    expect(placeHost({ hosts: only, counts: { "https://a": 25 }, cap: 25 })).toBeNull();
    expect(placeHost({ hosts: only, counts: { "https://a": 99 }, cap: 25 })).toBeNull();
  });

  it("EXECUTED: an ALREADY-PLACED user is never evicted by the cap", async () => {
    // The cap governs placement. Every SEND path calls this, so refusing an
    // occupant does not protect a box - it breaks a hunt for someone who is
    // not the problem.
    const { placeHost } = await import("./host-placement");
    const only = [H("https://a")];
    expect(
      placeHost({ hosts: only, stored: "https://a", counts: { "https://a": 99 }, cap: 25 })
    ).toEqual(only[0]);
  });

  it("EXECUTED: no host configured is null, not a crash", async () => {
    const { placeHost } = await import("./host-placement");
    expect(placeHost({ hosts: [], counts: {}, cap: 25 })).toBeNull();
  });
});

describe("the multi-host path applies the same rules, not different ones", () => {
  it("EXECUTED: a user stays on their stored host while it is healthy", async () => {
    const { placeHost } = await import("./host-placement");
    const hosts = [H("https://a"), H("https://b")];
    expect(
      placeHost({
        hosts,
        stored: "https://b",
        counts: { "https://a": 0, "https://b": 20 },
        cap: 25,
        healthy: hosts,
      })
    ).toEqual(hosts[1]);
  });

  it("EXECUTED: THE ASYMMETRY - an occupant survives a full fleet plus a probe blip", async () => {
    // The defect: a stored user is kept above only while their host passes the
    // probe. One transient failure on a fleet at cap dropped them through to
    // the refusal and returned null - on the send path, for a LINKED user.
    const { placeHost } = await import("./host-placement");
    const hosts = [H("https://a"), H("https://b")];
    const got = placeHost({
      hosts,
      stored: "https://b",
      counts: { "https://a": 25, "https://b": 25 },
      cap: 25,
      healthy: [hosts[0]], // b's probe blipped
    });
    expect(got, "their own host, not null").toEqual(hosts[1]);
  });

  it("EXECUTED: a NEW user on a full fleet is refused, not placed on the fullest box", async () => {
    // `underCap.length ? underCap : pickFrom` used to place them anyway, which
    // is the exact moment a cap exists for.
    const { placeHost } = await import("./host-placement");
    const hosts = [H("https://a"), H("https://b")];
    expect(
      placeHost({
        hosts,
        counts: { "https://a": 25, "https://b": 30 },
        cap: 25,
        healthy: hosts,
      })
    ).toBeNull();
  });

  it("EXECUTED: a new user lands on the LEAST-loaded host under the cap", async () => {
    const { placeHost } = await import("./host-placement");
    const hosts = [H("https://a"), H("https://b"), H("https://c")];
    expect(
      placeHost({
        hosts,
        counts: { "https://a": 20, "https://b": 3, "https://c": 12 },
        cap: 25,
        healthy: hosts,
      })
    ).toEqual(hosts[1]);
  });

  it("EXECUTED: GEO beats load - a Thai number prefers the host that claims 66", async () => {
    const { placeHost } = await import("./host-placement");
    const hosts = [H("https://us"), H("https://sg", ["66", "84", "855"])];
    // The US box is emptier, and still loses: an IP/number continent mismatch
    // is a separately scored ban signal, and placement is the free half of it.
    expect(
      placeHost({
        hosts,
        counts: { "https://us": 0, "https://sg": 15 },
        cap: 25,
        healthy: hosts,
        digits: "66812345678",
      })
    ).toEqual(hosts[1]);
  });

  it("EXECUTED: a FULL geo-correct host does not trap the user - load wins over nothing", async () => {
    const { placeHost } = await import("./host-placement");
    const hosts = [H("https://us"), H("https://sg", ["66"])];
    // sg is at cap, so it is not a candidate at all. A placement on the wrong
    // continent beats a tester who cannot link.
    expect(
      placeHost({
        hosts,
        counts: { "https://us": 0, "https://sg": 25 },
        cap: 25,
        healthy: hosts,
        digits: "66812345678",
      })
    ).toEqual(hosts[0]);
  });

  it("EXECUTED: with no regions declared anywhere, ranking IS the old least-loaded order", async () => {
    // The compatibility promise of the geo change: every deployment before it
    // has empty prefixes everywhere, and must behave exactly as it did.
    const { placeHost } = await import("./host-placement");
    const hosts = [H("https://a"), H("https://b"), H("https://c")];
    for (const digits of ["", "66812345678", "447700900000"]) {
      expect(
        placeHost({
          hosts,
          counts: { "https://a": 9, "https://b": 2, "https://c": 5 },
          cap: 25,
          healthy: hosts,
          digits,
        })
      ).toEqual(hosts[1]);
    }
  });

  it("the resolver delegates instead of keeping a second copy of the rule", () => {
    const evo = readCode("src/lib/evolution.ts");
    expect(evo).toMatch(/placeHost<Host>\(\{/);
    // The three defect shapes must not reappear inline.
    expect(evo).not.toMatch(/if \(hosts\.length === 1\) return hosts\[0\];/);
    expect(evo).not.toMatch(/underCap\.length \? underCap : pickFrom/);
  });
});

describe("EXECUTED: capacity governs who JOINS, never who may be spoken to", () => {
  // THE DEFECT THIS EXISTS FOR. A capacity refusal returned to a SERVE call is
  // not a refusal: `resolveHost` fronts `evo()`, which fronts fifteen endpoints
  // - sending, media download, connection state, mark-read - and a null there
  // surfaces as {ok:false, status:0}, which the send path deliberately treats
  // as an AMBIGUOUS transport failure. A blocked spec put the refusal inside
  // that shared resolver, which would have turned one full fleet into a
  // fleet-wide WhatsApp outage wearing the costume of a network blip.
  const A = { url: "https://a", dialPrefixes: [] as string[] };
  const B = { url: "https://b", dialPrefixes: [] as string[] };

  it("a FULL fleet still answers a serve call - placeHost would refuse it", async () => {
    const { placeHost, serveHost } = await import("./host-placement");
    const counts = { "https://a": 99, "https://b": 99 };
    expect(placeHost({ hosts: [A, B], counts, cap: 25 })).toBeNull();
    expect(serveHost({ hosts: [A, B], counts })).not.toBeNull();
  });

  it("the stored host wins whatever the cap says", async () => {
    const { serveHost } = await import("./host-placement");
    expect(
      serveHost({ hosts: [A, B], stored: "https://a", counts: { "https://a": 500 } })?.url
    ).toBe("https://a");
  });

  it("one configured host is the only answer that can be right", async () => {
    const { serveHost } = await import("./host-placement");
    expect(serveHost({ hosts: [A], counts: { "https://a": 9999 } })?.url).toBe("https://a");
    // ...including when the stored host is one we no longer configure.
    expect(serveHost({ hosts: [A], stored: "https://gone", counts: {} })?.url).toBe("https://a");
  });

  it("with no stored host it falls to the least loaded, not the first", async () => {
    const { serveHost } = await import("./host-placement");
    expect(serveHost({ hosts: [A, B], counts: { "https://a": 20, "https://b": 3 } })?.url).toBe(
      "https://b"
    );
  });

  it("no hosts configured is still null - that is a real 'not set up'", async () => {
    const { serveHost } = await import("./host-placement");
    expect(serveHost({ hosts: [], counts: {} })).toBeNull();
  });

  it("the resolver uses it, and only the link path can be refused", () => {
    const evo = readCode("src/lib/evolution.ts");
    expect(evo).toMatch(/if \(!chosen && !forPlacement\) return serveHost<Host>\(/);
    expect(evo.match(/forPlacement: true/g)?.length).toBe(1);
  });

  it("an UNREADABLE session row can never produce a refusal", () => {
    // `sbSelect` has no rejection path at all - no connection, any non-2xx and
    // a parse throw all return [] - so `stored` read permissively made a
    // Supabase blip indistinguishable from "never linked", and the occupant
    // exemption silently stopped applying to a user who was already placed.
    const evo = readCode("src/lib/evolution.ts");
    expect(evo).toMatch(/const storedRes = await sbSelectStrict<\{ host_url: string \| null \}>/);
    expect(evo).toMatch(/storedRes\.error === "unavailable"/);
    expect(evo).toMatch(/if \(storedUnreadable && !forPlacement && hosts\.length === 1\) return hosts\[0\];/);
  });

  it("a pairing in flight holds its slot, bounded by staleness", () => {
    // A number mid-pairing has a real socket on the box. Counting only
    // status=open under-counted a host by exactly the number of links in
    // flight - and a link burst is when the cap matters most.
    const evo = readCode("src/lib/evolution.ts");
    expect(evo).toMatch(/status=eq\.connecting&updated_at=gte\./);
    expect(evo).toMatch(/const CONNECTING_SLOT_TTL_MS = 15 \* 60_000;/);
  });
});

describe("at capacity says so, instead of blaming the configuration", () => {
  const evo = readCode("src/lib/evolution.ts");

  it("the two null causes get two different messages", () => {
    const at = evo.indexOf("const host = await resolveHost(email, phone, { forPlacement: true });");
    expect(at).toBeGreaterThan(-1);
    const branch = evo.slice(at, at + 1200);
    expect(branch).toMatch(/const configured = await getHosts\(\);/);
    expect(branch).toMatch(/configured\.length/);
    expect(branch).toMatch(/at capacity right now/);
    expect(branch).toMatch(/The WhatsApp connector is not set up yet\./);
    // ...and the difference is machine-readable now, not merely worded
    // differently. Three refusals shared one `{ok:false, error}` shape and
    // could be told apart only by matching English prose, while the owner's
    // action differs for each: add a host, paste a key, wait for a restart.
    expect(branch).toMatch(/atCapacity: configured\.length > 0,/);
  });

  it("the capacity message is something a TESTER can act on", () => {
    // The owner-facing "add EVOLUTION_API_URL in Admin -> Keys" answer is
    // useless to the person who actually hits this.
    const m = readCode("src/lib/evolution.ts").match(/"([^"]*at capacity right now[^"]*)"/);
    expect(m).toBeTruthy();
    expect(m![1]).toMatch(/Try again shortly/);
    expect(m![1]).not.toMatch(/Admin -> Keys/);
  });
});

describe("the daily cold ceiling is OFF by default, as the capacity model intends", () => {
  it("a fixed daily cap is the OLD model and must not bind out of the box", () => {
    // wa/capacity.ts opens by explaining why a fixed 15/day was replaced: the
    // warm-up ramp crushed it to ~2 shops for a whole day and everything parked
    // until tomorrow morning. Wave D wired the dead knob up - correctly - and in
    // doing so silently reinstated that model for every plan above free.
    const guard = readCode("src/lib/wa-guard.ts");
    expect(guard).toMatch(/max_new_contacts_per_day: 0,/);
    expect(guard).not.toMatch(/max_new_contacts_per_day: 15,/);
  });

  it("but the knob still WORKS when an owner sets it", () => {
    const guard = readCode("src/lib/wa-guard.ts");
    expect(guard).toMatch(/const dailyIntroCap = Number\(p\.max_new_contacts_per_day\) \|\| 0;/);
    expect(guard).toMatch(/if \(dailyIntroCap > 0\) \{/);
    // Fail-closed on an unreadable count, like every other term in the budget.
    expect(guard).toMatch(/!day \|\| day\.unreadable \? 0 :/);
  });

  it("0 is settable, so the field can be returned to its own default", () => {
    const pv = readCode("src/lib/wa/policy-values.ts");
    expect(pv).toMatch(/max_new_contacts_per_day: \{ kind: "number", min: 0,/);
  });

  it("the admin panel says it is an extra ceiling, not THE limit", () => {
    const admin = read("src/app/api/admin/wa-security/route.ts");
    const at = admin.indexOf("max_new_contacts_per_day: {");
    const entry = admin.slice(at, at + 900);
    expect(entry).toMatch(/0 = off \(the default\)/);
    expect(entry).toMatch(/on top of the plan's rolling window/i);
    // The old copy called it "THE most important limit", which it is not.
    expect(entry).not.toMatch(/THE most important limit/);
  });
});
