import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT F043: THE SUPERSEDE CLEANUP RAN UNBOUNDED, ON THE TRAVELLER'S OWN
// RETURN-FROM-CHECKOUT REQUEST, AND WROTE ITS RECORD LAST.
//
// A plan switch cancels the subscription it replaces. That cleanup awaited two
// TIMEOUT-FREE PayPal calls per prior activation AFTER the grant had already
// landed, and only then wrote the `subscription-superseded` row - the single
// record in the system that names a traveller who may now be billed twice. So a
// stalled PayPal turned a successful, already-granted upgrade into a request the
// platform killed, with nothing in the ledger to find the double charge by.
//
// The fix is not to detach the loop: after-work is raced against a budget and
// the container's CPU is throttled the instant the response flushes, so a
// detached cancel and its insert are abandoned together - the same loss. The
// record is therefore written FIRST, with an explicit pending outcome, and
// updated in place when PayPal answers.
//
// Executed against the real `confirmPaypalSubscription` over a Map-backed store
// and a stubbed global fetch.

interface EventRow {
  id: number;
  kind: string;
  user_email: string;
  detail: string;
}

const config = new Map<string, string>();
const events: EventRow[] = [];
let nextId = 1;

const addRows = (table: string, rows: Record<string, unknown>[]): EventRow[] => {
  if (table !== "agent_events") return [];
  return rows.map((r) => {
    const row: EventRow = {
      id: nextId++,
      kind: String(r.kind ?? ""),
      user_email: String(r.user_email ?? ""),
      detail: String(r.detail ?? ""),
    };
    events.push(row);
    return row;
  });
};

vi.mock("@/lib/runtime-config", () => ({
  getConfig: async (name: string) => config.get(name) ?? undefined,
  sbInsert: async (table: string, rows: Record<string, unknown>[]) => {
    addRows(table, rows);
    return true;
  },
  sbInsertReturning: async (table: string, rows: Record<string, unknown>[]) =>
    addRows(table, rows),
  sbUpdateReturning: async (
    table: string,
    filter: string,
    values: Record<string, unknown>
  ) => {
    if (table !== "agent_events") return [];
    const id = Number(/id=eq\.(\d+)/.exec(filter)?.[1] ?? 0);
    const row = events.find((e) => e.id === id);
    if (!row) return [];
    Object.assign(row, values);
    return [row];
  },
  sbSelect: async (table: string, query: string) => {
    if (table !== "agent_events") return [];
    const kind = /kind=eq\.([a-z-]+)/.exec(query)?.[1];
    const email = decodeURIComponent(/user_email=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    const like = decodeURIComponent(/detail=ilike\.\*([^*]+)\*/.exec(query)?.[1] ?? "");
    return events
      .filter((e) => (kind ? e.kind === kind : true))
      .filter((e) => (email ? e.user_email === email : true))
      .filter((e) => (like ? e.detail.includes(like) : true))
      .map((e) => ({ user_email: e.user_email, detail: e.detail }));
  },
}));

const planWrites: [string, string][] = [];
vi.mock("@/lib/access", () => ({
  setPlan: async (email: string, plan: string) => {
    planWrites.push([email, plan]);
    return true;
  },
}));

const BUYER = "switcher@example.com";
const OLD = "I-OLDPRO";
const NEW = "I-NEWULTRA";

const realFetch = globalThis.fetch;
const cancelCalls: string[] = [];

const jsonRes = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

const hang = (init: RequestInit | undefined) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) return reject(new Error("aborted"));
    signal.addEventListener("abort", () => reject(new Error("aborted")));
  });

/** PayPal, with the cancel leg under the test's control. */
function stubPaypal(opts: {
  oldStatus?: string;
  cancel: "ok" | "stall" | "error";
}) {
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/v1/oauth2/token")) {
      return jsonRes({ access_token: "T", expires_in: 3600 });
    }
    if (url.includes(`/${OLD}/cancel`)) {
      cancelCalls.push(OLD);
      if (opts.cancel === "stall") return hang(init);
      return jsonRes(null, opts.cancel === "ok" ? 204 : 500);
    }
    if (url.endsWith(`/subscriptions/${NEW}`)) {
      return jsonRes({ id: NEW, status: "ACTIVE", plan_id: "P-ULTRA" });
    }
    if (url.endsWith(`/subscriptions/${OLD}`)) {
      return jsonRes({ id: OLD, status: opts.oldStatus ?? "ACTIVE", plan_id: "P-PRO" });
    }
    return jsonRes({}, 404);
  }) as unknown as typeof fetch;
}

const supersededRows = () =>
  events
    .filter((e) => e.kind === "subscription-superseded")
    .map((e) => JSON.parse(e.detail) as Record<string, unknown>);

/**
 * Warm the module registry BEFORE fake timers are installed: the subject
 * resolves its collaborators through dynamic `import()`, and a cold resolution
 * needs real I/O that a fake clock cannot advance.
 */
const preload = async () => {
  await import("../paypal");
  await import("./subscription-link");
  await import("../access");
  await import("../after");
  return (await import("./confirm-subscription")).confirmPaypalSubscription;
};

const confirm = async () => {
  const confirmPaypalSubscription = await preload();
  return confirmPaypalSubscription({
    email: BUYER,
    subscriptionId: NEW,
    intendedPlan: "ultra",
    source: "redirect",
  });
};

beforeEach(() => {
  vi.resetModules();
  config.clear();
  events.length = 0;
  planWrites.length = 0;
  cancelCalls.length = 0;
  nextId = 1;
  config.set("PAYPAL_CLIENT_ID", "test-client-id");
  config.set("PAYPAL_CLIENT_SECRET", "test-secret");
  config.set("PAYPAL_PLAN_PRO", "P-PRO");
  config.set("PAYPAL_PLAN_ULTRA", "P-ULTRA");
  // The prior activation trail the cleanup reads.
  events.push({
    id: nextId++,
    kind: "subscription-activated",
    user_email: BUYER,
    detail: JSON.stringify({ subscriptionId: OLD, tier: "pro" }),
  });
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
});

describe("a plan switch records the superseded subscription before it can be lost", () => {
  it("a cancel PayPal confirms is recorded as cancelled, in ONE row", async () => {
    stubPaypal({ cancel: "ok" });
    const out = await confirm();
    expect(out.ok).toBe(true);
    expect(planWrites).toEqual([[BUYER, "ultra"]]);
    const rows = supersededRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subscriptionId: OLD, replacedBy: NEW, cancelled: true });
  });

  it("a cancel PayPal REFUSES is recorded as not cancelled - never optimistically", async () => {
    stubPaypal({ cancel: "error" });
    await confirm();
    const rows = supersededRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].cancelled).toBe(false);
  });

  it("an already-dead prior is not cancelled again, and says so", async () => {
    stubPaypal({ cancel: "ok", oldStatus: "CANCELLED" });
    await confirm();
    expect(cancelCalls).toEqual([]);
    const rows = supersededRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].cancelled).toBe(false);
    expect(String(rows[0].outcome)).toContain("inactive");
  });

  it("a STALLED cancel still answers the traveller, and still leaves the record", async () => {
    const confirmPaypalSubscription = await preload();
    vi.useFakeTimers();
    stubPaypal({ cancel: "stall" });

    const work = confirmPaypalSubscription({
      email: BUYER,
      subscriptionId: NEW,
      intendedPlan: "ultra",
      source: "redirect",
    });
    // The ledger AS THE TRAVELLER IS ANSWERED. On Cloud Run the container's CPU
    // is throttled the instant the response flushes, so anything not written by
    // this point is not written at all.
    let atAnswer: Record<string, unknown>[] = [];
    const raced = Promise.race([
      work.then((o) => {
        atAnswer = supersededRows();
        return o.ok ? "granted" : `refused:${o.status}`;
      }),
      new Promise<string>((r) => setTimeout(() => r("never-settled"), 120_000)),
    ]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await raced).toBe("granted");

    // The one row that names a possibly double-billed traveller is already
    // there, and says honestly that the outcome is not known.
    expect(atAnswer).toHaveLength(1);
    expect(atAnswer[0].subscriptionId).toBe(OLD);
    expect(atAnswer[0].replacedBy).toBe(NEW);
    expect(atAnswer[0].cancelled).toBeNull();
    expect(atAnswer[0].outcome).toBe("pending");
    // And it is one row, patched in place - never a second one.
    expect(supersededRows()).toHaveLength(1);
  });
});
