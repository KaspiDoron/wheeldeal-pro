import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  parseDialPrefixes,
  prefixMatchLength,
  affinityFor,
  rankHostsForNumber,
  mismatchCount,
  AFFINITY_MATCH,
  AFFINITY_NEUTRAL,
  AFFINITY_MISMATCH,
} from "./host-region";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// A THAI NUMBER TRANSMITTING FROM OREGON.
//
// 2026 research on unofficial WhatsApp stacks scores two network signals
// separately: datacenter IP ranges, and IP-vs-number GEO MISMATCH. The owner
// has ruled out a residential box, so the first is unavoidable at $0. The
// second was pure self-harm: `getHosts()` parsed a FLAT `url|key` list with no
// notion of region, so every tester's personal number - shopping in south-east
// Asia - transmitted from one Render box in `oregon`.
//
// Fixing it costs nothing. It is only a question of which box a user is placed
// on at link time.

const H = (url: string, prefixes: string) => ({ url, dialPrefixes: parseDialPrefixes(prefixes) });

describe("a host declares which numbers it is right for", () => {
  it("prefixes are digits, deduped, longest-first", () => {
    expect(parseDialPrefixes("66, 84 ;855  66")).toEqual(["855", "66", "84"]);
    // Longest-first is what makes matching unambiguous, so it is pinned.
    const p = parseDialPrefixes("1,1868,44");
    expect(p[0]).toBe("1868");
  });

  it("junk narrows a host's claim, it never removes the host", () => {
    expect(parseDialPrefixes("66, ???, 84")).toEqual(["66", "84"]);
    expect(parseDialPrefixes("")).toEqual([]);
    expect(parseDialPrefixes(undefined)).toEqual([]);
    expect(parseDialPrefixes(null)).toEqual([]);
  });

  it("the MOST SPECIFIC claim wins, so +1 and +1868 cannot tie", () => {
    const na = H("https://na", "1");
    const tt = H("https://tt", "1868");
    expect(prefixMatchLength(na, "18685551234")).toBe(1);
    expect(prefixMatchLength(tt, "18685551234")).toBe(4);
    const ranked = rankHostsForNumber([na, tt], "18685551234", () => 0);
    expect(ranked[0].url).toBe("https://tt");
  });

  it("a leading zero is not part of a calling code", () => {
    expect(prefixMatchLength(H("https://th", "66"), "066812345678")).toBe(2);
  });
});

describe("three tiers, and the third one is deliberate", () => {
  const sg = H("https://sg", "66,84,855,856");
  const eu = H("https://eu", "33,34,39,49");
  const any = H("https://any", "");

  it("matching beats neutral beats mismatched", () => {
    expect(affinityFor(sg, "66812345678")).toBe(AFFINITY_MATCH);
    expect(affinityFor(any, "66812345678")).toBe(AFFINITY_NEUTRAL);
    expect(affinityFor(eu, "66812345678")).toBe(AFFINITY_MISMATCH);
  });

  it("a mismatched host is still USABLE - no link at all is worse", () => {
    // Only the wrong-region box has room. It must be returned, not refused:
    // a scored signal beats a user who cannot use the product.
    const ranked = rankHostsForNumber([eu], "66812345678", () => 0);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].url).toBe("https://eu");
  });

  it("an unknown number makes every host neutral, so ranking is pure load", () => {
    const ranked = rankHostsForNumber([eu, sg, any], null, (h) =>
      h.url === "https://eu" ? 0 : h.url === "https://sg" ? 5 : 9
    );
    expect(ranked.map((h) => h.url)).toEqual(["https://eu", "https://sg", "https://any"]);
  });

  it("GEO FIRST, THEN LOAD - a busy right-region host beats an idle wrong one", () => {
    const load = (h: { url: string }) => (h.url === "https://sg" ? 24 : 0);
    const ranked = rankHostsForNumber([eu, any, sg], "66812345678", load);
    expect(ranked.map((h) => h.url)).toEqual(["https://sg", "https://any", "https://eu"]);
  });

  it("inside a tier, load still breaks the tie exactly as before", () => {
    const a = H("https://a", "66");
    const b = H("https://b", "66");
    const ranked = rankHostsForNumber([a, b], "66812345678", (h) =>
      h.url === "https://a" ? 30 : 2
    );
    expect(ranked[0].url).toBe("https://b");
  });

  it("A FLEET THAT NEVER OPTED IN IS UNCHANGED, term for term", () => {
    // Every existing EVOLUTION_HOSTS line has no third field, so every host is
    // neutral and the ranking degrades to load-then-tiebreak - which IS the
    // ordering resolveHost used before this existed.
    const hosts = [H("https://a", ""), H("https://b", ""), H("https://c", "")];
    const load: Record<string, number> = { "https://a": 7, "https://b": 1, "https://c": 4 };
    const tie: Record<string, number> = { "https://a": 0, "https://b": 0, "https://c": 0 };
    const ranked = rankHostsForNumber(hosts, "66812345678", (h) => load[h.url], (h) => tie[h.url]);
    expect(ranked.map((h) => h.url)).toEqual(["https://b", "https://c", "https://a"]);
  });

  it("ranking never drops a host - capacity is the caller's job alone", () => {
    const hosts = [sg, eu, any];
    expect(rankHostsForNumber(hosts, "66812345678", () => 0)).toHaveLength(3);
    // ...and it does not mutate the caller's array.
    expect(hosts.map((h) => h.url)).toEqual(["https://sg", "https://eu", "https://any"]);
  });

  it("mismatches are countable, so a green panel cannot hide them", () => {
    expect(
      mismatchCount([
        { host: sg, digits: "66812345678" },
        { host: eu, digits: "66812345678" },
        { host: any, digits: "66812345678" },
        { host: eu, digits: "33612345678" },
      ])
    ).toBe(1);
  });
});

describe("the fleet actually routes on it", () => {
  const evo = read("src/lib/evolution.ts");

  it("EVOLUTION_HOSTS parses the third field", () => {
    expect(evo).toMatch(/const \[url, key, regions\] = line\.split\("\|"\)/);
    expect(evo).toMatch(/dialPrefixes: parseDialPrefixes\(regions\)/);
    // The legacy single-host fallback stays region-neutral rather than absent.
    expect(evo).toMatch(/key: key\.trim\(\), dialPrefixes: \[\]/);
  });

  it("EXECUTED: placement ranks by region, and the cap still refuses first", async () => {
    // Was a regex over the refusal branch. The decision lives in
    // `wa/host-placement` now (owner report 10) so the ordering can be run
    // rather than described. Same claim: the cap is applied BEFORE the ranking,
    // and the ranking still carries load, so geo ADDS a term rather than
    // replacing the spreading.
    const { placeHost } = await import("./host-placement");
    const hosts = [
      { url: "https://us", dialPrefixes: [] as string[] },
      { url: "https://sg", dialPrefixes: ["66"] },
    ];
    // Cap first: the geo-correct host is full, so it is not a candidate at all.
    expect(
      placeHost({
        hosts,
        counts: { "https://us": 0, "https://sg": 25 },
        cap: 25,
        healthy: hosts,
        digits: "66812345678",
      })
    ).toEqual(hosts[0]);
    // Under the cap, geo wins over a lighter load.
    expect(
      placeHost({
        hosts,
        counts: { "https://us": 0, "https://sg": 24 },
        cap: 25,
        healthy: hosts,
        digits: "66812345678",
      })
    ).toEqual(hosts[1]);
  });

  it("EXECUTED: load still breaks ties among equally-matched hosts", async () => {
    const { placeHost } = await import("./host-placement");
    const hosts = [
      { url: "https://sg1", dialPrefixes: ["66"] },
      { url: "https://sg2", dialPrefixes: ["66"] },
    ];
    expect(
      placeHost({
        hosts,
        counts: { "https://sg1": 12, "https://sg2": 3 },
        cap: 25,
        healthy: hosts,
        digits: "66812345678",
      })
    ).toEqual(hosts[1]);
  });

  it("the resolver still hands placement the number and the pref tiebreak", () => {
    // The wiring, which is the one part a grep is the right tool for.
    expect(evo).toMatch(/digits,/);
    expect(evo).toMatch(/pref: \(h\) => hostPref\(email, h\.url\),/);
  });

  it("the number reaches placement from the one caller that has it", () => {
    expect(evo).toMatch(/async function resolveHost\(\s*email: string,\s*phoneHint\?: string \| null,/);
    // connectInstance is where a user is actually placed - and it is the ONE
    // caller allowed to receive a capacity refusal, so it is the one that
    // passes `forPlacement`. Every other caller is asking where the user
    // already is, and a null there would be a fleet-wide outage rather than a
    // cap (evo() alone fronts fifteen endpoints).
    const at = evo.indexOf("export async function connectInstance(");
    expect(at).toBeGreaterThan(-1);
    expect(evo.slice(at, at + 2400)).toMatch(
      /resolveHost\(email, phone, \{ forPlacement: true \}\)/
    );
    // ...and nowhere else asks for placement.
    expect(evo.match(/forPlacement: true/g)?.length).toBe(1);
    // ...and a placement with no hint still resolves the stored number rather
    // than silently ranking everything neutral.
    expect(evo).toMatch(/digitsOnly\(phoneHint \?\? ""\) \|\| \(await linkedNumberFor\(email\)\)/);
  });

  it("a wrong-region placement leaves a trail entry", () => {
    expect(evo).toMatch(/affinityFor\(chosen, digits\) === AFFINITY_MISMATCH/);
    expect(evo).toMatch(/kind: "host-geo-mismatch"/);
    const path = read("src/lib/wa/message-path.ts");
    // Registered, or the trail fetches everything except the one new kind.
    expect(path).toMatch(/"host-geo-mismatch": "transport"/);
  });

  it("the fleet lane keeps the SAME fingerprint as the Render half", () => {
    // Two spellings across the fleet is two dialects presented to Meta, which
    // is the opposite of what a shared fingerprint is for.
    const compose = read("deploy/fleet/docker-compose.yml");
    const dockerfile = read("deploy/evolution/Dockerfile");
    const render = read("render.yaml");
    // Three files, three syntaxes: compose `KEY: "value"`, Dockerfile
    // `ENV KEY="value"`, and render.yaml's two-line `- key:` / `value:` pair.
    // The invariant is the VALUE, so the matcher spans the gap.
    for (const src of [compose, dockerfile, render]) {
      expect(src).toMatch(/CONFIG_SESSION_PHONE_CLIENT[\s\S]{0,24}Mac OS/);
      expect(src).toMatch(/CONFIG_SESSION_PHONE_NAME[\s\S]{0,24}Chrome/);
    }
    // The product name must never be the device label - it would cluster every
    // user in the fleet under one string.
    expect(compose).not.toMatch(/CONFIG_SESSION_PHONE_(?:CLIENT|NAME): "?WheelDeal/i);
    // ...and the same pinned Evolution version, or the fleet runs two engines.
    expect(compose).toMatch(/evoapicloud\/evolution-api:v2\.3\.7/);
    expect(dockerfile).toMatch(/evoapicloud\/evolution-api:v2\.3\.7/);
  });

  it("a fleet lane never publishes its database or its cache", () => {
    const compose = read("deploy/fleet/docker-compose.yml");
    // Only the Evolution port is mapped, and only to loopback - the public edge
    // is the tunnel in front of it.
    expect(compose).toMatch(/"127\.0\.0\.1:8080:8080"/);
    expect(compose).not.toMatch(/^\s+- "\d+:5432"/m);
    expect(compose).not.toMatch(/^\s+- "\d+:6379"/m);
    // Secrets come from a gitignored .env, never from the file.
    expect(compose).toMatch(/\$\{AUTHENTICATION_API_KEY:\?/);
    expect(compose).toMatch(/\$\{POSTGRES_PASSWORD:\?/);
  });

  it("every lane prunes from day one, at 7 days", () => {
    // The disk filling is the documented Evolution crash class, and it drops
    // every linked socket on that host at once.
    const compose = read("deploy/fleet/docker-compose.yml");
    expect(compose).toMatch(/interval '7 days'/);
    expect(compose).toMatch(/DATABASE_SAVE_DATA_MESSAGE_UPDATE: "false"/);
    // A renamed table degrades to a logged no-op, never a crash-looping lane.
    expect(compose).toMatch(/not fatal/);
  });

  it("the note can never break the placement it is describing", () => {
    const at = evo.indexOf("async function noteHostGeoMismatch(");
    expect(at).toBeGreaterThan(-1);
    const body = evo.slice(at, at + 1200);
    expect(body).toMatch(/try \{/);
    expect(body).toMatch(/\} catch \{/);
    expect(evo).toMatch(/void noteHostGeoMismatch\(/);
  });
});
