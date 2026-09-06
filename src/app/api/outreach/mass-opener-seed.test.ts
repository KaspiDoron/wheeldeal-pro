import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT F212: MASS OUTREACH OPENERS GOT ZERO CROSS-FLEET UNIQUENESS INPUT WHEN
// REDIS_URL WAS UNSET.
//
// ensureGloballyUnique has two layers: the in-process trigram compare against
// the caller's recent list, and the Redis signature window. The Redis layer is
// a documented no-op without REDIS_URL - the live Cloud Run shape - so the
// recent list IS the guard. The mass route seeded that list with `[]` and only
// ever pushed its own batch's openers onto it, so traveller B's 20-shop batch
// at 09:20 could not see one sentence of traveller A's batch at 09:00 over the
// same Canggu shops: matrix-compiled openers differing only by seed went to the
// same numbers from two travellers' phones through one egress IP. The
// single-shop route was given a real 6h/200-row fleet-wide read for exactly
// this (W-beta30); the bulk path, which sends 20-40x more, was not.
//
// EXECUTED against the real POST: the store is the Map-backed PostgREST
// stand-in seeded with the fleet's recent outbound bodies, the uniqueness gate
// is recorded at the module boundary, and the assertions read the recent list
// the route actually handed it.

const ctl = vi.hoisted(() => ({
  sender: "traveller@example.com",
  unique: [] as { text: string; recent: string[] }[],
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
  sendFromUser: async () => ({ ok: true, messageId: "3EB0" }),
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
vi.mock("@/lib/wa/thread-context", () => ({
  promisedRfq: async (_d: string, _e: string, rfq: unknown) => ({ rfq }),
}));
vi.mock("@/lib/wa-guard", () => ({
  guardOutbound: async (o: { text: string }) => ({ allow: true, text: o.text }),
  afterSend: async () => {},
  claimForSend: async () => ({ ok: false, kind: "pacing" }),
  releaseSendClaim: async () => {},
  humanizeForOutbound: (_s: string, _t: string, body: string) => body,
  effectiveHourlyCap: async () => 10,
  getPolicies: async () => ({ min_gap_seconds: 12, reply_gap_seconds: 5 }),
  newContactBudget: async () => ({
    remaining: 5,
    cap: 15,
    windowHours: 24,
    nextFreeAt: new Date(Date.now() + 60_000).toISOString(),
  }),
  introHoldIso: async () => new Date(Date.now() + 3600_000).toISOString(),
  introHoldReason: () => "introductions full",
}));
vi.mock("@/lib/cohort", () => ({ inCohort: async () => false }));
vi.mock("@/lib/graph/uniqueness", () => ({
  ensureGloballyUnique: async (text: string, recent: string[]) => {
    // Snapshot: the route keeps pushing onto the same array afterwards.
    ctl.unique.push({ text, recent: [...recent] });
    return { text, changed: false, maxOverlap: 0 };
  },
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
const FRESH_FLEET_OPENER = "Hello! Do you have an automatic scooter for 3 days from tomorrow? Best price per day?";
const STALE_FLEET_OPENER = "Yesterday's opener that fell out of the six hour window";
const INBOUND_TEXT = "250 per day, deposit 2000";

const askAllShops = (vendors: { id: string; name: string; whatsapp: string }[]) =>
  new Request("http://localhost/api/outreach/mass", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: "Hi! What is your best price per day for a scooter?",
      vendors,
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
  ctl.unique = [];
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  store.seed("whatsapp_messages", [
    // Another traveller's opener, 20 minutes ago - inside the 6h window.
    {
      id: 1,
      direction: "outbound",
      to_number: SHOP_A,
      body: FRESH_FLEET_OPENER,
      received_at: ago(20 * 60_000),
      raw: { sender: "other@example.com" },
    },
    // Outside the window: not part of the fleet's recent fingerprint.
    {
      id: 2,
      direction: "outbound",
      to_number: SHOP_B,
      body: STALE_FLEET_OPENER,
      received_at: ago(26 * 3600_000),
      raw: { sender: "other@example.com" },
    },
    // A shop's own words are never something we must differ from.
    {
      id: 3,
      direction: "inbound",
      from_number: SHOP_A,
      body: INBOUND_TEXT,
      received_at: ago(60_000),
      raw: { receiver: "other@example.com" },
    },
  ]);
});

describe("EXECUTED (F212): the mass path compares its openers against the fleet's recent sends", () => {
  it("the FIRST compile of a batch already sees another traveller's recent opener", async () => {
    const res = await POST(askAllShops([{ id: "v1", name: "Island Rentals", whatsapp: `+${SHOP_A}` }]));
    expect(res.status).toBe(200);
    expect(ctl.unique.length).toBeGreaterThanOrEqual(1);
    const first = ctl.unique[0];
    // THE ASSERTION THAT FAILED BEFORE: `compiledRecent` started as `[]`, so
    // the first compile of every batch compared against nothing at all.
    expect(first.recent, "the recent list must be seeded from the fleet").toContain(FRESH_FLEET_OPENER);
    // Bounded to the same 6h window the single-shop path and the engine use,
    // and to OUTBOUND rows only.
    expect(first.recent).not.toContain(STALE_FLEET_OPENER);
    expect(first.recent).not.toContain(INBOUND_TEXT);
  });

  it("the in-batch ledger still works on top of the seed", async () => {
    await POST(
      askAllShops([
        { id: "v1", name: "Island Rentals", whatsapp: `+${SHOP_A}` },
        { id: "v2", name: "Beach Bikes", whatsapp: `+${SHOP_B}` },
      ])
    );
    expect(ctl.unique.length).toBeGreaterThanOrEqual(2);
    const [first, second] = ctl.unique;
    expect(second.recent).toContain(first.text);
    expect(second.recent).toContain(FRESH_FLEET_OPENER);
  });

  it("an unreadable store degrades to the old in-batch behaviour, never blocks the batch", async () => {
    store.unavailable.add("whatsapp_messages");
    const res = await POST(askAllShops([{ id: "v1", name: "Island Rentals", whatsapp: `+${SHOP_A}` }]));
    expect(res.status).toBe(200);
    expect(ctl.unique.length).toBeGreaterThanOrEqual(1);
    expect(ctl.unique[0].recent).toEqual([]);
  });
});
