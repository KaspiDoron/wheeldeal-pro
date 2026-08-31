import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

// KO TAO, 12:21. Two of our messages landed on one shop inside the same minute:
//
//   12:21  "I need scooter for 3 days, can you give me your best price per day?"
//   12:21  "Thanks for the options! I'm looking for a fully automatic 125cc
//           scooter, is that one of the bikes you have free?"
//
// Neither pacing lane was broken. They simply do not intersect: a cold intro
// claims `gap:12:<bucket>` with NO recipient in the key, while a reply claims
// `gap:5:<digits>:<bucket>`. Two different strings, so both win, and a stranger
// sends a shop two messages at once.
//
// That also made a second dispatcher unsafe to build - a reply-only drain
// running beside the global one would recreate the collision by design. Hence
// the mutex lands FIRST.

const state: {
  claims: Map<string, number>;
  mode: "ok" | "missing" | "unavailable";
  nowMs: number;
} = { claims: new Map(), mode: "ok", nowMs: 1_700_000_000_000 };

vi.mock("../runtime-config", () => ({
  sbInsertClaim: async (_t: string, row: { sender_key: string; slot_key: string }) => {
    if (state.mode !== "ok") return "error" as const;
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
  sbSelectStrict: async (_t: string, query: string) => {
    if (state.mode === "missing") return { error: "missing" as const };
    if (state.mode === "unavailable") return { error: "unavailable" as const };
    const sender = decodeURIComponent(/sender_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    const slot = decodeURIComponent(/slot_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    const at = state.claims.get(`${sender}|${slot}`);
    return { rows: at ? [{ created_at: new Date(at).toISOString() }] : [] };
  },
}));

import { claimSendSlots, recipientSlot, RECIPIENT_LOCK_SEC, HARD_MIN_GAP_SEC } from "./pacing";

beforeEach(() => {
  state.claims = new Map();
  state.mode = "ok";
  state.nowMs = 1_700_000_000_000;
});

const SENDER = "traveller@example.com";
const SHOP = "66931034552";

/** A cold introduction, exactly as drainOutbox claims one. */
const coldIntro = (text: string, at: number) => {
  state.nowMs = at;
  return claimSendSlots({
    senderKey: SENDER,
    toDigits: SHOP,
    text,
    auto: true,
    gapSeconds: 12,
    nowMs: at,
  });
};

/** An engaged reply, exactly as the reply lane claims one. */
const reply = (text: string, at: number, toDigits = SHOP) => {
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

describe("one shop's inbox is not a lane - it is a mutex", () => {
  // Aligned to 12s so it is also aligned to the 8s recipient window? No: 12 and
  // 8 do not share a boundary, which is exactly why the alignment is computed.
  const t0 = 1_700_000_000_000 - (1_700_000_000_000 % 24_000);

  it("REPRODUCTION: a cold intro and a reply to the SAME shop cannot both send", async () => {
    const intro = await coldIntro("Hi! Do you have a scooter available for 3 days?", t0);
    const answer = await reply("Thanks for the options! Is that a 125cc automatic?", t0 + 500);
    expect(intro.ok).toBe(true);
    expect(answer).toMatchObject({ ok: false, kind: "pacing" });
  });

  it("...and it holds in the other order too", async () => {
    const answer = await reply("Is that a 125cc automatic?", t0);
    const intro = await coldIntro("Hi! Do you have a scooter available?", t0 + 500);
    expect(answer.ok).toBe(true);
    expect(intro).toMatchObject({ ok: false, kind: "pacing" });
  });

  it("the loser frees its message slot so its own retry is not a duplicate", async () => {
    await coldIntro("Hi! Do you have a scooter available?", t0);
    const answer = await reply("Is that a 125cc automatic?", t0 + 500);
    expect(answer.ok).toBe(false);
    // Retried a full window later, the same text goes out.
    const retry = await reply("Is that a 125cc automatic?", t0 + RECIPIENT_LOCK_SEC * 1000 + 1_000);
    expect(retry.ok).toBe(true);
  });

  it("DIFFERENT shops are untouched - this is a per-recipient lock, not a global one", async () => {
    // The whole reason the reply lane went per-recipient was so 40 live threads
    // do not serialize. The mutex must not quietly undo that.
    //
    // 7s apart is the discriminating gap: past the 6s fleet ceiling (so that
    // lane cannot be what decides it), but INSIDE the same 8s recipient window.
    // A global lock would refuse the second; a per-recipient one must not.
    const a = await reply("reply to shop A", t0, "66111111111");
    const b = await reply("reply to shop B", t0 + 7_000, "66222222222");
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it("the FLEET ceiling still bites - two shops at once is still a burst", async () => {
    // Unchanged by the mutex, and pinned here so a future change to either lock
    // cannot silently remove the other. This is the reply lane's own limit.
    const a = await reply("reply to shop A", t0, "66111111111");
    const b = await reply("reply to shop B", t0 + 200, "66222222222");
    expect(a.ok).toBe(true);
    expect(b).toMatchObject({ ok: false, kind: "pacing" });
  });

  it("the same shop CAN be messaged again once the floor has passed", async () => {
    const first = await coldIntro("Hi! Do you have a scooter available?", t0);
    const second = await reply("Great - is that the 125cc?", t0 + RECIPIENT_LOCK_SEC * 1000 + 1_000);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });

  it("REFUSES a straddle across the window edge - a bucket is not a promise", async () => {
    const first = await coldIntro("Hi there!", t0 + RECIPIENT_LOCK_SEC * 1000 - 100);
    const second = await reply("and another thing", t0 + RECIPIENT_LOCK_SEC * 1000 + 100);
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, kind: "pacing" });
  });
});

describe("the floor it enforces", () => {
  it("is the same hard floor the cold batch may never trade away", async () => {
    expect(RECIPIENT_LOCK_SEC).toBe(HARD_MIN_GAP_SEC);
    expect(HARD_MIN_GAP_SEC).toBe(8);
  });

  it("the key carries the recipient and nothing else - no lane, no gap size", async () => {
    expect(recipientSlot("+66 93 103 4552", 7)).toBe("to:66931034552:7");
    // Two lanes, one key: that is the entire point.
    expect(recipientSlot("66931034552", 7)).toBe(recipientSlot("+66-93-103-4552", 7));
  });
});

describe("it does not change what was already true", () => {
  const t0 = 1_700_000_000_000 - (1_700_000_000_000 % 24_000);

  it("a message the TRAVELLER typed is still never pacing-gated", async () => {
    // Their decision, their message: no lane budget, no anti-ban velocity
    // window. With nothing else going to this shop it leaves immediately.
    const mine = await claimSendSlots({
      senderKey: SENDER,
      toDigits: SHOP,
      text: "hey, can I pick it up at 6?",
      auto: false,
      gapSeconds: 12,
      nowMs: t0 + 100,
    });
    expect(mine.ok).toBe(true);
  });

  // ...BUT IT IS NOW COLLISION-GATED, WHICH IS A DIFFERENT THING.
  //
  // This block previously asserted the opposite, on the reasoning that the
  // mutex sits after the auto check "on purpose - a human pressing send is not
  // a burst". That is right about pacing and wrong about the shop's inbox: the
  // traveller tapping Bargain while an agent turn is going out is the same
  // two-messages-in-one-minute the mutex exists to prevent, and it is the
  // likeliest version of it, because the app puts that button in front of them
  // exactly when the thread is active.
  it("but it does NOT get to land on a shop the agent is mid-message with", async () => {
    await coldIntro("agent intro", t0);
    const mine = await claimSendSlots({
      senderKey: SENDER,
      toDigits: SHOP,
      text: "hey, can I pick it up at 6?",
      auto: false,
      gapSeconds: 12,
      nowMs: t0 + 100,
    });
    expect(mine).toMatchObject({ ok: false, kind: "recipient-busy" });
  });

  it("and the agent does not get to land on top of the traveller either", async () => {
    const mine = await claimSendSlots({
      senderKey: SENDER,
      toDigits: SHOP,
      text: "hey, can I pick it up at 6?",
      auto: false,
      gapSeconds: 12,
      nowMs: t0,
    });
    expect(mine.ok).toBe(true);
    // For the agent this is ordinary pacing: re-queue and try again shortly.
    expect(await coldIntro("agent intro", t0 + 100)).toMatchObject({ ok: false, kind: "pacing" });
  });

  it("once the shop's window passes, the traveller's message goes out", async () => {
    await coldIntro("agent intro", t0);
    const later = await claimSendSlots({
      senderKey: SENDER,
      toDigits: SHOP,
      text: "hey, can I pick it up at 6?",
      auto: false,
      gapSeconds: 12,
      nowMs: t0 + (RECIPIENT_LOCK_SEC + 2) * 1000,
    });
    expect(later.ok).toBe(true);
  });

  it("exact-duplicate text is still refused as a duplicate, not as pacing", async () => {
    await coldIntro("identical text", t0);
    const again = await coldIntro("identical text", t0 + 60_000);
    expect(again).toEqual({ ok: false, kind: "duplicate" });
  });

  it("a pre-migration wa_send_claims table still degrades to today's behaviour", async () => {
    state.mode = "missing";
    const r = await coldIntro("no claims table yet", t0);
    expect(r).toEqual({ ok: true });
  });

  it("an unknown claim state still FAILS CLOSED", async () => {
    state.mode = "unavailable";
    const r = await coldIntro("db wobbling", t0);
    expect(r.ok).toBe(false);
  });
});

describe("no send path walks around the lock", () => {
  const readCode = (p: string) =>
    readFileSync(join(process.cwd(), p), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

  it("the Trips price re-check claims before it sends", () => {
    // It re-asks every shop from a past session at once - the batch most likely
    // to land on one the live agent is already mid-sentence with - and it used
    // to go straight from the guard verdict to the wire, with no claim at all.
    const recheck = readCode("src/app/api/deals/recheck/route.ts");
    const claimAt = recheck.indexOf("claimForSend(session.email, digits, guard.text");
    const sendAt = recheck.indexOf("sendFromUser(session.email, digits, guard.text)");
    expect(claimAt).toBeGreaterThan(0);
    expect(claimAt).toBeLessThan(sendAt);
  });

  it("the owner's live drill route stays deleted - a send path with no lock discipline to pin", () => {
    // It went from the guard verdict to real WhatsApp with zero UI consumers;
    // Wave 7 deleted it (dead-code.test.ts pins the deletion). If it returns,
    // it returns WITH the claim-before-send discipline this suite enforces.
    expect(existsSync(join(process.cwd(), "src/app/api/admin/drill"))).toBe(false);
  });

  it("and the traveller is TOLD, not silently queued behind their own agent", () => {
    const outreach = readCode("src/app/api/outreach/route.ts");
    expect(outreach).toMatch(/claim\.kind === "recipient-busy"/);
    expect(outreach).toMatch(/agentBusy: true/);
    expect(outreach).toMatch(/Your agent is mid-message with this shop/);
  });
});
