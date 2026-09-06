import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT F015: MASS OUTREACH REPORTED "queued" FOR A PARK WHOSE INSERT IT NEVER
// READ.
//
// In the claim-lost branch the wa_outbox insert was `await sbInsert(...).catch(
// () => {})` - and sbInsert never throws, it returns false - so the boolean was
// the only signal and it was thrown away. The route then stamped the funnel
// `contact_queued` and answered `queued: true, queuedUntil: now + 60s` for
// every shop, including one whose row never landed (an 8s timedFetch abort, a
// 5xx, or the pending-auto unique index). The card said "sending in about a
// minute" over a row that did not exist, no drain could ever send it, and the
// ledger asserted a queue that was not there. The sibling branch eighty lines
// up in the same file had always read the same insert honestly.
//
// Executed against the REAL route: every collaborator is stubbed at the module
// boundary, the store is the Map-backed PostgREST stand-in, and the assertions
// read the route's JSON and the funnel stamps it issued. No retry is added (the
// refuter's concern: a per-shop retry is another 8s wait per failing shop in a
// 40-shop loop) - the honest report is the zero-cost half.

const ctl = vi.hoisted(() => ({
  sender: "traveller@example.com",
  claim: { ok: false, kind: "pacing" } as { ok: boolean; kind?: string },
  stages: [] as { stage: string; to: string; note: string }[],
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
  claimForSend: async () => ctl.claim,
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
  ensureGloballyUnique: async (text: string) => ({ text }),
}));
vi.mock("@/lib/wa/cancellations", () => ({ clearCancellation: async () => true }));
vi.mock("@/lib/wa/transports", () => ({
  resolveTransport: async () => ({ transport: { kind: "evolution" } }),
}));
vi.mock("@/lib/funnel/stages", () => ({
  advanceThreadStage: async (k: { toNumber: string }, stage: string, note: string) => {
    ctl.stages.push({ stage, to: k.toNumber, note });
    return true;
  },
}));
vi.mock("@/lib/request-origin", () => ({ selfKickOrigin: async () => "http://localhost" }));
vi.mock("@/lib/wa/kick", () => ({ kickDispatcher: async () => {} }));

import { readFileSync } from "fs";
import { join } from "path";
import { store } from "@/lib/privacy/postgrest-store.test-helper";
import { POST } from "@/app/api/outreach/mass/route";

const SHOP = "66812345678";

const askAllShops = () =>
  new Request("http://localhost/api/outreach/mass", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: "Hi! What is your best price per day for a scooter?",
      vendors: [{ id: "v1", name: "Island Rentals", whatsapp: `+${SHOP}` }],
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
  ctl.stages = [];
  ctl.claim = { ok: false, kind: "pacing" };
});

describe("EXECUTED (F015): the claim-lost park reports what actually happened", () => {
  it("a park whose insert FAILED is answered queue-unavailable, and the ledger is not stamped", async () => {
    store.failWrites.add("wa_outbox");
    const res = await POST(askAllShops());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(1);
    const r = body.results[0];
    // THE ASSERTION THAT FAILED BEFORE: `queued: true, queuedUntil: <now+60s>,
    // reason: "queued"` over a row that does not exist.
    expect(r.queued).toBe(false);
    expect(r.queuedUntil).toBeUndefined();
    expect(r.reason).toBe("queue-unavailable");
    expect(r.sent).toBe(false);
    expect(store.rows("wa_outbox")).toHaveLength(0);
    // The funnel ledger is the truth: a queue that does not exist is not
    // asserted. `selected` (intent) is still stamped; `contact_queued` is not.
    expect(ctl.stages.map((s) => s.stage)).toContain("selected");
    expect(ctl.stages.map((s) => s.stage)).not.toContain("contact_queued");
    // The response's top-line count agrees with the per-shop truth.
    expect(body.queued).toBe(0);
  });

  it("a park that LANDED is still reported queued, with its time, and the ledger stamped", async () => {
    const res = await POST(askAllShops());
    expect(res.status).toBe(200);
    const body = await res.json();
    const r = body.results[0];
    expect(r.queued).toBe(true);
    expect(typeof r.queuedUntil).toBe("string");
    expect(r.reason).toBe("queued");
    expect(r.queuedReason).toBe("human pacing gap");
    expect(store.rows("wa_outbox")).toHaveLength(1);
    expect(store.rows("wa_outbox")[0].to_number).toBe(SHOP);
    expect(ctl.stages.map((s) => s.stage)).toContain("contact_queued");
    expect(body.queued).toBe(1);
  });

  it("a duplicate claim loss parks under batch-spacing, and is honest about the row the same way", async () => {
    ctl.claim = { ok: false, kind: "duplicate" };
    store.failWrites.add("wa_outbox");
    const res = await POST(askAllShops());
    const r = (await res.json()).results[0];
    expect(r.queued).toBe(false);
    expect(r.reason).toBe("queue-unavailable");
    expect(ctl.stages.map((s) => s.stage)).not.toContain("contact_queued");
  });
});

describe("the single-shop route's claim-lost park is honest the same way (source pin)", () => {
  // /api/outreach is not executed here (its harness would be a second file
  // this size); the guarantee AND the absence of the unguarded shape are
  // pinned at the source instead.
  const code = readFileSync(join(process.cwd(), "src/app/api/outreach/route.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const branch = code.slice(
    code.indexOf("const notBefore = jitteredHold(Date.now(), 1, 2);"),
    code.indexOf('queuedReason: claim.kind === "pacing" ? "human pacing gap" : "sync-retry",')
  );

  it("reads the park's boolean and answers queue-unavailable when the row did not land", () => {
    expect(branch).toMatch(/const parked = await sbInsert\("wa_outbox"/);
    expect(branch).toMatch(/if \(parked && kind === "rfq"\)/);
    expect(branch).toMatch(/reason: "queue-unavailable"/);
    // The discard that made the report a lie must not come back.
    expect(branch).not.toMatch(/\]\)\.catch\(\(\) => \{\}\);/);
  });
});
