// AUDIT F067 + F068 - WHICH keys the per-hunt reset actually clears.
//
// F067: SEARCH_FIELD_KEYS named "vehicleConfirmed", a fields key no writer in
// the tree ever writes. The durable latch is `vehicleConfirmation`, and it can
// never regress on its own (mergeVehicleConfirmation keeps a confirmed prev),
// so a scooter confirmed in hunt 1 was still presented as a VERIFIED vehicle
// for a car quote in hunt 2 - and its `askedAt` survived too, so the confirm
// question could never be asked again.
//
// F068: SEARCH_DIGEST_KEYS omitted `digest.comprehension`, the ONLY source the
// live engine projects firmCount / depositKnown from. A shop that said "last
// price" twice in hunt 1 opened hunt 2 unbargainable: policy sets
// firmAllowsBargain false at firmCount >= 2, from turn one, against a brand
// new opening quote. The same blob also carries genuinely SHOP-durable facts
// (depositKind, handoverMode, handoverCostKnown) which must survive.
//
// Both tests EXECUTE closeSearchSession against a Map-backed store and then
// read the persisted row back - and F068 feeds the surviving blob through the
// real digestFromStored + deriveThreadFacts projection.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

interface StoreRow {
  thread_key: string;
  user_email: string;
  vendor_id: string | null;
  vendor_name: string | null;
  to_number: string;
  phase: string;
  stage: string | null;
  stage_at: string | null;
  version: number;
  fields: Record<string, unknown>;
  node_runs: Record<string, number>;
  waiting_until: string | null;
  last_decision_id: string | null;
  updated_at: string;
}

const store = new Map<string, StoreRow>();

function keyOf(query: string): string {
  return decodeURIComponent(/thread_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
}
function versionOf(query: string): number | null {
  const m = /version=eq\.(\d+)/.exec(query);
  return m ? Number(m[1]) : null;
}
function applyUpdate(filter: string, values: Record<string, unknown>): StoreRow | null {
  const row = store.get(keyOf(filter));
  if (!row) return null;
  const want = versionOf(filter);
  if (want !== null && row.version !== want) return null;
  const clean = JSON.parse(JSON.stringify(values)) as Record<string, unknown>;
  const next = { ...row, ...clean } as StoreRow;
  store.set(next.thread_key, next);
  return next;
}

vi.mock("./runtime-config", () => ({
  sbSelect: async (table: string, query: string) => {
    if (table !== "negotiation_threads") return [];
    const key = /thread_key=eq\./.test(query) ? keyOf(query) : null;
    const email = decodeURIComponent(/user_email=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    return [...store.values()]
      .filter((r) => (key ? r.thread_key === key : r.user_email === email))
      .map((r) => JSON.parse(JSON.stringify(r)) as StoreRow);
  },
  sbInsert: async () => true,
  sbUpdate: async (table: string, filter: string, values: Record<string, unknown>) =>
    table === "negotiation_threads" ? applyUpdate(filter, values) !== null : false,
  sbUpdateReturning: async (table: string, filter: string, values: Record<string, unknown>) => {
    if (table !== "negotiation_threads") return [];
    const row = applyUpdate(filter, values);
    return row ? [JSON.parse(JSON.stringify(row))] : [];
  },
  sbDelete: async () => true,
  sbDeleteReturning: async () => [],
}));

vi.mock("./wa/cancellations", () => ({
  cancelSends: async () => true,
  pruneCancellations: async () => true,
}));

import { closeSearchSession } from "./session-close";
import { digestFromStored } from "./spte/digest";
import { deriveThreadFacts } from "./spte/thread-facts";

const EMAIL = "traveller@example.com";
const KEY = `${EMAIL}:66812345678`;

function seed(fields: Record<string, unknown>): void {
  store.set(KEY, {
    thread_key: KEY,
    user_email: EMAIL,
    vendor_id: "v1",
    vendor_name: "Shop X",
    to_number: "66812345678",
    phase: "negotiating",
    stage: "negotiating",
    stage_at: new Date(Date.now() - 120_000).toISOString(),
    version: 4,
    fields: { firmCount: 2, toneDegraded: false, rounds: 3, ...fields },
    node_runs: {},
    waiting_until: null,
    last_decision_id: null,
    updated_at: new Date(Date.now() - 60_000).toISOString(),
  });
}

const closeNow = () =>
  closeSearchSession(EMAIL, { fromMs: Date.now() - 3600_000, beforeMs: Date.now() });

beforeEach(() => {
  store.clear();
});

describe("closeSearchSession clears the per-hunt vehicle latch (F067)", () => {
  it("deletes fields.vehicleConfirmation and keeps the shop-durable half", async () => {
    seed({
      vehicleConfirmation: {
        status: "confirmed",
        askedAt: "2026-01-01T00:00:00.000Z",
        evidence: "shop named the model",
      },
      // Genuinely durable facts about the SHOP - the close promises to keep these.
      language: { mode: "english", reason: "shop-asked" },
      tone: "warm",
      accessories: ["helmet"],
      transport: "evolution",
    });

    await closeNow();

    const f = store.get(KEY)!.fields;
    expect(f.vehicleConfirmation).toBeUndefined();
    expect((f.language as { mode?: string } | undefined)?.mode).toBe("english");
    expect(f.tone).toBe("warm");
    expect(f.accessories).toEqual(["helmet"]);
    expect(f.transport).toBe("evolution");
  });
});

describe("closeSearchSession clears the per-hunt comprehension (F068)", () => {
  it("drops the per-hunt verdicts, keeps the shop-durable facts", async () => {
    seed({
      digest: {
        facts: ["deposit is passport"],
        quotedPricePerDay: 300,
        round: 3,
        comprehension: {
          firmTurns: 2,
          depositStated: true,
          declined: true,
          deflected: true,
          closed: true,
          // Durable across hunts: what this shop's policy IS.
          depositKind: "cash",
          handoverMode: "delivery",
          handoverCostKnown: true,
        },
        lastAskPerDay: 260,
        recapSent: true,
        recapSentAt: 1_700_000_000_000,
        recapConfirmedAt: 1_700_000_100_000,
        recapAmended: true,
        oweWatchArmed: true,
      },
    });

    await closeNow();

    const digest = store.get(KEY)!.fields.digest as Record<string, unknown>;
    const comp = digest.comprehension as Record<string, unknown> | undefined;
    expect(comp?.firmTurns).toBeUndefined();
    expect(comp?.depositStated).toBeUndefined();
    expect(comp?.declined).toBeUndefined();
    expect(comp?.deflected).toBeUndefined();
    expect(comp?.closed).toBeUndefined();
    // ...while what the shop told us about ITSELF survives the new search.
    expect(comp?.depositKind).toBe("cash");
    expect(comp?.handoverMode).toBe("delivery");
    expect(comp?.handoverCostKnown).toBe(true);
    // The other once-per-negotiation latches die with the hunt too.
    expect(digest.lastAskPerDay).toBeUndefined();
    expect(digest.recapSent).toBeUndefined();
    expect(digest.recapSentAt).toBeUndefined();
    expect(digest.recapConfirmedAt).toBeUndefined();
    expect(digest.recapAmended).toBeUndefined();
    expect(digest.oweWatchArmed).toBeUndefined();
  });

  it("projects firmCount 0 and depositKnown false on the next hunt's first turn", async () => {
    seed({
      digest: {
        facts: [],
        comprehension: {
          firmTurns: 2,
          depositStated: true,
          handoverMode: "delivery",
          handoverCostKnown: true,
        },
      },
    });

    await closeNow();

    const stored = digestFromStored((store.get(KEY)!.fields.digest as unknown) ?? null);
    const facts = deriveThreadFacts({ outbound: [], comprehension: stored.comprehension });
    expect(facts.firmCount).toBe(0);
    expect(facts.depositKnown).toBe(false);
    // The handover the shop stated is a fact about the shop, not about the hunt.
    expect(facts.fulfillmentKnown).toBe(true);
  });
});
