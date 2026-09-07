import { describe, it, expect, vi, beforeEach } from "vitest";

// AUDIT A5 - the missed-call reply is hardcoded English in a local-language
// thread.
//
// A Thai shop that has been messaged in Thai for ten minutes rings the
// traveller. The whole thread is Thai; the one message this module exists to
// deliver went out as "Sorry, I missed your call - I can't take calls right
// now." in English, mid-Thai-thread, because `missedCallReply()` returns an
// English literal and nothing between it and the wire translates (guardOutbound
// only paces and humanizes).
//
// Every test here RUNS handleCallEvent against a Map-backed store. Test 1 fails
// against the code as it stood before this fix.

vi.mock("server-only", () => ({}));

const world: {
  known: string | null;
  /** Rows the fake PostgREST serves, by table. */
  store: Map<string, Record<string, unknown>[]>;
  transported: { to: string; text: string }[];
  written: Record<string, unknown>[];
  events: { kind: string; detail: string }[];
  localizeCalls: { text: string; region?: string; greet?: boolean }[];
  /** What the fake translator hands back (null = the provider is down). */
  localizeTo: string | null;
} = {
  known: null,
  store: new Map(),
  transported: [],
  written: [],
  events: [],
  localizeCalls: [],
  localizeTo: null,
};

vi.mock("./known-thread", () => ({
  resolveKnownThreadNumber: async (_e: string, digits: string) =>
    world.known === null ? null : world.known || digits,
}));

vi.mock("../runtime-config", () => ({
  sbInsertClaim: async () => "won" as const,
  sbInsert: async (table: string, rows: Record<string, unknown>[]) => {
    if (table === "agent_events") {
      world.events.push({
        kind: String(rows[0].kind ?? ""),
        detail: String(rows[0].detail ?? ""),
      });
    } else {
      world.written.push(rows[0]);
    }
    return true;
  },
  sbSelect: async (table: string) => world.store.get(table) ?? [],
  sbSelectStrict: async (table: string) => ({ rows: world.store.get(table) ?? [] }),
}));

vi.mock("../notify/state", () => ({
  notifyState: async () => ({ anyReplyYet: true, sentInWindow: 99 }),
  markPushSent: async () => {},
}));
vi.mock("../push", () => ({ sendPushToUser: async () => {} }));

vi.mock("../wa-guard", () => ({
  guardOutbound: async (o: { text: string }) => ({ allow: true, text: o.text }),
  claimForSend: async () => ({ ok: true }),
  releaseSendClaim: async () => {},
  afterSend: async () => {},
}));
vi.mock("../evolution", () => ({
  sendFromUser: async (_e: string, to: string, text: string) => {
    world.transported.push({ to, text });
    return { ok: true, messageId: "m1" };
  },
}));

vi.mock("../agents", () => ({
  localizeMessage: async (
    text: string,
    region?: string,
    _voice?: string,
    _street?: boolean,
    opts?: { greet?: boolean }
  ) => {
    world.localizeCalls.push({ text, region, greet: opts?.greet });
    if (!world.localizeTo) return { text, localized: false, reason: "ai-unavailable" };
    return { text: world.localizeTo, english: text, localized: true };
  },
}));

import { handleCallEvent, missedCallReply } from "./call-intercept";

const EMAIL = "traveller@example.com";
const SHOP = "66123456789"; // +66 = Thailand
const THAI = "ขอโทษครับ รับสายไม่ได้ พิมพ์มาได้เลยครับ";

/** The thread's opener carried localLang - this is a Thai-language thread. */
function threadOpenedIn(localLang: boolean | undefined) {
  world.store.set("whatsapp_messages", [
    { raw: { sender: EMAIL, ...(localLang === undefined ? {} : { localLang }) } },
  ]);
}

const ring = () => handleCallEvent({ email: EMAIL, data: { from: `${SHOP}@s.whatsapp.net`, status: "offer" } });

const isEnglishReply = (text: string) =>
  /can'?t (?:take|really do) (?:a )?call|missed your call|couldn'?t pick up/i.test(text);

beforeEach(() => {
  world.known = SHOP;
  world.store = new Map();
  world.transported = [];
  world.written = [];
  world.events = [];
  world.localizeCalls = [];
  world.localizeTo = THAI;
  threadOpenedIn(true);
});

describe("A5 - the missed-call reply speaks the thread's language", () => {
  it("a Thai-language thread gets the reply in Thai, not English", async () => {
    const res = await ring();
    expect(res.outcome).toBe("answered");
    expect(world.transported).toHaveLength(1);
    // THE BUG: the English literal reached a shop mid-Thai-thread.
    expect(isEnglishReply(world.transported[0].text)).toBe(false);
    expect(world.transported[0].text).toBe(THAI);
    // ...and it was translated mid-conversation, so no greeting is re-added.
    expect(world.localizeCalls).toHaveLength(1);
    expect(world.localizeCalls[0].region).toBe("Thailand");
    expect(world.localizeCalls[0].greet).toBe(false);
    // The English source travels with it so the traveller can read what was
    // sent in their name.
    const row = world.written.find((r) => r.direction === "outbound");
    expect((row?.raw as { englishGloss?: string } | undefined)?.englishGloss).toBeTruthy();
  });

  it("a shop that asked for English still gets English (the thread's decision wins)", async () => {
    world.store.set("negotiation_threads", [
      { fields: { language: { mode: "english", reason: "shop-asked", at: "2026-01-01T00:00:00.000Z" } } },
    ]);
    await ring();
    expect(world.localizeCalls).toHaveLength(0);
    expect(isEnglishReply(world.transported[0].text)).toBe(true);
  });

  it("an English-opened thread is untouched", async () => {
    threadOpenedIn(false);
    await ring();
    expect(world.localizeCalls).toHaveLength(0);
    expect(isEnglishReply(world.transported[0].text)).toBe(true);
  });

  it("an unreadable thread language degrades to the English reply", async () => {
    threadOpenedIn(undefined);
    await ring();
    expect(world.localizeCalls).toHaveLength(0);
    expect(isEnglishReply(world.transported[0].text)).toBe(true);
  });

  it("a translation outage still answers the ringing shop, in English", async () => {
    world.localizeTo = null;
    const res = await ring();
    expect(res.detail).toBe("sent");
    expect(world.transported).toHaveLength(1);
    expect(isEnglishReply(world.transported[0].text)).toBe(true);
    // English is one of the three deterministic variants, unchanged.
    const variants = new Set([0, 0.4, 0.8].map((p) => missedCallReply(() => p)));
    expect(variants.has(world.transported[0].text)).toBe(true);
  });
});
