import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT F036 - the per-recipient 8s mutex was keyed on the SPELLING, not the shop.
//
// `recipientSlot` built `to:<digitsOnly(toDigits)>:<bucket>`. A shop can be
// legitimately stored under two spellings (Google Places' national
// "09661952196" on the cold rfq row, WhatsApp's JID "639661952196" on the
// live reply row - phone-key.ts records this as observed in production). One
// drainOutbox pass takes both rows; the cold row never enters
// replySentToRecipient, so the mutex is the ONLY cross-lane guard - and it saw
// two different primary keys, both inserts won, and the shop got two messages
// inside the same second. That is exactly the Ko Tao collision the mutex was
// written to make impossible. Every test here RUNS the real claim machinery.

const state: {
  claims: Map<string, number>;
  nowMs: number;
} = { claims: new Map(), nowMs: 1_700_000_000_000 };

vi.mock("../runtime-config", () => ({
  sbInsertClaim: async (_t: string, row: { sender_key: string; slot_key: string }) => {
    const key = `${row.sender_key}|${row.slot_key}`;
    if (state.claims.has(key)) return "lost" as const;
    state.claims.set(key, state.nowMs);
    return "won" as const;
  },
  sbDelete: async (_t: string, query: string) => {
    const sender = decodeURIComponent(/sender_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    const slot = decodeURIComponent(/slot_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    state.claims.delete(`${sender}|${slot}`);
  },
  sbInsert: async () => true,
  sbSelectStrict: async (_t: string, query: string) => {
    const sender = decodeURIComponent(/sender_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    const slot = decodeURIComponent(/slot_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    const at = state.claims.get(`${sender}|${slot}`);
    return { rows: at ? [{ created_at: new Date(at).toISOString() }] : [] };
  },
}));

import { claimSendSlots, recipientSlot, HARD_MIN_GAP_SEC, RECIPIENT_LOCK_SEC } from "./pacing";

const SENDER = "traveller@example.com";
const NATIONAL = "09661952196"; // the cold rfq row (Google Places' spelling)
const INTERNATIONAL = "639661952196"; // the live reply row (WhatsApp's JID digits)

/** A cold introduction, exactly as drainOutbox claims one. */
const coldIntro = (toDigits: string, text: string, at: number) => {
  state.nowMs = at;
  return claimSendSlots({ senderKey: SENDER, toDigits, text, auto: true, gapSeconds: 12, nowMs: at });
};

/** An engaged reply, exactly as the reply lane claims one. */
const reply = (toDigits: string, text: string, at: number) => {
  state.nowMs = at;
  return claimSendSlots({
    senderKey: SENDER,
    toDigits,
    text,
    auto: true,
    gapSeconds: 5,
    perRecipient: true,
    fleetGapSeconds: 6,
    nowMs: at,
  });
};

// Aligned to both the 12s cold lane and the 8s recipient window.
const t0 = 1_700_000_000_000 - (1_700_000_000_000 % 24_000);

beforeEach(() => {
  state.claims = new Map();
  state.nowMs = t0;
});

describe("EXECUTED: one shop under two spellings takes ONE recipient slot", () => {
  it("a cold intro to the national spelling then a reply to the JID spelling one second later is REFUSED", async () => {
    const intro = await coldIntro(NATIONAL, "Hi! Do you have a scooter for 3 days?", t0);
    expect(intro.ok).toBe(true);
    // THE ASSERTION THAT FAILED BEFORE: both keys won, both messages went.
    const answer = await reply(INTERNATIONAL, "Thanks! Is that the 125cc automatic?", t0 + 1_000);
    expect(answer).toMatchObject({ ok: false, kind: "pacing" });
  });

  it("...and in the other order too", async () => {
    const answer = await reply(INTERNATIONAL, "Is that the 125cc automatic?", t0);
    expect(answer.ok).toBe(true);
    const intro = await coldIntro(NATIONAL, "Hi! Do you have a scooter?", t0 + 1_000);
    expect(intro).toMatchObject({ ok: false, kind: "pacing" });
  });

  it("the shop CAN be messaged under the other spelling once the floor has passed", async () => {
    await coldIntro(NATIONAL, "Hi! Do you have a scooter?", t0);
    const later = await reply(INTERNATIONAL, "Is that the 125cc?", t0 + RECIPIENT_LOCK_SEC * 1000 + 1_000);
    expect(later.ok).toBe(true);
  });

  it("two genuinely DIFFERENT shops still hold different keys", async () => {
    expect(recipientSlot("639661952196", 7)).not.toBe(recipientSlot("639661952197", 7));
  });
});

describe("the key is the SHOP, whichever spelling the row carries", () => {
  it("both spellings, and every formatting of them, hash to one key", () => {
    const canonical = recipientSlot(NATIONAL, 7);
    expect(recipientSlot(INTERNATIONAL, 7)).toBe(canonical);
    expect(recipientSlot("+63 966 195 2196", 7)).toBe(canonical);
    expect(recipientSlot("0966 195 2196", 7)).toBe(canonical);
    expect(recipientSlot("639661952196:12@s.whatsapp.net", 7)).toBe(canonical);
  });

  it("the anti-ban floor is untouched", () => {
    expect(HARD_MIN_GAP_SEC).toBe(8);
    expect(RECIPIENT_LOCK_SEC).toBe(HARD_MIN_GAP_SEC);
  });
});
