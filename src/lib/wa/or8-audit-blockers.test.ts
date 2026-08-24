import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { splitHostLines } from "../evolution";
import { parseDialPrefixes, affinityFor, AFFINITY_MATCH } from "./host-region";
import { normalizeDigits } from "../integrity/translation";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// THE POST-SHIP AUDIT.
//
// Owner report 8 shipped in eight merges, each falsified by revert IN ISOLATION.
// An adversarial sweep over the whole diff found four blockers, and all four are
// the same shape: a fix that is correct in the function that was edited and
// ABSENT at the call site that matters. These tests pin the call sites.

describe("F1.1 the host line survives its own parser", () => {
  // The parser split the WHOLE blob on /[\n,]+/ before splitting a line on `|`,
  // so the third field - added by wave C for geo placement - kept only its first
  // prefix and the rest became keyless fragments that were silently dropped.
  // Wave C was therefore inert for the exact line every one of its own docs
  // tells the owner to paste, while the fleet looked correctly configured.

  it("a multi-prefix host is ONE host that keeps every prefix", () => {
    const lines = splitHostLines("https://sg.example.com|K1|66,84,855,856,60,65");
    expect(lines).toHaveLength(1);
    const [url, key, regions] = lines[0].split("|");
    expect(url).toBe("https://sg.example.com");
    expect(key).toBe("K1");
    expect(parseDialPrefixes(regions)).toHaveLength(6);
  });

  it("THE REGRESSION: the docs' own example routes a Vietnamese number correctly", () => {
    // deploy/fleet/README.md, ANTI-BAN.md, SCALING.md and host-region.ts all
    // show this shape. Before the fix the SG host claimed only "66", so +84
    // ranked as a MISMATCH against the host built for it.
    const blob = [
      "https://sg.example.com|K1|66,84,855,856,60,65",
      "https://eu.example.com|K2|33,34,39,49,44",
    ].join("\n");
    const hosts = splitHostLines(blob).map((l) => {
      const [url, key, regions] = l.split("|").map((x) => x?.trim());
      return { url, key, dialPrefixes: parseDialPrefixes(regions) };
    });
    expect(hosts).toHaveLength(2);
    expect(affinityFor(hosts[0], "84912345678")).toBe(AFFINITY_MATCH);
    expect(affinityFor(hosts[0], "66812345678")).toBe(AFFINITY_MATCH);
  });

  it("the legacy comma-separated form still parses as several hosts", () => {
    // Every fragment carries its own `|`, which is what makes it legacy.
    expect(splitHostLines("https://a|K1,https://b|K2")).toEqual([
      "https://a|K1",
      "https://b|K2",
    ]);
    expect(splitHostLines("https://a|K1|66,https://b|K2|84")).toHaveLength(2);
  });

  it("blank lines and stray whitespace are ignored, not turned into hosts", () => {
    expect(splitHostLines("\n  https://a|K1  \n\n")).toEqual(["https://a|K1"]);
    expect(splitHostLines("")).toEqual([]);
  });

  it("getHosts routes through the shared splitter, not its own regex", () => {
    const evo = readCode("src/lib/evolution.ts");
    expect(evo).toMatch(/splitHostLines\(multi\)/);
    expect(evo).not.toMatch(/multi\s*\n?\s*\.split\(\/\[\\n,\]\+\/\)/);
  });
});

describe("F1.2 the dead-link refusal sits where every caller passes", () => {
  const evo = readCode("src/lib/evolution.ts");

  it("ensureConnected itself refuses a severed link", () => {
    const at = evo.indexOf("export async function ensureConnected");
    expect(at).toBeGreaterThan(-1);
    const head = evo.slice(at, at + 900);
    expect(head).toMatch(/storedStatus\(email\)\) === "close"/);
    // ...and refuses BEFORE it can touch the transport.
    const refuse = head.indexOf('=== "close"');
    const create = head.indexOf("resolveHost");
    expect(refuse).toBeGreaterThan(-1);
    expect(refuse).toBeLessThan(create);
  });

  it("it fails OPEN - only the literal 'close' refuses", () => {
    // storedStatus returns "unknown" when the read is unavailable and null when
    // there is no row. A Supabase blip must never block a healthy re-pair.
    const at = evo.indexOf("async function storedStatus");
    const fn = evo.slice(at, at + 700);
    expect(fn).toMatch(/res\.error === "unavailable" \? "unknown" : null/);
  });

  it("our own refusal is not counted as a WhatsApp failure", () => {
    // Feeding the 3-hard-fails stop-loss with our own caution would pause the
    // number for a restriction it had already detected.
    const at = evo.indexOf("const conn = await ensureConnected(email, 6000)");
    expect(at).toBeGreaterThan(-1);
    expect(evo.slice(at, at + 2400)).toMatch(/conn\.state !== "close"/);
  });

  it("the three bypassing callers now inherit it by construction", () => {
    // They call ensureConnected bare, which is exactly why the refusal belongs
    // inside it rather than being repeated at each site.
    for (const f of [
      "src/app/api/outreach/mass/route.ts",
      "src/app/api/admin/training/import/route.ts",
    ]) {
      expect(readCode(f)).toMatch(/ensureConnected\(session\.email/);
    }
    expect(evo).toMatch(/const conn = await ensureConnected\(email, 6000\)/);
  });
});

describe("F1.3 the cap refuses applicants, not occupants", () => {
  // Was three regexes over evolution.ts. The decision moved into
  // `wa/host-placement` (owner report 10) precisely because the shape of a
  // branch is not something a regex can evaluate - this exact defect shipped
  // past a green suite. Same three claims, executed.
  const H = (url: string) => ({ url, dialPrefixes: [] as string[] });

  it("EXECUTED: a stored user gets their own host back instead of null", async () => {
    const { placeHost } = await import("./host-placement");
    const hosts = [H("https://a"), H("https://b")];
    expect(
      placeHost({
        hosts,
        stored: "https://b",
        counts: { "https://a": 25, "https://b": 25 },
        cap: 25,
        healthy: [hosts[0]],
      })
    ).toEqual(hosts[1]);
  });

  it("EXECUTED: a genuinely new user is still refused - the cap still caps", async () => {
    const { placeHost } = await import("./host-placement");
    const hosts = [H("https://a"), H("https://b")];
    expect(
      placeHost({ hosts, counts: { "https://a": 25, "https://b": 25 }, cap: 25, healthy: hosts })
    ).toBeNull();
  });

  it("EXECUTED: the single-host branch keeps its own exemption", async () => {
    const { placeHost } = await import("./host-placement");
    const only = [H("https://a")];
    expect(
      placeHost({ hosts: only, stored: "https://a", counts: { "https://a": 40 }, cap: 25 })
    ).toEqual(only[0]);
    expect(placeHost({ hosts: only, counts: { "https://a": 40 }, cap: 25 })).toBeNull();
  });
});

describe("F1.4 a rejected move falls back to the SAME move", () => {
  const orch = readCode("src/lib/spte/orchestrator.ts");

  it("the rejected move is composed deterministically before the ladder", () => {
    // fallbackArtifact takes legalMoves[0], so a bargain rejected by
    // cite-the-rival became an `answer` that cites no rival - dropping the
    // leverage at the exact moment the rail fired to enforce it.
    expect(orch).toMatch(/const sameMove = templateFor\(ctx, artifact\.move\);/);
    expect(orch).toMatch(/move: artifact\.move,/);
    expect(orch).toMatch(/: fallbackArtifact\(ctx\);/);
  });

  it("a double rejection says SILENT rather than acting with no text", () => {
    // finalize renders `text: move === "silent" ? undefined : finalText`, so a
    // non-silent move whose text was rejected claims to have spoken and carries
    // nothing to send.
    expect(orch).toMatch(/out = \{ \.\.\.out, move: "silent", message: undefined \};/);
    // ...and the ladder gets one more chance first.
    expect(orch).toMatch(/const ladder = fallbackArtifact\(ctx\);/);
  });

  it("the bargain template it now reaches does cite the rival", () => {
    const pass = read("src/lib/spte/pass.ts");
    expect(pass).toMatch(/Another shop offered \$\{money\(rival\.pricePerDay\)\}\/day/);
  });

  it("leverageUsed is derived from the text, not hard-coded to []", () => {
    const pass = readCode("src/lib/spte/pass.ts");
    expect(pass).toMatch(/export function fallbackLeverage\(/);
    expect(pass).toMatch(/leverageUsed: fallbackLeverage\(ctx, move, message\)/);
    expect(pass).not.toMatch(/leverageUsed: \[\],\s*\n\s*digestPatch: \[\],\s*\n\s*\};\s*\n\}/);
  });
});

describe("F3 the dials mean what they say", () => {
  const guard = readCode("src/lib/wa-guard.ts");

  it("F3.1 an owner-clamped day_cap is not raised back up by the warm-up floor", () => {
    // Applying WARMUP_DAY_FLOOR to the whole ceiling meant Math.max(40, ...):
    // an owner following the WA-security panel's own advice and setting
    // day_cap = 30 got 40. Since the ramped default (220) never approaches the
    // floor, neutralising the owner's clamp was the floor's ONLY observable
    // effect. Reproduce the expression both ways at day 0 (warmDay = 0.5).
    const jitter = 1;
    const warmDay = 0.5;
    const FLOOR = 40;
    const oldWay = (cap: number) => Math.max(FLOOR, Math.round(cap * jitter * warmDay));
    const newWay = (cap: number) => {
      const rampFloor = cap > 0 ? Math.min(1, FLOOR / cap) : 1;
      return Math.max(1, Math.round(cap * jitter * Math.max(warmDay, rampFloor)));
    };
    // The owner clamps to 30 during an incident.
    expect(oldWay(30)).toBe(40); // ...and got MORE than they asked for
    expect(newWay(30)).toBe(30); // ...now they get what they set
    // A hard clamp to 10 was worst of all: 4x what was typed.
    expect(oldWay(10)).toBe(40);
    expect(newWay(10)).toBe(10);
    // ...and the floor still does its real job on the DEFAULT ceiling: a day-0
    // number keeps enough room to answer a full day of real conversation.
    expect(newWay(220)).toBeGreaterThanOrEqual(FLOOR);
    // ...while still being genuinely ramped down from the warm ceiling.
    expect(newWay(220)).toBeLessThan(220);
    // ANCHORED TO THE SOURCE, or the two helpers above are just arithmetic that
    // agrees with itself no matter what the guard does - the exact way a test
    // can pass while the code it names is wrong.
    expect(guard).toMatch(/const rampFloor = p\.day_cap > 0 \? Math\.min\(1, WARMUP_DAY_FLOOR \/ p\.day_cap\) : 1;/);
    expect(guard).toMatch(/Math\.max\(1, Math\.round\(p\.day_cap \* jitter \* Math\.max\(warmDay, rampFloor\)\)\)/);
    expect(guard).not.toMatch(/Math\.max\(\s*WARMUP_DAY_FLOOR,\s*Math\.round\(p\.day_cap/);
  });

  it("F3.2 the slow ceilings hold for hours, not for the 1h fallback", () => {
    // boundHold only CAPS a hold, and newContactBudget re-anchors nextFreeAt
    // for the `unanswered` bind alone - so monthly and daily fell through to
    // its now+1h fallback and kept re-parking hourly, ~24 full guard passes a
    // day per row, against a state that does not move for weeks.
    expect(guard).toMatch(/budget\.bind === "monthly" \|\| budget\.bind === "daily"/);
    expect(guard).toMatch(/Date\.parse\(slowFloor\) > Date\.parse\(budget\.nextFreeAt\) \? slowFloor : budget\.nextFreeAt/);
    // The window bind keeps its own anchor - it genuinely does refresh soon.
    expect(guard).toMatch(/const holdHours = budget\.bind === "window" \|\| !budget\.bind \? windowHours : 12;/);
  });
});

describe("F4 the findings the audit fleet died before reviewing", () => {
  it("the leverage KPI can read Thai numerals - the markets it is SOLD for", () => {
    // integrity/translation.ts folds Thai, Lao, Khmer, Myanmar and six other
    // digit scripts precisely because a translator is free to render a price in
    // local script, and the number-integrity rail depends on that. citedRival
    // and the cite-the-rival rail both matched a bare ASCII \d over the
    // LOCALIZED wire text, so on every Ultra local-language send the owner's
    // headline leverage KPI read false - zero exactly where the feature works -
    // and the rail would reject a draft that cited the rival perfectly well.
    const live = readCode("src/lib/spte/live.ts");
    const rails = readCode("src/lib/spte/rails.ts");
    const pass = readCode("src/lib/spte/pass.ts");
    expect(live).toMatch(/normalizeDigits\(send\)\.match/);
    expect(rails).toMatch(/normalizeDigits\(text\)\.match/);
    expect(pass).toMatch(/normalizeDigits\(message\)\.match/);
    for (const src of [live, rails, pass]) {
      expect(src).toMatch(/from "\.\.\/integrity\/translation"/);
    }
  });

  it("Thai numerals really do fold to the digits these matchers need", () => {
    // Non-vacuous: prove the helper does what the three call sites assume,
    // rather than only asserting that they call it.
    expect(normalizeDigits("๒๐๐")).toBe("200");
    expect(normalizeDigits("ราคา ๑๘๐ บาท")).toContain("180");
    expect(normalizeDigits("200")).toBe("200");
  });

  it("a fractional trust score cannot abort the atomic counter update", () => {
    // `'22.5'::int` does not truncate in Postgres - it raises and aborts the
    // WHOLE update, taking every counter in the same call with it and silently
    // dropping the app back to the racy path M3 replaced. Reachable because
    // policy-values validates the trust gains as `number`, not integer.
    const sql = read("supabase/schema.sql");
    expect(sql).toMatch(/round\(\(p_set->>'trust_score'\)::numeric\)::int/);
    expect(sql).toMatch(/round\(\(p_set->>'risk_score'\)::numeric\)::int/);
    expect(sql).not.toMatch(/\(p_set->>'trust_score'\)::int\b/);
    // ...and the owner really can type a fraction.
    const pv = readCode("src/lib/wa/policy-values.ts");
    expect(pv).toMatch(/trust_reply_gain: \{ kind: "number"/);
  });

  it("M3 left no dead reads on the highest-frequency events", () => {
    // Each removed `const rep = await getReputation(senderKey)` was a Supabase
    // SELECT plus a lazy INSERT on a miss, on every read receipt, delivery
    // receipt and send failure - the three most frequent events in the system -
    // for a value nothing referenced once the counters became deltas.
    const guard = readCode("src/lib/wa-guard.ts");
    const reads = guard.match(/const rep = await getReputation\(senderKey\);/g) ?? [];
    // FOUR remain and all four are live - each one feeds arithmetic on the very
    // next lines: the two trust_score clamps, the legacy day-counter degrade in
    // newContactBudget, and dynamicHourCap in effectiveHourlyCap. The three
    // removed ones referenced nothing at all once the counters became deltas.
    expect(reads.length).toBe(4);
    for (const marker of [
      "trust_score: Math.min(100, rep.trust_score + p.trust_reply_gain)",
      "trust_score: Math.max(0, rep.trust_score - p.trust_send_decay)",
      "rep.new_contacts_date === today",
      "dynamicHourCap(rep, p, resolvedPlan)",
    ]) {
      expect(guard).toContain(marker);
    }
  });
});
