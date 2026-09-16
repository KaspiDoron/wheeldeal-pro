import { describe, it, expect } from "vitest";
import { splitHostLines, parseHostCap } from "../evolution";
import { parseDialPrefixes } from "./host-region";
import { placeHost } from "./host-placement";
import { hostOccupancy, inviteHeadroom } from "../chokepoints";

// PER-HOST CAPACITY - the fourth EVOLUTION_HOSTS field.
//
// The fleet is deliberately heterogeneous (deploy/fleet/README.md): free lanes
// run from a 1GB Oracle AMD micro to a 6GB Oracle ARM instance. One fleet-wide
// `EVOLUTION_MAX_PER_HOST` has to be sized for the SMALLEST box, so the biggest
// lane sits at a fraction of what it holds - and raising the global number
// instead authorises the 1GB box to overfill, which does not degrade into a
// queue: every socket on it drops at once, and each one is a traveller's
// PERSONAL WhatsApp number.
//
// So the cap moves onto the host, beside the key and region that already live
// there. Every assertion here also pins the other half of the claim: a
// deployment that declares no per-host cap behaves exactly as it did before.

// Parse a full host line the way getHosts does, so these tests exercise the
// real pipeline (splitter -> field split -> parsers) rather than a paraphrase.
function parseHosts(blob: string) {
  return splitHostLines(blob)
    .map((line) => {
      const [url, key, regions, cap] = line.split("|").map((x) => x?.trim());
      return url && key
        ? { url, key, dialPrefixes: parseDialPrefixes(regions), cap: parseHostCap(cap) }
        : null;
    })
    .filter((h): h is NonNullable<typeof h> => h !== null);
}

describe("the parser survives a FOURTH field", () => {
  it("THE REGRESSION: a capped host with several prefixes is still ONE host", () => {
    // `https://sg|KEY|66,84|60` split on the comma into `https://sg|KEY|66`
    // and `84|60`. Both cleared the old "has a pipe in it" bar, so the line
    // became two hosts: the real one stripped to a single prefix, plus a
    // PHANTOM at url "84" with "60" as its API key. A phantom is worse than a
    // dropped host - it counts toward fleet capacity, it is offered to
    // placeHost, and every user placed on it cannot link at all.
    const hosts = parseHosts("https://sg.example.com|KEY|66,84,855|60");
    expect(hosts).toHaveLength(1);
    expect(hosts[0].url).toBe("https://sg.example.com");
    expect(hosts[0].key).toBe("KEY");
    expect(hosts[0].dialPrefixes).toHaveLength(3);
    expect(hosts[0].cap).toBe(60);
    // The phantom, named explicitly so a regression is unmistakable.
    expect(hosts.map((h) => h.url)).not.toContain("84");
  });

  it("a fragment is a host only if it STARTS WITH A URL", () => {
    // The legacy comma form still works - that is what the rule was for.
    expect(splitHostLines("https://a|K1,https://b|K2")).toEqual([
      "https://a|K1",
      "https://b|K2",
    ]);
    expect(splitHostLines("https://a|K1|66,https://b|K2|84")).toHaveLength(2);
    // ...and anything whose fragments are not URLs is one host, commas and all.
    expect(splitHostLines("https://a|K1|66,84|60")).toHaveLength(1);
    expect(splitHostLines("https://a|K1|1,2,3")).toHaveLength(1);
  });

  it("a junk cap degrades to the fleet default, never to zero", () => {
    // Zero would read downstream as "at capacity" and refuse every new link on
    // that host - a typo must not silently take a lane out of the fleet.
    for (const junk of ["", "  ", "abc", "0", "-5", undefined, null]) {
      expect(parseHostCap(junk)).toBeUndefined();
    }
    expect(parseHostCap("60")).toBe(60);
    expect(parseHostCap(" 40 ")).toBe(40);
    expect(parseHostCap("25.9")).toBe(25);
  });

  it("a line with no fourth field is unchanged - opting in is additive", () => {
    const hosts = parseHosts("https://a.example.com|KEY|66,84");
    expect(hosts).toHaveLength(1);
    expect(hosts[0].cap).toBeUndefined();
    expect(hosts[0].dialPrefixes).toEqual(["66", "84"]);
  });

  it("a cap with NO regions parses through the empty third field", () => {
    const hosts = parseHosts("https://a.example.com|KEY||60");
    expect(hosts).toHaveLength(1);
    expect(hosts[0].dialPrefixes).toEqual([]);
    expect(hosts[0].cap).toBe(60);
  });
});

describe("the lines deploy/fleet/setup.sh prints actually parse", () => {
  // setup.sh builds the EVOLUTION_HOSTS line for a freshly stood-up host and
  // tells the owner to paste it. If the shape it emits and the shape this
  // parser accepts ever drift, the owner pastes a line that looks right and
  // silently yields a mis-parsed or phantom host. Pin all three shapes it can
  // produce - prefixes+cap, cap alone, prefixes alone.
  it("prefixes AND a cap", () => {
    const hosts = parseHosts("https://sg.example.com|deadbeef|66,84,855|50");
    expect(hosts).toHaveLength(1);
    expect(hosts[0].url).toBe("https://sg.example.com");
    expect(hosts[0].dialPrefixes).toHaveLength(3);
    expect(hosts[0].cap).toBe(50);
  });

  it("a cap with NO prefixes - the empty third field the script emits", () => {
    const hosts = parseHosts("https://us.example.com|deadbeef||25");
    expect(hosts).toHaveLength(1);
    expect(hosts[0].dialPrefixes).toEqual([]);
    expect(hosts[0].cap).toBe(25);
  });

  it("prefixes with no cap falls back to the fleet default", () => {
    const hosts = parseHosts("https://sg.example.com|deadbeef|66,84");
    expect(hosts).toHaveLength(1);
    expect(hosts[0].cap).toBeUndefined();
  });

  it("several hosts, one per line, is still several hosts", () => {
    const hosts = parseHosts(
      [
        "https://arm-sg.example.com|k1|66,84,855,856,60,65|50",
        "https://micro-sg.example.com|k2|66,84,855|25",
        "https://us.example.com|k3||25",
      ].join("\n")
    );
    expect(hosts).toHaveLength(3);
    expect(hosts.map((h) => h.cap)).toEqual([50, 25, 25]);
    // The whole point: capacity is the SUM, and it is not 3 x the default.
    expect(hosts.reduce((s, h) => s + (h.cap ?? 25), 0)).toBe(100);
  });
});

describe("placement honours the host's own cap", () => {
  const big = { url: "https://arm", dialPrefixes: [] as string[], cap: 60 };
  const small = { url: "https://micro", dialPrefixes: [] as string[], cap: 25 };
  const capFor = (h: { cap?: number }) => h.cap;

  it("the big lane keeps accepting past the fleet default", () => {
    // 40 users on a host whose own cap is 60. Against the fleet default of 25
    // this host was full fifteen users ago.
    const chosen = placeHost({
      hosts: [big],
      counts: { "https://arm": 40 },
      cap: 25,
      capFor,
    });
    expect(chosen?.url).toBe("https://arm");
  });

  it("the small lane still REFUSES at its own cap, whatever the default is", () => {
    // This is the half that protects the number. Raising the global cap to 60
    // would have placed this user; the per-host cap does not.
    expect(
      placeHost({ hosts: [small], counts: { "https://micro": 25 }, cap: 60, capFor })
    ).toBeNull();
  });

  it("a full fleet of mixed lanes refuses rather than overfilling the small one", () => {
    expect(
      placeHost({
        hosts: [big, small],
        counts: { "https://arm": 60, "https://micro": 25 },
        cap: 25,
        capFor,
        healthy: [big, small],
      })
    ).toBeNull();
  });

  it("AN OCCUPANT IS STILL NOT AN APPLICANT under a per-host cap", () => {
    // The exemption this file's neighbours record three defects about: someone
    // already on a host consumes no new slot, so an over-cap host still serves
    // its own occupant rather than evicting them onto nothing.
    expect(
      placeHost({
        hosts: [small],
        stored: "https://micro",
        counts: { "https://micro": 99 },
        cap: 25,
        capFor,
      })?.url
    ).toBe("https://micro");
  });
});

describe("load is FULLNESS, so the big lane fills first", () => {
  const big = { url: "https://arm", dialPrefixes: [] as string[], cap: 60 };
  const small = { url: "https://micro", dialPrefixes: [] as string[], cap: 25 };
  const capFor = (h: { cap?: number }) => h.cap;

  it("THE BACKWARDS CASE: more users but emptier wins", () => {
    // ARM holds 30/60 (50%); the micro holds 20/25 (80%). A raw headcount
    // hands the next traveller to the micro - the box that is nearly full and
    // the most fragile - and leaves the roomy one idle. Fullness does not.
    const chosen = placeHost({
      hosts: [big, small],
      counts: { "https://arm": 30, "https://micro": 20 },
      cap: 25,
      capFor,
      healthy: [big, small],
    });
    expect(chosen?.url).toBe("https://arm");
  });

  it("with equal caps the ordering is the old least-loaded one, term for term", () => {
    // The property that makes this safe to ship: dividing every term by one
    // constant cannot reorder them, so a fleet that has declared no per-host
    // caps sorts exactly as it did before.
    const a = { url: "https://a", dialPrefixes: [] as string[] };
    const b = { url: "https://b", dialPrefixes: [] as string[] };
    const chosen = placeHost({
      hosts: [a, b],
      counts: { "https://a": 10, "https://b": 3 },
      cap: 25,
      healthy: [a, b],
    });
    expect(chosen?.url).toBe("https://b");
  });
});

describe("the owner panel reports the capacity that is actually enforced", () => {
  it("occupancy sums the real caps instead of hosts x default", () => {
    const o = hostOccupancy(
      [
        { url: "https://arm", users: 10, cap: 60 },
        { url: "https://micro", users: 10, cap: 25 },
      ],
      25
    );
    expect(o.capacity).toBe(85); // not 2 x 25
    expect(o.state).toBe("ok");
    expect(o.detail).toMatch(/mixed caps/);
  });

  it("a host is hot against ITS OWN cap, not the fleet default", () => {
    // 30 users is past the 25 default but only half of this host's 60, so it is
    // not hot. Against the old uniform rule it would have alarmed.
    const o = hostOccupancy([{ url: "https://arm", users: 30, cap: 60 }], 25);
    expect(o.state).toBe("ok");
    // ...and the same host at 50/60 is.
    expect(hostOccupancy([{ url: "https://arm", users: 50, cap: 60 }], 25).state).toBe("alarm");
  });

  it("a uniform fleet still NAMES the number in its copy", () => {
    const o = hostOccupancy([{ url: "https://a", users: 40, cap: 40 }], 40);
    expect(o.detail).toMatch(/AT the 40-user cap/);
  });

  it("invite headroom takes the true capacity over the product", () => {
    // 5 lanes summing to 200, against a fleet default of 25 whose product would
    // have said 125 - the arithmetic that had the owner under-inviting.
    const h = inviteHeadroom(150, 5, 25, 200, 200);
    expect(h.capacity).toBe(200);
    expect(h.headroom).toBe(50);
    expect(h.state).toBe("ok");
    expect(h.detail).not.toMatch(/5 host\(s\) x 25/);
  });

  it("omitting the override keeps the original arithmetic exactly", () => {
    const h = inviteHeadroom(30, 4, 25, 200);
    expect(h.capacity).toBe(100);
    expect(h.detail).toMatch(/4 host\(s\) x 25 = 100/);
  });

  it("the 200-user target is reachable: the list ceiling no longer binds first", async () => {
    // Both ceilings have to clear 200 or the other one is decorative.
    const { BETA_ALLOWLIST_MAX } = await import("../allowlist");
    expect(BETA_ALLOWLIST_MAX).toBeGreaterThanOrEqual(200);
    const h = inviteHeadroom(200, 5, 25, BETA_ALLOWLIST_MAX, 200);
    expect(h.state).not.toBe("alarm");
    expect(h.headroom).toBe(0);
  });
});
