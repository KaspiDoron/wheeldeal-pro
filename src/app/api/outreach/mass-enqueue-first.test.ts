import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT A1: ENQUEUE-FIRST OUTREACH - THE MASS TAP DISPATCHED BEFORE IT QUEUED.
//
// /api/outreach/mass walks its vendors in one loop. The FIRST sendable shop
// takes slot 0 and is dispatched live inside that first iteration - the guard,
// the atomic claim and a real Evolution round trip - and only AFTER that does
// the loop reach shops 2..N and write their durable wa_outbox rows.
//
// So the whole batch hung behind one live send. If the request died while that
// send was in flight (a client abort, the Cloud Run request ceiling, a wedged
// WhatsApp host), every remaining shop was never queued: no row, no drain, no
// error - the traveller saw a hunt that had simply stopped. RUNBOOK problem 17
// records this as "enqueue-first outreach: never built".
//
// The fix is an ordering one, and only an ordering one: the loop enqueues every
// parked shop first, and the immediate dispatch runs after the queue is durable.
// Opener compile and localization STAY at enqueue time (the drain delivers
// parked bodies verbatim - `alreadyHumanized` - so re-running the persona pass
// at drain would mutate the text and change the idempotency slot hash).
//
// Executed against the REAL route with the Map-backed PostgREST stand-in.

const ctl = vi.hoisted(() => ({
  sender: "traveller@example.com",
  /** Held open to model a request that dies while the live send is in flight. */
  sendGate: null as Promise<void> | null,
  /** How many wa_outbox rows existed when the immediate send was guarded. */
  queuedAtGuard: -1,
  sends: [] as string[],
}));

vi.mock("@/lib/runtime-config", async () => {
  const h = await import("@/lib/privacy/postgrest-store.test-helper");
  return h.runtimeConfigMock();
});
vi.mock("@/lib/session", () => ({
  getSession: async () => ({ email: ctl.sender, plan: "pro" }),
}));
vi.mock("@/lib/agents", () => ({
  runSafety: async () => ({ allowed: true }),
  localizeMessage: async (text: string) => ({ text, localized: false, reason: "english-region" }),
}));
vi.mock("@/lib/whatsapp", () => ({
  sendWhatsApp: async () => ({ ok: false, channel: "none" }),
  whatsappConfigured: async () => false,
}));
vi.mock("@/lib/evolution", () => ({
  evolutionConfigured: async () => true,
  hasSessionRow: async () => true,
  ensureConnected: async () => "open",
  sendFromUser: async (_email: string, digits: string) => {
    if (ctl.sendGate) await ctl.sendGate;
    ctl.sends.push(digits);
    return { ok: true, messageId: "3EB0" };
  },
  webhookToken: async () => null,
}));
vi.mock("@/lib/google", () => ({ placeDetails: async () => null }));
vi.mock("@/lib/usage", () => ({ killSwitchOn: async () => false }));
vi.mock("@/lib/entitlements", () => ({
  can: () => true,
  localLanguageAllowed: () => false,
}));
vi.mock("@/lib/wa/outbox-columns", () => ({
  outboxToKeyPatch: async (digits: string) => ({ to_key: digits }),
}));
vi.mock("@/lib/wa/outbox-lifecycle", () => ({ recordOutboundAnchor: async () => true }));
vi.mock("@/lib/wa/thread-context", () => ({
  promisedRfq: async (_d: string, _e: string, rfq: unknown) => ({ rfq }),
}));
vi.mock("@/lib/wa-guard", async () => {
  const h = await import("@/lib/privacy/postgrest-store.test-helper");
  return {
    guardOutbound: async (o: { text: string }) => {
      // THE MEASUREMENT: how much of the batch was durable when the one live
      // send of this request was about to leave.
      ctl.queuedAtGuard = h.store.rows("wa_outbox").length;
      return { allow: true, text: o.text };
    },
    afterSend: async () => {},
    claimForSend: async () => ({ ok: true }),
    releaseSendClaim: async () => {},
    humanizeForOutbound: (_s: string, _t: string, body: string) => body,
    effectiveHourlyCap: async () => 10,
    getPolicies: async () => ({ min_gap_seconds: 12, reply_gap_seconds: 5 }),
    newContactBudget: async () => ({
      remaining: 10,
      cap: 15,
      windowHours: 24,
      nextFreeAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    introHoldIso: async () => new Date(Date.now() + 3600_000).toISOString(),
    introHoldReason: () => "introductions full",
  };
});
vi.mock("@/lib/cohort", () => ({ inCohort: async () => false }));
vi.mock("@/lib/graph/uniqueness", () => ({
  ensureGloballyUnique: async (text: string) => ({ text }),
}));
vi.mock("@/lib/wa/cancellations", () => ({ clearCancellation: async () => true }));
vi.mock("@/lib/wa/transports", () => ({
  resolveTransport: async () => ({ transport: { kind: "evolution" } }),
}));
vi.mock("@/lib/funnel/stages", () => ({ advanceThreadStage: async () => true }));
vi.mock("@/lib/request-origin", () => ({ selfKickOrigin: async () => "http://localhost" }));
vi.mock("@/lib/wa/kick", () => ({ kickDispatcher: async () => {} }));

import { store } from "@/lib/privacy/postgrest-store.test-helper";
import { POST } from "@/app/api/outreach/mass/route";

const SHOP_A = "66812345678";
const SHOP_B = "66823456789";
const SHOP_C = "66834567890";

const askThreeShops = () =>
  new Request("http://localhost/api/outreach/mass", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: "Hi! What is your best price per day for a scooter?",
      vendors: [
        { id: "v1", name: "Island Rentals", whatsapp: `+${SHOP_A}` },
        { id: "v2", name: "Beach Bikes", whatsapp: `+${SHOP_B}` },
        { id: "v3", name: "Sunset Scooters", whatsapp: `+${SHOP_C}` },
      ],
      rfq: {
        vehicleClass: "scooter",
        transmission: "automatic",
        durationDays: 3,
        accessories: [],
        fulfillment: "pickup",
      },
      region: "Thailand",
    }),
  });

beforeEach(() => {
  store.reset();
  ctl.sendGate = null;
  ctl.queuedAtGuard = -1;
  ctl.sends = [];
});

describe("EXECUTED (A1): the mass tap enqueues the batch before it dispatches", () => {
  it("every parked shop is already durable when the immediate send is guarded", async () => {
    const res = await POST(askThreeShops());
    expect(res.status).toBe(200);
    // THE ASSERTION THAT FAILED BEFORE: the guard for shop 1 ran in the first
    // loop iteration, with zero rows written - shops 2 and 3 did not exist
    // anywhere durable yet.
    expect(
      ctl.queuedAtGuard,
      "the other shops must be queued BEFORE the live send is attempted"
    ).toBe(2);
    expect(store.rows("wa_outbox").map((r) => r.to_number).sort()).toEqual(
      [SHOP_B, SHOP_C].sort()
    );
  });

  it("a request that dies mid-send leaves the rest of the hunt queued, not lost", async () => {
    let release!: () => void;
    ctl.sendGate = new Promise<void>((r) => {
      release = r;
    });
    // Not awaited: the request is still inside the live send, exactly where a
    // client abort or the Cloud Run ceiling would cut it off.
    const pending = POST(askThreeShops());
    await vi.waitFor(
      () => {
        expect(store.rows("wa_outbox").map((r) => r.to_number).sort()).toEqual(
          [SHOP_B, SHOP_C].sort()
        );
      },
      { timeout: 3000, interval: 10 }
    );
    // Nothing has been sent yet - the queue is durable first, on purpose.
    expect(ctl.sends).toEqual([]);
    release();
    await pending;
  });

  it("REGRESSION: the immediate send still happens, in vendor order, reported honestly", async () => {
    const res = await POST(askThreeShops());
    const body = await res.json();
    expect(body.results.map((r: { id: string }) => r.id)).toEqual(["v1", "v2", "v3"]);
    expect(body.results[0].sent).toBe(true);
    expect(body.results[1].queued).toBe(true);
    expect(body.results[2].queued).toBe(true);
    expect(body.sent).toBe(1);
    expect(body.queued).toBe(2);
    expect(ctl.sends).toEqual([SHOP_A]);
  });

  it("REGRESSION: parked rows keep their staggered not_before, never a due-now flood", async () => {
    const before = Date.now();
    await POST(askThreeShops());
    for (const row of store.rows("wa_outbox")) {
      // The 8s per-recipient hard floor is the minimum any parked row may carry.
      expect(Date.parse(String(row.not_before))).toBeGreaterThanOrEqual(before + 8000);
    }
  });
});
