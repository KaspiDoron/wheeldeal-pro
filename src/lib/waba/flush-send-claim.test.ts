// AUDIT F058 (the dispatch half): the service-window flush was a read-then-act
// across a 12s network send, with no claim of any kind.
//
// onAgencyReplied reads heldLeadsFor(tail), checks `lead.state !== "held"` and
// then sends - and the state it checked only changes AFTER the send returns. So
// two overlapping deliveries for the same agency (Meta redelivers when the 200
// is slow, and a six-lead flush is six serial 12s-bounded sends, which is
// exactly a slow 200) both read the same held rows and both send. The agency
// gets two identical handoffs per traveller, seconds apart, on a rented,
// quality-rated business number. The template lane has had an atomic
// wa_send_claims slot for exactly this reason; the free-form lane had none.
//
// EXECUTED: two real flushes overlapping inside one send, over the Map-backed
// store whose wa_send_claims behaves like the unique index does.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/runtime-config", async () => {
  const h = await import("@/lib/privacy/postgrest-store.test-helper");
  return h.runtimeConfigMock();
});

import { store } from "@/lib/privacy/postgrest-store.test-helper";
import type { Lead } from "./leads";

const AGENCY = "66812345678";
const TAIL = "812345678";

const fetchCalls: string[] = [];
let gate: Promise<void> = Promise.resolve();
let openGate: () => void = () => {};

const RENDER = () => ({
  vehicle: "scooter",
  dates: "12 Aug for 4 days",
  freeformText: "Hey - got someone looking for a scooter, can you message them?",
  agencyName: "Sunrise Rentals",
  rfq: { vehicleClass: "scooter", durationDays: 4 },
  vendorId: "v1",
});

const heldLead = (id: number): Record<string, unknown> => ({
  id,
  state: "held",
  user_email: "traveller@example.com",
  agency_tail: TAIL,
  agency_number: AGENCY,
  agency_name: "Sunrise Rentals",
  link_token: `tok-abcdefghij${id}`,
  handed_off_at: null,
  created_at: new Date(Date.now() - 60_000).toISOString(),
});

beforeEach(() => {
  store.reset();
  fetchCalls.length = 0;
  gate = new Promise<void>((r) => {
    openGate = r;
  });
  vi.stubGlobal("fetch", async (url: unknown) => {
    fetchCalls.push(String(url));
    await gate; // the send is in flight - exactly the window the redelivery lands in
    return {
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: `wamid.${fetchCalls.length}` }] }),
    } as unknown as Response;
  });
  store.config.set("WABA_ENABLED", "on");
  store.config.set("WABA_BASE_URL", "https://example.test");
  store.config.set("WABA_API_KEY", "test-key");
  store.config.set("WABA_SENDER_ID", "sender");
  store.config.set("WABA_TEMPLATE_FIRST_CONTACT", "first_contact");
  store.config.set("WABA_LINK_BASE", "https://wheeldeal.test/h");
  store.config.set("WABA_DRY_RUN", "off");
  store.seed("waba_leads", [heldLead(1)]);
});

describe("EXECUTED (F058): a redelivered inbound cannot double-message the agency", () => {
  it("two overlapping flushes put ONE free-form message on the wire", async () => {
    const { onAgencyReplied } = await import("./dispatch");
    const first = onAgencyReplied(AGENCY, RENDER as unknown as (l: Lead) => ReturnType<typeof RENDER>);
    const second = onAgencyReplied(AGENCY, RENDER as unknown as (l: Lead) => ReturnType<typeof RENDER>);
    // Let both deliveries reach their send decision while the first is in flight.
    await new Promise((r) => setTimeout(r, 0));
    openGate();
    const [a, b] = await Promise.all([first, second]);
    expect(fetchCalls, "one held lead is one handoff, however often Meta redelivers").toHaveLength(1);
    expect(a.flushed + b.flushed).toBe(1);
  });

  it("a flush that did not send RELEASES its slot, so the lead is not stranded", async () => {
    // The claim must be conditional on a send actually happening. gcSendClaims
    // prunes non-msg slots only past 2h, so an unreleased slot would park a
    // still-held lead for two hours behind a send that never left - with only
    // rung 4's sweep to rescue it.
    store.config.set("KILL_SWITCH", "1");
    const { onAgencyReplied } = await import("./dispatch");
    openGate();
    const stopped = await onAgencyReplied(AGENCY, RENDER as unknown as (l: Lead) => ReturnType<typeof RENDER>);
    expect(stopped.flushed).toBe(0);
    expect(fetchCalls).toHaveLength(0);

    store.config.delete("KILL_SWITCH");
    const resumed = await onAgencyReplied(AGENCY, RENDER as unknown as (l: Lead) => ReturnType<typeof RENDER>);
    expect(resumed.flushed, "the lead must flush once the stop is lifted").toBe(1);
    expect(fetchCalls).toHaveLength(1);
  });
});
