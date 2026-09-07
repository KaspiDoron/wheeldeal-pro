// AUDIT F142 - the number rails guard the ENGLISH draft, but the wire carries
// the LOCALIZED string.
//
// On the primary engine `runPostRails` runs correctDuration and
// checkOutboundNumbers over `artifact.message`, and live.ts then REPLACES the
// text with the localizer's output. The only check applied afterwards is
// `numbersPreserved`, a one-directional subset test over 3+ digit runs - so it
// cannot see a numeral the translation ADDED (a price the thread never held) or
// a 1-2 digit numeral it CHANGED (the rental length, which guardrails.ts calls
// "the single most damaging LLM slip observed in production"). The graph
// failover does not share the gap: it localizes first and rails afterwards.
//
// The repair is the symmetric fidelity check, NOT a re-run of the grounded
// provenance rail over Thai wire text: a false rejection there would silently
// flip a shop to English for the rest of the hunt, which is the downgrade the
// module argues against. A rejection here keeps the existing, already-tested
// behaviour - ship the English draft, emit the honest localize-fallback event.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../ai", () => ({
  chat: async () => null,
  chatDetailed: async () => ({ text: null }),
  extractJson: () => null,
}));

const localizeCalls: string[] = [];
const localizeResult = {
  fn: (source: string) => ({
    text: `ลดเหลือ ${source.match(/\d{3,}/)?.[0] ?? "500"} ได้ไหมครับ`,
    english: source,
    localized: true,
    reason: undefined as string | undefined,
  }),
};
vi.mock("../agents", async () => {
  const actual = await vi.importActual<typeof import("../agents")>("../agents");
  return {
    ...actual,
    localizeMessage: async (text: string) => {
      localizeCalls.push(text);
      return localizeResult.fn(text);
    },
  };
});

import { runSpteLiveTurn } from "./live";
import { numbersPreserved } from "../integrity/translation";
import type { GraphIO, GraphTurnInput, NegotiationThreadState } from "../graph/types";

function mockIo() {
  const sent: Array<{ text: string; meta: Record<string, unknown> }> = [];
  const events: Array<{ kind: string; detail: string }> = [];
  const io = {
    now: () => 1_000_000,
    sessionTable: async () => [],
    loadState: async () => null,
    saveState: async (_s: NegotiationThreadState) => {},
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
  } as unknown as GraphIO;
  return { io, sent, events };
}

/** A turn whose deterministic draft quotes the shop's own number back. */
function input(): GraphTurnInput {
  return {
    event: {
      kind: "inbound-text",
      threadKey: "user@x.com:66812345678",
      userEmail: "user@x.com",
      toDigits: "66812345678",
      shopMessage: "500 per day, which model do you want?",
      images: [],
      audios: [],
    },
    ctx: {
      sender: "user@x.com",
      vendorId: "v1",
      vendorName: "Ko Tao Bikes",
      rfq: null,
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
    priorOutbound: ["can you do better?", "any chance?", "how about less?", "still too much?"],
    priorOutboundKinds: ["auto-bargain", "auto-bargain", "auto-bargain", "auto-bargain"],
    legacyCounts: { clarify: 0, bargain: 0, answer: 0, close: 0 },
    humanDelay: false,
    deadlineAt: 1_045_000,
  } as unknown as GraphTurnInput;
}

beforeEach(() => {
  localizeCalls.length = 0;
  localizeResult.fn = (source: string) => ({
    text: `ลดเหลือ ${source.match(/\d{3,}/)?.[0] ?? "500"} ได้ไหมครับ`,
    english: source,
    localized: true,
    reason: undefined,
  });
});

describe("EXECUTED: numbersPreserved is symmetric", () => {
  it("a price-scale numeral the source never held is refused", () => {
    expect(
      numbersPreserved("Could you do 250 a day for the 4 days?", "ลดเหลือ 250 ต่อวันได้ไหมครับ ปกติ 800 ใช่ไหม")
    ).toBe(false);
  });

  it("a CHANGED rental length is refused", () => {
    expect(
      numbersPreserved("Could you do 250 a day for the 4 days?", "ขอ 250 บาท ต่อวัน สำหรับ 7 วัน ได้ไหมครับ")
    ).toBe(false);
  });

  it("a faithful translation still passes, in any digit script", () => {
    expect(numbersPreserved("180 baht per day", "วันละ ๑๘๐ บาท")).toBe(true);
    expect(numbersPreserved("Could you do 250 a day for the 4 days?", "ขอ 250 บาท ต่อวัน สำหรับ 4 วัน")).toBe(
      true
    );
    // Spelling a small count out in words is idiomatic, and dropping it is not
    // a drift - only ADDING or CHANGING one is.
    expect(numbersPreserved("can I have it for 3 days?", "ขอสามวันได้ไหม")).toBe(true);
  });

  it("the original guarantee is untouched: a dropped or altered price still fails", () => {
    expect(numbersPreserved("180 baht per day", "วันละเท่าไหร่ครับ")).toBe(false);
    expect(numbersPreserved("180 baht per day", "วันละ 150 บาท")).toBe(false);
  });
});

describe("EXECUTED: the live SPTE path refuses a translation that invented a number", () => {
  it("an ADDED price ships the English draft with an honest event", async () => {
    localizeResult.fn = (source: string) => ({
      text: `ลดเหลือ ${source.match(/\d{3,}/)?.[0] ?? "500"} ต่อวันได้ไหมครับ ปกติ 800 ใช่ไหม`,
      english: source,
      localized: true,
      reason: undefined,
    });
    const { io, sent, events } = mockIo();
    await runSpteLiveTurn(input(), io);
    expect(localizeCalls[0]).toMatch(/500/);
    expect(localizeCalls[0]).not.toMatch(/800/);
    // The English draft is what reaches the wire - never the invented 800.
    expect(sent[0].text).not.toMatch(/800/);
    expect(sent[0].meta.englishGloss).toBeUndefined();
    const ev = events.find((e) => e.kind === "localize-fallback");
    expect(ev, JSON.stringify(events)).toBeTruthy();
    expect(ev!.detail).toContain("numbers-added");
    expect(ev!.detail).toContain("spte-reply");
  });

  it("a CHANGED rental length ships the English draft too", async () => {
    localizeResult.fn = (source: string) => ({
      text: `ขอ ${source.match(/\d{3,}/)?.[0] ?? "500"} บาท ต่อวัน สำหรับ 7 วัน ได้ไหมครับ`,
      english: source,
      localized: true,
      reason: undefined,
    });
    const { io, sent, events } = mockIo();
    await runSpteLiveTurn(input(), io);
    expect(localizeCalls[0]).not.toMatch(/\b7\b/);
    expect(sent[0].text).not.toMatch(/7 วัน/);
    expect(sent[0].meta.englishGloss).toBeUndefined();
    expect(events.some((e) => e.kind === "localize-fallback")).toBe(true);
  });

  it("a faithful translation still goes out in the local language", async () => {
    const { io, sent } = mockIo();
    await runSpteLiveTurn(input(), io);
    expect(sent[0].text.startsWith("ลดเหลือ 500 ได้ไหมครับ")).toBe(true);
    expect(sent[0].meta.language).toBe("local");
  });
});
