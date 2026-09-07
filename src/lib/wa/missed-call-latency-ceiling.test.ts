import { describe, it, expect, vi, beforeEach } from "vitest";

// AUDIT A5, ROUND 2 - the translation must never hold the ringing shop's reply.
//
// The round-1 fix put the language decision AHEAD of the send: two PostgREST
// reads plus `localizeMessage` (a 2-attempt LLM retry loop) run immediately
// before `guardOutbound`. `handleCallEvent` runs inside
// `finishBeforeResponse("inbound-call", ...)` (wa/ingest.ts) whose whole budget
// is `AFTER_BUDGET_MS`, and that budget previously covered only
// guardOutbound + claimForSend + sendFromUser. A slow provider therefore burns
// the entire webhook budget in translation; the race resolves, the route
// flushes, Cloud Run throttles the CPU and the send never happens - while the
// hourly claim `call:<shop>:<hour>` has ALREADY been taken, so an Evolution
// redelivery in the same hour is suppressed as "already answered". A bounded
// send became a silently-droppable one.
//
// Every test here RUNS the real functions against a Map-backed store with a
// translator (and, separately, a store) that simply never answers. They fail
// against the round-1 tree, where nothing bounds the language leg at all.

vi.mock("server-only", () => ({}));

const HANG = () => new Promise<never>(() => {});

const world: {
  known: string | null;
  store: Map<string, Record<string, unknown>[]>;
  transported: { to: string; text: string }[];
  events: { kind: string; detail: string }[];
  localizeCalls: number;
  /** null = the provider answers; "hang" = it never does. */
  localizeMode: "ok" | "hang";
  selectMode: "ok" | "hang";
} = {
  known: null,
  store: new Map(),
  transported: [],
  events: [],
  localizeCalls: 0,
  localizeMode: "ok",
  selectMode: "ok",
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
    }
    return true;
  },
  sbSelect: async (table: string) => {
    if (world.selectMode === "hang") return HANG();
    return world.store.get(table) ?? [];
  },
  sbSelectStrict: async (table: string) => {
    if (world.selectMode === "hang") return HANG();
    return { rows: world.store.get(table) ?? [] };
  },
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
  localizeMessage: async (text: string) => {
    world.localizeCalls += 1;
    if (world.localizeMode === "hang") return HANG();
    return { text: "ขอโทษครับ รับสายไม่ได้", english: text, localized: true };
  },
}));

import {
  handleCallEvent,
  missedCallText,
  missedCallReply,
  MISSED_CALL_LANG_BUDGET_MS,
} from "./call-intercept";
import { AFTER_BUDGET_MS } from "../after";

const EMAIL = "traveller@example.com";
const SHOP = "66123456789"; // +66 = Thailand, so the translator is reachable

/** The thread's opener carried localLang - this is a Thai-language thread. */
function threadOpenedInLocal() {
  world.store.set("whatsapp_messages", [{ raw: { sender: EMAIL, localLang: true } }]);
}

const isEnglishReply = (text: string) =>
  /can'?t (?:take|really do) (?:a )?call|missed your call|couldn'?t pick up/i.test(text);

/** Resolve to SENTINEL if the subject has not answered in `ms`. */
const SENTINEL = Symbol("never-answered");
function within<T>(p: Promise<T>, ms: number): Promise<T | typeof SENTINEL> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<typeof SENTINEL>((r) => {
      timer = setTimeout(() => r(SENTINEL), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

beforeEach(() => {
  world.known = SHOP;
  world.store = new Map();
  world.transported = [];
  world.events = [];
  world.localizeCalls = 0;
  world.localizeMode = "ok";
  world.selectMode = "ok";
  threadOpenedInLocal();
});

describe("A5 latency - the missed-call translation is hard-capped", () => {
  it("a hung translator expires on the ceiling and yields the English literal", async () => {
    world.localizeMode = "hang";
    const started = Date.now();
    const out = await within(missedCallText({ email: EMAIL, toDigits: SHOP, budgetMs: 150 }), 1_200);
    // THE BUG: nothing bounded the language leg, so this never resolved at all.
    expect(out).not.toBe(SENTINEL);
    const res = out as Awaited<ReturnType<typeof missedCallText>>;
    expect(res.localized).toBe(false);
    expect(res.reason).toBe("timeout");
    expect(isEnglishReply(res.text)).toBe(true);
    // ...and it is one of the three deterministic variants, unchanged.
    const variants = new Set([0, 0.4, 0.8].map((p) => missedCallReply(() => p)));
    expect(variants.has(res.text)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(world.localizeCalls).toBe(1);
  });

  it("a hung STORE read cannot hold it either", async () => {
    world.selectMode = "hang";
    const out = await within(missedCallText({ email: EMAIL, toDigits: SHOP, budgetMs: 150 }), 1_200);
    expect(out).not.toBe(SENTINEL);
    const res = out as Awaited<ReturnType<typeof missedCallText>>;
    expect(res.reason).toBe("timeout");
    expect(isEnglishReply(res.text)).toBe(true);
  });

  it("the ringing shop is still ANSWERED when the translator hangs", async () => {
    world.localizeMode = "hang";
    const started = Date.now();
    const out = await within(
      handleCallEvent({
        email: EMAIL,
        data: { from: `${SHOP}@s.whatsapp.net`, status: "offer" },
        langBudgetMs: 150,
      }),
      1_200
    );
    // THE FAILURE THE REFUTATION DESCRIBES: the hourly claim is already taken,
    // so a webhook that gives up here leaves the shop with nothing and a
    // redelivery suppressed.
    expect(out).not.toBe(SENTINEL);
    const res = out as Awaited<ReturnType<typeof handleCallEvent>>;
    expect(res.detail).toBe("sent");
    expect(world.transported).toHaveLength(1);
    expect(isEnglishReply(world.transported[0].text)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    // The trace says WHY it went out in English rather than leaving Ops to guess.
    const ev = world.events.find((e) => e.kind === "inbound-call");
    expect(ev?.detail).toContain('"langReason":"timeout"');
  });

  it("the ceiling leaves the send leg most of the webhook budget", () => {
    expect(MISSED_CALL_LANG_BUDGET_MS).toBeGreaterThan(0);
    // "Well under" the after-budget: the language leg may never take more than
    // a third of the window that also has to cover guardOutbound, claimForSend,
    // the Evolution send, afterSend and the outbound row.
    expect(MISSED_CALL_LANG_BUDGET_MS * 3).toBeLessThanOrEqual(AFTER_BUDGET_MS);
  });

  it("a translator that DOES answer inside the budget still speaks the local language", async () => {
    const res = await missedCallText({ email: EMAIL, toDigits: SHOP, budgetMs: 1_000 });
    expect(res.localized).toBe(true);
    expect(isEnglishReply(res.text)).toBe(false);
    expect(res.english).toBeTruthy();
  });
});
