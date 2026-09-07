import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT F064: IN_CALL_BUDGET_MS WAS NOT A WALL.
//
// The tick's 45s in-call budget only gated whether a FURTHER drain was
// started. Three holes let one invocation run past Cloud Run's --timeout 90:
//
//   1. `const started = Date.now()` sat BELOW the hop-retry sleep (up to
//      30.25s waiting for the next 30s chain window), so that sleep was never
//      counted.
//   2. Each drainOnce passed a FIXED `budgetMs: 40_000`, never clipped to what
//      remained - a drain started at t=44.9s ran to t=84.9s before its own
//      one-row overshoot.
//   3. drainGraphWakeups took no budget at all (DrainWakeupOptions had only
//      userEmail), so every due wakeup's full multi-agent compose ran
//      unbounded.
//
// A kill mid-drain leaves every claimed row invisible for CLAIM_LEASE_MS (3
// minutes) and skips the hop kick, ending the chain silently. reply-tick had
// holes 2 and 3 without the pre-sleep.
//
// The refuter's concern, honoured: drainOutbox floors its budget at 5_000, so
// a clip below the floor is silently ignored - a drain is therefore only
// STARTED while at least the floor remains, and the wait loop stops when the
// wait plus a floor-sized drain would cross the wall. IN_CALL_BUDGET_MS itself
// is unchanged: the wall bounds ADMISSION; one row's in-flight overshoot
// (documented worst case ~29s) still lands inside the 90s kill.
//
// EXECUTED against the real GET handlers under fake timers: the claim, the
// store and both drains are stubbed at the module boundary, the outbox drain
// "costs" a scripted amount of clock, and every budget the route hands out is
// checked against the wall it must fit inside.

const ctl = vi.hoisted(() => ({
  claims: [] as ("won" | "lost" | "error")[],
  dueIn: [] as (number | null)[],
  drainCostMs: 0,
  t0: 0,
  outbox: [] as { opts: { budgetMs?: number } | undefined; at: number }[],
  wakeups: [] as { opts: { budgetMs?: number } | undefined; at: number }[],
}));

vi.mock("@/lib/evolution", () => ({
  // Host-independent since audit M5: the cron routes authenticate with the
  // env-only derivation, so a vault brownout can no longer 403 the scheduler.
  webhookAuthToken: () => "tok",
  sendFromUser: async () => ({ ok: true, messageId: "3EB0" }),
}));
vi.mock("@/lib/wa/webhook-token", () => ({ tokenMatches: () => true }));
vi.mock("@/lib/runtime-config", () => ({
  sbInsertClaim: async () => ctl.claims.shift() ?? "won",
  sbSelect: async (table: string) => {
    if (table !== "wa_outbox") return [];
    const d = ctl.dueIn.length ? ctl.dueIn.shift() : null;
    if (d === null || d === undefined) return [];
    return [{ not_before: new Date(Date.now() + d).toISOString() }];
  },
  sbDelete: async () => true,
}));
vi.mock("@/lib/wa-guard", () => ({
  drainOutbox: async (_send: unknown, opts: { budgetMs?: number } | undefined) => {
    ctl.outbox.push({ opts, at: Date.now() - ctl.t0 });
    // The drain "spends" clock: rows admitted inside its budget, plus the
    // last row's send. Modelled as a jump so no real time passes.
    vi.setSystemTime(Date.now() + ctl.drainCostMs);
    return 0;
  },
  REPLY_KIND_FILTER: "",
}));
vi.mock("@/lib/graph/engine", () => ({
  drainGraphWakeups: async (_send: unknown, opts: { budgetMs?: number } | undefined) => {
    ctl.wakeups.push({ opts, at: Date.now() - ctl.t0 });
    return 0;
  },
}));
vi.mock("@/lib/request-origin", () => ({ selfKickOrigin: async () => "http://localhost" }));
vi.mock("@/lib/wa/kick", () => ({ kickDispatcher: async () => {} }));

import { GET as tickGet } from "@/app/api/wa/tick/route";
import { GET as replyTickGet } from "@/app/api/wa/reply-tick/route";

// Both routes' documented in-call wall.
const WALL_MS = 45_000;
// drainOutbox's own floor: a budget below this is silently raised to it.
const DRAIN_FLOOR_MS = 5_000;
// A 30s chain window boundary (tick claims `chain:<floor(now/30s)>`).
const WINDOW_START = 30_000 * 56_666_667;

/** Drive a promise to completion under fake timers. */
async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false;
  const wrapped = p.then(
    (v) => {
      done = true;
      return v;
    },
    (e) => {
      done = true;
      throw e;
    }
  );
  for (let i = 0; i < 800 && !done; i++) {
    await vi.advanceTimersByTimeAsync(250);
  }
  return wrapped;
}

const fitsTheWall = (calls: { opts: { budgetMs?: number } | undefined; at: number }[]) => {
  for (const c of calls) {
    expect(c.opts?.budgetMs, "every drain must carry a budget").toBeTypeOf("number");
    expect(c.opts!.budgetMs!).toBeGreaterThanOrEqual(DRAIN_FLOOR_MS);
    // started + budget must never cross the wall - THE invariant that was
    // missing: a fixed 40_000 started at t=29s or t=43s crossed it by miles.
    expect(c.at + c.opts!.budgetMs!, `drain started at +${c.at}ms with budget ${c.opts!.budgetMs}`).toBeLessThanOrEqual(
      WALL_MS
    );
  }
};

beforeEach(() => {
  vi.useFakeTimers();
  ctl.claims = [];
  ctl.dueIn = [];
  ctl.drainCostMs = 0;
  ctl.outbox = [];
  ctl.wakeups = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe("EXECUTED (F064): the tick's in-call budget is a wall over the WHOLE invocation", () => {
  it("the hop-retry sleep counts: a drain after a 29s wait gets what is LEFT, not 40s", async () => {
    // 1s into a chain window: the hop loses its claim, sleeps ~29.25s to the
    // next window, wins. That sleep used to happen before the clock started.
    ctl.t0 = WINDOW_START + 1_000;
    vi.setSystemTime(ctl.t0);
    ctl.claims = ["lost", "won"];
    ctl.dueIn = [null];
    const res = await settle(tickGet(new Request("http://localhost/api/wa/tick?token=tok&hop=1")));
    expect(res.status).toBe(200);
    expect((await res.json()).ran).toBe(true);
    expect(ctl.outbox).toHaveLength(1);
    expect(ctl.outbox[0].at).toBeGreaterThanOrEqual(29_000);
    fitsTheWall(ctl.outbox);
  });

  it("the wakeup drain is budgeted with the same remaining figure", async () => {
    ctl.t0 = WINDOW_START + 1_000;
    vi.setSystemTime(ctl.t0);
    ctl.claims = ["won", "won"];
    ctl.dueIn = [null];
    await settle(tickGet(new Request("http://localhost/api/wa/tick?token=tok&hop=0")));
    // THE ASSERTION THAT FAILED BEFORE: drainGraphWakeups(cb) with no options.
    expect(ctl.wakeups).toHaveLength(1);
    fitsTheWall(ctl.wakeups);
  });

  it("no fresh drain starts inside the last seconds of the wall", async () => {
    ctl.t0 = WINDOW_START + 1_000;
    vi.setSystemTime(ctl.t0);
    ctl.claims = ["won", "won"];
    // The first drain spends 42s. A row is then due in 500ms - inside the 3s
    // that remain, so the OLD loop slept for it and started another 40s
    // drain at t=43.5s.
    ctl.drainCostMs = 42_000;
    ctl.dueIn = [500, 500];
    const res = await settle(tickGet(new Request("http://localhost/api/wa/tick?token=tok&hop=0")));
    const body = await res.json();
    expect(body.ran).toBe(true);
    expect(ctl.outbox, "a second drain must not start with less than the floor left").toHaveLength(1);
    fitsTheWall(ctl.outbox);
    fitsTheWall(ctl.wakeups);
    // The row that was due is handed to the NEXT hop instead of being drained
    // past the wall - the chain continues, it does not die at the kill.
    expect(body.chained).toBe(true);
  });
});

describe("EXECUTED (F064): the reply dispatcher's budget is the same wall", () => {
  it("clips its drain to what remains and never starts one past the floor", async () => {
    ctl.t0 = WINDOW_START + 1_000;
    vi.setSystemTime(ctl.t0);
    ctl.claims = ["won"];
    ctl.drainCostMs = 42_000;
    ctl.dueIn = [500, 500];
    const res = await settle(
      replyTickGet(
        new Request("http://localhost/api/wa/reply-tick?token=tok&sender=traveller%40example.com&hop=0")
      )
    );
    const body = await res.json();
    expect(body.ran).toBe(true);
    expect(ctl.outbox).toHaveLength(1);
    fitsTheWall(ctl.outbox);
    expect(body.chained).toBe(true);
  });
});
