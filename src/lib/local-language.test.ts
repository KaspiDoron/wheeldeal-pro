import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { countryForShop, regionForShop } from "./copy/region";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// OWNER REPORT 4, ITEM 8: "bargain in local language" must work END TO END -
// and it only worked in four countries. regionForShop (a SE-Asia greeting
// flavor lookup) was the only thing feeding the language decision, so a +52
// Mexico shop got fluent English with an event blaming "AI localization
// unavailable" - the AI was never asked.

const chatMock = vi.hoisted(() => ({ fn: vi.fn(async (): Promise<string | null> => null) }));
vi.mock("server-only", () => ({}));
vi.mock("./ai", () => ({
  chat: (...args: unknown[]) => chatMock.fn(...(args as [])),
  extractJson: <T,>(s: string): T | null => {
    try {
      return JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1)) as T;
    } catch {
      return null;
    }
  },
}));
vi.mock("./runtime-config", () => ({
  sbSelect: vi.fn(async () => []),
  sbInsert: vi.fn(async () => true),
  sbUpdate: vi.fn(async () => true),
  sbDelete: vi.fn(async () => true),
  getConfig: vi.fn(async () => undefined),
  getConfigExact: vi.fn(async () => undefined),
  setConfig: vi.fn(async () => ({ ok: true, persistent: true })),
}));

import { localizeMessage, composeBargain, looksEnglish, translateToEnglish } from "./agents";
import { nextThreadLanguage, threadWritesEnglish } from "./wa/thread-language";

beforeEach(() => {
  chatMock.fn.mockReset();
  chatMock.fn.mockResolvedValue(null);
});

describe("countryForShop - the language decision covers the whole map", () => {
  it("resolves far beyond the four SE-Asia flavor markets", () => {
    expect(countryForShop("5215512345678")).toBe("Mexico");
    expect(countryForShop("66812345678")).toBe("Thailand");
    expect(countryForShop("33612345678")).toBe("France");
    expect(countryForShop("905301234567")).toBe("Turkey");
    expect(countryForShop("818012345678")).toBe("Japan");
    expect(countryForShop("5491112345678")).toBe("Argentina");
  });

  it("English-speaking countries resolve too - localizeMessage declines them itself", () => {
    expect(countryForShop("14155551234")).toBe("United States");
    expect(countryForShop("447911123456")).toBe("United Kingdom");
    expect(countryForShop("6591234567")).toBe("Singapore");
  });

  it("longest prefix wins and leading zeros/punctuation are stripped", () => {
    expect(countryForShop("+972-50-1234567")).toBe("Israel"); // 972, never 9
    expect(countryForShop("0066812345678")).toBe("Thailand");
    expect(countryForShop("8551234567")).toBe("Cambodia"); // 855, never 85
  });

  it("falls back to the label, then to undefined - never a guess", () => {
    expect(countryForShop("999123", "Tulum, Mexico")).toBe("Tulum, Mexico");
    expect(countryForShop("", "")).toBeUndefined();
  });

  it("regionForShop keeps its narrow flavor role untouched", () => {
    expect(regionForShop("66812345678")).toBe("thailand");
    expect(regionForShop("5215512345678")).toBeUndefined(); // flavor only - by design
  });
});

describe("localizeMessage - honest reasons, executed (Mexico + Thailand)", () => {
  it("MEXICO: a Spanish rewrite with preserved numbers goes through", async () => {
    chatMock.fn.mockResolvedValue(
      JSON.stringify({
        message: "Hola! Me puedes hacer 300 al día por los 5 días?",
        english: "Hi! Can you do 300 a day for the 5 days?",
      })
    );
    const out = await localizeMessage("Can you do 300 a day for the 5 days?", "Mexico");
    expect(out.localized).toBe(true);
    expect(out.text).toContain("300");
    expect(out.english).toContain("300");
  });

  it("THAILAND: same path, and the region string reaches the prompt", async () => {
    chatMock.fn.mockResolvedValue(
      JSON.stringify({ message: "ลดเหลือ 250 ได้ไหมครับ", english: "can you do 250?" })
    );
    const out = await localizeMessage("Could you do 250 a day?", "Ko Tao, Thailand");
    expect(out.localized).toBe(true);
    expect(JSON.stringify(chatMock.fn.mock.calls[0])).toContain("Ko Tao, Thailand");
  });

  it("a drifted number is refused twice and named as the reason", async () => {
    chatMock.fn.mockResolvedValue(
      JSON.stringify({ message: "puedo pagar 350 al día señor amigo", english: "350 a day" })
    );
    const out = await localizeMessage("Can you do 300 a day?", "Mexico");
    expect(out.localized).toBe(false);
    expect(out.reason).toBe("numbers-drifted");
    expect(out.text).toContain("300"); // the English fallback quotes the RIGHT number
  });

  it("an unreachable AI is 'ai-unavailable' - a missing region is NOT", async () => {
    expect((await localizeMessage("Can you do 300?", "Mexico")).reason).toBe("ai-unavailable");
    const noRegion = await localizeMessage("Can you do 300?", undefined);
    expect(noRegion.reason).toBe("no-region");
    const english = await localizeMessage("Can you do 300?", "Singapore");
    expect(english.reason).toBe("english-region");
    // Neither decline ever spent an LLM call.
    expect(chatMock.fn).toHaveBeenCalledTimes(2); // only the Mexico attempts
  });
});

describe("the language doctrine: stay local unless the shop ASKS", () => {
  // W4.6 REWRITE OF FOUR DOCTRINE PINS. The four cases that used to live here
  // asserted the OLD doctrine - that a shop DEMONSTRATING English flips the
  // thread ("two consecutive English inbounds DO flip", "a thread OPENED in
  // English adapts at once"). The owner inverted it in report 5 item 15: "if
  // they answer in English we need to write them in local language - we are not
  // speaking English only the local. If the shop writes us in English that they
  // are not speaking the local language ... we should move to English also."
  //
  // The INTENT of the originals is preserved exactly, and it was never "English
  // wins": it was (a) the agent must never ALTERNATE languages inside one
  // thread, and (b) both engines must consume ONE shared decision rather than
  // each computing its own. Both are asserted below, against the decision that
  // now exists instead of the per-turn re-derivation that did not.

  it("looksEnglish requires English, not merely Latin script", () => {
    expect(looksEnglish("Hi Doron, do you speak English?")).toBe(true);
    expect(looksEnglish("We have Honda Click, best price today")).toBe(true);
    // Indonesian/Tagalog are 100% ASCII - they must NOT read as English.
    expect(looksEnglish("bisa 150rb per hari bos")).toBe(false);
    expect(looksEnglish("meron po kami maganda motor")).toBe(false);
    expect(looksEnglish("สวัสดีครับ มีรถว่างครับ")).toBe(false);
  });

  // WAS: "one English line in a local thread does not flip the reply".
  // Same guarantee, stronger: no amount of English REPLYING flips anything,
  // because replying is not a statement about language.
  it("a shop that merely REPLIES in English does not flip the thread", () => {
    const out = nextThreadLanguage({
      persisted: null,
      statement: null, // the comprehension pass found no language STATEMENT
      localRequested: true,
      now: 1_000,
    });
    expect(out.changed).toBe(false);
    expect(out.language.mode).toBe("local");
    expect(threadWritesEnglish(out.language)).toBe(false);
  });

  // WAS: "two consecutive English inbounds DO flip - the shop demonstrated it".
  // That is precisely the behaviour the owner asked us to remove; the flip it
  // was protecting now needs the shop to SAY it.
  it("an explicit statement DOES flip it, and says why", () => {
    const out = nextThreadLanguage({
      persisted: null,
      statement: { prefers: "english", quote: "sorry i am not thai, english please", confidence: 0.9 },
      localRequested: true,
      now: 2_000,
    });
    expect(out.changed).toBe(true);
    expect(out.language.mode).toBe("english");
    expect(out.language.reason).toBe("shop-asked");
    expect(out.language.quote).toContain("english please");
  });

  // WAS: "a thread OPENED in English adapts at once" - the worst case of the
  // old predicate, which treated "no previous message" as agreement, so the
  // FIRST reply from any shop that types a line of English ended the feature.
  it("a thread opened in English stays LOCAL until the shop asks", () => {
    const out = nextThreadLanguage({
      persisted: null,
      statement: null,
      localRequested: true,
      now: 3_000,
    });
    expect(out.language.mode).toBe("local");
  });

  it("a low-confidence read is not a statement, and a tick is not a message", () => {
    const unsure = nextThreadLanguage({
      persisted: null,
      statement: { prefers: "english", confidence: 0.5 },
      localRequested: true,
      now: 4_000,
    });
    expect(unsure.changed).toBe(false);
    // The tick guard, which the graph engine had and the legacy loop did not.
    const tick = nextThreadLanguage({
      persisted: null,
      statement: { prefers: "english", confidence: 0.99 },
      isTick: true,
      localRequested: true,
      now: 5_000,
    });
    expect(tick.changed).toBe(false);
    expect(tick.language.mode).toBe("local");
  });

  it("an AI outage NEVER flips a thread - it keeps the decision it had", () => {
    const persisted = { mode: "english" as const, reason: "shop-asked" as const, at: "2026-01-01T00:00:00.000Z" };
    // Degraded comprehension reports no statement at all.
    const out = nextThreadLanguage({ persisted, statement: null, localRequested: true, now: 6_000 });
    expect(out.changed).toBe(false);
    expect(out.language).toEqual(persisted); // not re-derived back to local
  });

  it("the shop can ask for the local language back", () => {
    const persisted = { mode: "english" as const, reason: "shop-asked" as const, at: "2026-01-01T00:00:00.000Z" };
    const out = nextThreadLanguage({
      persisted,
      statement: { prefers: "local", quote: "เขียนไทยได้นะ", confidence: 0.85 },
      localRequested: true,
      now: 7_000,
    });
    expect(out.changed).toBe(true);
    expect(out.language.mode).toBe("local");
    expect(out.language.reason).toBe("shop-asked-local");
  });

  // WAS: "the engines consume the thread-level test, not the per-turn one",
  // pinned as two source assertions on the exact `threadPrefersEnglish(...)`
  // call expressions. SAME INTENT - one decision, consumed by both engines -
  // against the module that now holds it. The per-turn predicate is gone, and
  // its absence is asserted so it cannot creep back.
  it("both engines READ one stored decision instead of re-deriving one", () => {
    const engine = readCode("src/lib/graph/engine.ts");
    const live = readCode("src/lib/spte/live.ts");
    const agents = readCode("src/lib/agents.ts");
    expect(engine).toMatch(/threadWritesEnglish\(args\.threadLanguage\)/);
    expect(engine).toMatch(/threadLanguage: threadLanguageFromStored\(state\.fields\.language\)/);
    // The legacy loop's read died with the legacy orchestrator; SPTE is the
    // other reader now, off the same stored decision.
    expect(live).toMatch(/threadLanguageFromStored\(priorState\?\.fields\?\.language\)/);
    expect(live).toMatch(/threadWritesEnglish\(/);
    // The demonstration predicate no longer exists anywhere.
    expect(agents).not.toMatch(/export function threadPrefersEnglish/);
    expect(engine).not.toMatch(/threadPrefersEnglish\(/);
    expect(live).not.toMatch(/threadPrefersEnglish\(/);
  });

  it("the SWITCH is stored on the thread, not recomputed per turn", () => {
    // Written by the engine that actually runs...
    expect(readCode("src/lib/spte/live.ts")).toMatch(/fields\.language = language/);
    // ...and read by the surface the traveller sees.
    expect(readCode("src/app/api/replies/route.ts")).toMatch(/languageSwitchNotice\(st\?\.language\)/);
  });
});

describe("the gloss dead band is closed", () => {
  it("mixed text below the Latin bar is glossed now (was the 0.7-0.9 hole)", async () => {
    chatMock.fn.mockResolvedValue("ok 200 for tomorrow");
    // ~0.76 ASCII letters: not English enough to adapt, foreign enough to gloss.
    const out = await translateToEnglish("ok 200 for tomorrow ครับผม");
    expect(out).toBe("ok 200 for tomorrow");
    expect(chatMock.fn).toHaveBeenCalledTimes(1);
  });

  it("Latin-dominant text still skips the gloss without an LLM call", async () => {
    expect(await translateToEnglish("hello my friend how are you")).toBeNull();
    expect(chatMock.fn).not.toHaveBeenCalled();
  });

  it("EXECUTED: the gloss gate is 'not English', not 'not Latin script'", async () => {
    // W12g: THE DEAD BAND HAD ONLY MOVED. Gating the gloss on Latin-dominance
    // meant Indonesian, Malay, unaccented Vietnamese, Filipino and Spanish -
    // all ~100% ASCII - were never translated at all. That is not cosmetic:
    // every deterministic detector downstream (classifyActs, shopAskedQuestion,
    // shopAskedLocation, shopAskedLicense) is English-only regex reading
    // `gloss ?? raw`, so with no gloss they ALL returned false. An Indonesian
    // shop asking "how many days, can I deliver to your hotel?" produced
    // askedQuestion=false - so `answer` was not even a legal move and the agent
    // asked for a price again.
    const { looksEnglish } = await import("./agents");
    // These are the messages the audit executed. None of them is English.
    for (const t of [
      "Mau sewa berapa hari? Bisa antar ke hotel bos",
      "Kamu nginap dimana? kirim lokasi ya",
      "Ban xe may gia bao nhieu mot ngay",
      "Cuantos dias quiere alquilar la moto",
      "Nak sewa berapa hari bang?",
    ]) {
      expect(looksEnglish(t), t).toBe(false);
    }
    // ...and real English still needs no gloss.
    for (const t of [
      "How many days do you want the scooter for?",
      "Yes we have it available, the price is 250 per day",
    ]) {
      expect(looksEnglish(t), t).toBe(true);
    }
  });

  it("the gloss gate reads looksEnglish, not a script ratio", () => {
    const agents = readCode("src/lib/agents.ts");
    expect(agents).toMatch(/export const LATIN_DOMINANT = 0\.9/);
    // looksEnglish still uses the ratio as ONE of its terms (another script
    // dominating is a fast no); the gloss no longer uses it alone.
    expect(agents).toMatch(/ascii\.length \/ letters\.length < LATIN_DOMINANT/);
    expect(agents).toMatch(/if \(looksEnglish\(t\)\) return null;/);
    expect(agents).not.toMatch(/ascii\.length \/ letters\.length >= LATIN_DOMINANT/);
  });
});

describe("composeBargain never flips a local thread to English silently", () => {
  const baseOpts = {
    rfq: { vehicleClass: "scooter", durationDays: 5 } as never,
    vendor: { name: "Ko Tao Bikes" } as never,
    currentPricePerDay: 400,
    targetPricePerDay: 300,
    round: 0,
    currency: "THB",
  };

  it("AI down + localizer down on a Thai thread -> flagged, so AUTO suppresses", async () => {
    const draft = await composeBargain({ ...baseOpts, localLanguage: true, region: "Thailand" });
    expect(draft.fallback).toBe(true);
    expect(draft.localizeFailed).toBe(true);
    expect(draft.message.length).toBeGreaterThan(10); // interactive callers still get a draft
  });

  it("an English-speaking region keeps the plain English fallback, unflagged", async () => {
    const draft = await composeBargain({ ...baseOpts, localLanguage: true, region: "Singapore" });
    expect(draft.fallback).toBe(true);
    expect(draft.localizeFailed).toBeUndefined();
  });

  it("the AUTO callers actually suppress on the flag", () => {
    // agent-loop's auto-bargain caller died with the legacy orchestrator; the
    // graph engine's node path is the surviving composeBargain AUTO caller,
    // and SPTE localizes through its own doctrine (localizeSpteOutbound).
    const nodes = readCode("src/lib/graph/nodes.ts");
    expect(nodes).toMatch(/if \(draft\.localizeFailed\)/);
    expect(nodes).toMatch(/countryForShop\(input\.event\.toDigits\)/);
  });
});

describe("honest events on every path", () => {
  it("the reply paths emit localize-fallback with the true reason", () => {
    expect(readCode("src/lib/graph/engine.ts")).toMatch(/path: "engine-reply"/);
    // The legacy-reply writer died with the legacy orchestrator - and so must
    // its path label, or a dashboard filter would wait for it forever.
    expect(readCode("src/lib/agent-loop.ts")).not.toMatch(/path: "legacy-reply"/);
  });

  it("the false hardcoded AI blame is gone from the outreach routes", () => {
    const one = readCode("src/app/api/outreach/route.ts");
    const mass = readCode("src/app/api/outreach/mass/route.ts");
    expect(one).not.toMatch(/AI localization unavailable after retry/);
    expect(mass).not.toMatch(/AI localization unavailable after retry/);
    expect(one).toMatch(/reason: localized\.reason \?\? "ai-unavailable"/);
    expect(mass).toMatch(/reason: localized\.reason \?\? "ai-unavailable"/);
    // ...and both opener paths ask the full country map for the language.
    expect(one).toMatch(/countryForShop\(digits/);
    expect(mass).toMatch(/countryForShop\(shopDigits/);
  });

  it("a deterministic repair on localized text re-glosses instead of blinding", () => {
    const engine = readCode("src/lib/graph/engine.ts");
    expect(engine).toMatch(/let glossInvalidated = false/);
    const sets = engine.match(/glossInvalidated = true/g) ?? [];
    expect(sets.length).toBe(4); // duration, commitment, hard-constraint, numeric
    expect(engine).toMatch(/finishBeforeResponse\("outbound-regloss"/);
    expect(engine).toMatch(/translateToEnglish\(finalText\)/);
  });
});
