import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// W4.6 - THE PRIMARY ENGINE FINALLY SPEAKS THE LOCAL LANGUAGE.
//
// `localizeMessage` was imported nowhere under src/lib/spte. SPTE is the engine
// that ACTUALLY runs - `engineV3Enabled` returns true even when config is
// unreadable, and engine-route.ts demoted the graph engine to failover - so
// every message the live path sent went out in English and the Ultra
// local-language feature ran only on the two engines that almost never answer a
// shop. That is not a feature that was switched off; it is one that was never
// wired to the thing that describes it.
//
// The other half of the same owner item (report 5, #15) is the DOCTRINE: stay
// local, and switch to English only when the shop SAYS they do not speak the
// local language. Those cases live in src/lib/local-language.test.ts (the four
// rewritten doctrine pins); this file is the wiring, executed.

vi.mock("server-only", () => ({}));
vi.mock("../ai", () => ({
  chat: async () => null,
  chatDetailed: async () => ({ text: null }),
  extractJson: () => null,
}));

const localizeCalls: Array<{
  text: string;
  region?: string;
  street?: boolean;
  opts?: { greet?: boolean };
}> = [];
const localizeResult = {
  value: {
    text: "ลดเหลือ 450 ได้ไหมครับ",
    english: "Can you do 450?",
    localized: true,
  } as { text: string; english?: string; localized: boolean; reason?: string },
};
vi.mock("../agents", async () => {
  const actual = await vi.importActual<typeof import("../agents")>("../agents");
  return {
    ...actual,
    localizeMessage: async (
      text: string,
      region?: string,
      _voiceKey?: string,
      street?: boolean,
      opts?: { greet?: boolean }
    ) => {
      localizeCalls.push({ text, region, street, opts });
      return { ...localizeResult.value, text: localizeResult.value.text };
    },
  };
});

import { runSpteLiveTurn } from "./live";
import type { GraphIO, GraphTurnInput, NegotiationThreadState } from "../graph/types";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

function mockIo(overrides: Partial<GraphIO> = {}) {
  const sent: Array<{ text: string; meta: Record<string, unknown> }> = [];
  const events: Array<{ kind: string; detail: string }> = [];
  const saved: NegotiationThreadState[] = [];
  const io = {
    now: () => 1_000_000,
    sessionTable: async () => [],
    loadState: async () => null,
    saveState: async (s: NegotiationThreadState) => {
      saved.push(s);
    },
    guardAndSend: async ({ text, meta }: { text: string; meta: Record<string, unknown> }) => {
      sent.push({ text, meta });
      return { delivered: "sent" as const, detail: "ok", finalText: text };
    },
    queueOutbox: async () => {},
    insertWakeup: async () => {},
    recordEvent: async ({ kind, detail }: { kind: string; detail: string }) => {
      events.push({ kind, detail });
    },
    writeTrace: async () => {},
    ...overrides,
  } as unknown as GraphIO;
  return { io, sent, events, saved };
}

function input(partial: Partial<GraphTurnInput> = {}): GraphTurnInput {
  return {
    event: {
      kind: "inbound-text",
      threadKey: "user@x.com:66812345678",
      userEmail: "user@x.com",
      toDigits: "66812345678",
      shopMessage: "500 per day",
      images: [],
      audios: [],
    },
    ctx: {
      sender: "user@x.com",
      vendorId: "v1",
      vendorName: "Ko Tao Bikes",
      rfq: null,
      // Ultra + the local-language switch on: the entitlement the feature needs.
      plan: "ultra",
      localLang: true,
    },
    rfq: {
      vehicleClass: "scooter",
      engineSizeCc: 125,
      transmission: "any",
      durationDays: 4,
      accessories: [],
      fulfillment: "any",
      vendorMessage: "",
    },
    extraction: { found: true, pricePerDay: 500, currency: "THB", matchesSpec: true, confidence: "high" },
    usablePrice: 500,
    currency: "THB",
    floorPrice: 300,
    sessionClosed: false,
    history: "",
    priorOutbound: ["Hi! Do you have a 125cc scooter for 4 days?"],
    legacyCounts: { clarify: 0, bargain: 0, answer: 0, close: 0 },
    humanDelay: false,
    deadlineAt: 1_045_000,
    ...partial,
  };
}

beforeEach(() => {
  localizeCalls.length = 0;
  localizeResult.value = {
    text: "ลดเหลือ 450 ได้ไหมครับ",
    english: "Can you do 450?",
    localized: true,
  };
});

describe("SPTE localizes - parity with the failover engine", () => {
  it("sends the LOCAL text and stamps the English gloss on the outbound row", async () => {
    const { io, sent } = mockIo();
    const res = await runSpteLiveTurn(input(), io);
    expect(res.delivered).toBe("sent");
    expect(localizeCalls.length).toBe(1);
    // The message that reaches WhatsApp is the local one, and it still passes
    // through the emoji tone gate (the live tail gate the audit found Ultra
    // local-language sends slipped past entirely).
    //
    // AT MOST one, not exactly one. This asserted `=== 1`, which pinned the
    // defect rather than the guarantee: the rule appended an emoji to EVERY
    // outbound message, and perfect regularity across a fleet of personal
    // numbers is itself the pattern the rule exists to soften. It is now a
    // seeded draw that respects the traveller's persona (which can be "never")
    // and rises when the shop uses emoji with us. The invariant that survives -
    // and the one this test is really about - is that the LOCAL text goes out
    // and never carries a stack of them.
    expect(sent[0].text.startsWith("ลดเหลือ 450 ได้ไหมครับ")).toBe(true);
    const emojis = [...sent[0].text.matchAll(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2764}]/gu)];
    expect(emojis.length).toBeLessThanOrEqual(1);
    // ...and `meta` is spread into `whatsapp_messages.raw` by guardAndSend, so
    // this IS raw.englishGloss - the field W1.5 already renders in the thread
    // peek, the activity feed, the deals view and the Ops transcript.
    expect(sent[0].meta.englishGloss).toBe("Can you do 450?");
    expect(sent[0].meta.language).toBe("local");
  });

  it("resolves the COUNTRY from the shop's phone when the thread has no region", async () => {
    // The 4-country ceiling (owner report 4): a label-only lookup sent English
    // to every +52/+51/+90 shop and blamed the AI for it.
    const { io } = mockIo();
    await runSpteLiveTurn(input(), io);
    expect(localizeCalls[0].region).toBe("Thailand"); // from +66, no label given
  });

  it("an explicit region label still wins over the phone prefix", async () => {
    const { io } = mockIo();
    await runSpteLiveTurn(input({ ctx: { ...input().ctx, region: "Ko Tao, Thailand" } }), io);
    expect(localizeCalls[0].region).toBe("Ko Tao, Thailand");
  });

  it("W4.7: SPTE always declares itself MID-CONVERSATION to the localizer", async () => {
    // SPTE only ever runs on a turn inside an open thread, so a greeting here
    // is a repeat greeting by construction - and a local one the English strip
    // downstream could never read.
    const { io } = mockIo();
    await runSpteLiveTurn(input(), io);
    expect(localizeCalls[0].opts?.greet).toBe(false);
  });

  it("NUMBERS ARE THE RAIL: a drifted rewrite is refused and reported", async () => {
    // A dropped or drifted price is a wrong offer sent in the traveller's name,
    // in a script they cannot proofread. localizeMessage has its own guard;
    // this is the re-assertion at the call site, so a change there cannot
    // silently ship one.
    localizeResult.value = { text: "ลดเหลือ 999 ได้ไหมครับ", english: "Can you do 999?", localized: true };
    const { io, sent, events } = mockIo();
    // A turn whose deterministic draft QUOTES the shop's number back (the
    // `answer` template): rounds are spent, so bargain is illegal and the reply
    // reads "is 500 THB/day the best you can do". That is the class of message
    // where a drifted numeral is a wrong offer in the traveller's name.
    await runSpteLiveTurn(
      input({
        event: { ...input().event, shopMessage: "500 per day, which model do you want?" },
        priorOutbound: ["can you do better?", "any chance?", "how about less?", "still too much?"],
        priorOutboundKinds: ["auto-bargain", "auto-bargain", "auto-bargain", "auto-bargain"],
      }),
      io
    );
    expect(localizeCalls[0].text).toMatch(/500/); // the draft really quotes it
    expect(sent[0].text).toBe(localizeCalls[0].text); // the ENGLISH draft wins
    expect(sent[0].meta.englishGloss).toBeUndefined();
    const ev = events.find((e) => e.kind === "localize-fallback");
    expect(ev).toBeTruthy();
    expect(ev!.detail).toContain("numbers-drifted");
    expect(ev!.detail).toContain("spte-reply");
  });

  it("an unreachable localizer falls back to English, with the honest reason", async () => {
    localizeResult.value = { text: "(unused)", localized: false, reason: "ai-unavailable" };
    const { io, sent, events } = mockIo();
    await runSpteLiveTurn(input(), io);
    expect(sent.length).toBe(1); // never blocks a send
    expect(sent[0].meta.englishGloss).toBeUndefined();
    const ev = events.find((e) => e.kind === "localize-fallback");
    expect(ev!.detail).toContain("ai-unavailable");
    expect(ev!.detail).toContain("spte-reply");
  });

  it("an English-speaking region is a DECISION, not a failure - no event", async () => {
    localizeResult.value = { text: "(unused)", localized: false, reason: "english-region" };
    const { io, events } = mockIo();
    await runSpteLiveTurn(input(), io);
    expect(events.some((e) => e.kind === "localize-fallback")).toBe(false);
  });

  it("an unentitled plan never localizes - the gate is the shared predicate", async () => {
    const { io, sent } = mockIo();
    await runSpteLiveTurn(input({ ctx: { ...input().ctx, plan: "free" } }), io);
    expect(localizeCalls.length).toBe(0);
    expect(sent[0].meta.englishGloss).toBeUndefined();
  });

  it("a thread that ASKED for English is never localized back", async () => {
    // The persisted decision outranks the hunt's setting - the whole point of
    // storing the switch rather than re-deriving it every turn.
    const { io } = mockIo({
      loadState: async () =>
        ({
          threadKey: "user@x.com:66812345678",
          userEmail: "user@x.com",
          vendorId: "v1",
          vendorName: "Ko Tao Bikes",
          toNumber: "66812345678",
          phase: "negotiating",
          version: 1,
          fields: {
            firmCount: 0,
            toneDegraded: false,
            rounds: 0,
            language: { mode: "english", reason: "shop-asked", at: "2026-08-01T00:00:00.000Z" },
          },
          nodeRuns: {},
          updatedAt: "2026-08-01T00:00:00.000Z",
        }) as unknown as NegotiationThreadState,
    });
    await runSpteLiveTurn(input(), io);
    expect(localizeCalls.length).toBe(0);
  });

  it("a budget too tight for two LLM round trips skips it rather than losing the turn", async () => {
    const { io, sent } = mockIo();
    // 5s of wall clock left: a localize is up to 2x9s.
    await runSpteLiveTurn(input({ deadlineAt: 1_005_000 }), io);
    expect(localizeCalls.length).toBe(0);
    expect(sent.length).toBe(1);
  });
});

describe("the language DECISION is stored on the thread", () => {
  it("every turn writes the thread's language, so it stops being re-derived", async () => {
    const { io, saved } = mockIo();
    await runSpteLiveTurn(input(), io);
    expect(saved.length).toBe(1);
    expect(saved[0].fields.language).toEqual({
      mode: "local",
      reason: "default",
      at: new Date(1_000_000).toISOString(),
    });
  });

  it("the comprehension pass is where the explicit statement is read", () => {
    // No regex list: the judgement is a typed model read, per the owner's rule
    // that misunderstanding is never handled with if/else.
    const classifiers = readCode("src/lib/semantic/classifiers.ts");
    expect(classifiers).toMatch(/languageRequest: z/);
    expect(classifiers).toMatch(/SIMPLY REPLYING IN ENGLISH IS NOT SUCH A STATEMENT/);
    const comp = readCode("src/lib/spte/comprehension.ts");
    expect(comp).toMatch(/languageRequest\?: LanguageStatement/);
    // ...and the pass DECIDES nothing: the floor lives in the doctrine module.
    expect(comp).not.toMatch(/LANGUAGE_STATEMENT_FLOOR/);
    expect(readCode("src/lib/spte/live.ts")).toMatch(/statement: comp\?\.languageRequest/);
  });

  it("the switch reaches BOTH surfaces the owner named", () => {
    // "present the user in the status panel and the card map/vendor card that
    // we switched to English because they are not speaking the local language."
    expect(readCode("src/components/VendorCard.tsx")).toMatch(
      /t\("Switched to English - this shop asked"\)/
    );
    expect(readCode("src/app/page.tsx")).toMatch(
      /t\("Switched to English for these shops - they asked"\)/
    );
    // Both read one server-side fact, not a client guess.
    expect(readCode("src/app/api/replies/route.ts")).toMatch(/languageSwitch: languageSwitchNotice/);
  });
});
