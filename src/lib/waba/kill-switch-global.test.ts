// AUDIT F200: the owner's GLOBAL emergency stop did not reach the
// company-number lane.
//
// KILL_SWITCH is enforced in six API routes and inside guardOutbound (the
// Evolution wire). sendForLead consulted only the WABA governor, whose one
// manual stop is WABA_KILL - so with the handoff armed and WABA_KILL unset, an
// owner pulling the Money tab's kill switch stopped the traveller wire while
// the service-window flush reached from the WABA webhook kept putting free-form
// messages on the rented business number. Two owner surfaces contradicted each
// other during an incident: the admin page said "All paid services and payments
// are PAUSED for every user" while the WABA console said "Sending allowed".
//
// EXECUTED against the real sendForLead: the stop is read from the vault, no
// fetch leaves the process, and the lead is HELD THROUGH holdLead so the flush
// and rung 4 can still release it once the owner lifts the stop.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/runtime-config", async () => {
  const h = await import("@/lib/privacy/postgrest-store.test-helper");
  return h.runtimeConfigMock();
});

import { store } from "@/lib/privacy/postgrest-store.test-helper";
import type { Lead } from "./leads";

const fetchCalls: string[] = [];

const lead = (over: Partial<Lead> = {}): Lead => ({
  id: 7,
  state: "held",
  user_email: "traveller@example.com",
  agency_tail: "812345678",
  agency_number: "66812345678",
  agency_name: "Sunrise Rentals",
  session_id: null,
  lane: null,
  link_token: "tok-abcdefghijkl",
  created_at: new Date().toISOString(),
  sent_at: null,
  agency_replied_at: null,
  traveller_inbound_at: null,
  handed_off_at: null,
  terminal_reason: null,
  ...over,
});

const INPUT = {
  vehicle: "scooter",
  dates: "12 Aug for 4 days",
  freeformText: "Hey - got someone looking for a scooter, can you message them?",
  agencyName: "Sunrise Rentals",
  rfq: { vehicleClass: "scooter", durationDays: 4 },
  vendorId: "v1",
};

const live = () => {
  store.config.set("WABA_ENABLED", "on");
  store.config.set("WABA_BASE_URL", "https://example.test");
  store.config.set("WABA_API_KEY", "test-key");
  store.config.set("WABA_SENDER_ID", "sender");
  store.config.set("WABA_TEMPLATE_FIRST_CONTACT", "first_contact");
  store.config.set("WABA_LINK_BASE", "https://wheeldeal.test/h");
  // The lane is genuinely live: a rehearsal would prove nothing here.
  store.config.set("WABA_DRY_RUN", "off");
};

beforeEach(() => {
  store.reset();
  fetchCalls.length = 0;
  vi.stubGlobal("fetch", async (url: unknown) => {
    fetchCalls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: "wamid.SENT" }] }),
    } as unknown as Response;
  });
  live();
  store.seed("waba_leads", [{ id: 7, state: "held", agency_tail: "812345678" }]);
});

describe("EXECUTED (F200): the global kill switch reaches the company-number lane", () => {
  it("KILL_SWITCH stops the service-window flush, and nothing leaves the process", async () => {
    store.config.set("KILL_SWITCH", "1");
    const { sendForLead } = await import("./dispatch");
    const out = await sendForLead(lead(), "freeform", INPUT);
    expect(out.outcome).toBe("held");
    expect(out.reason).toBe("kill-switch");
    expect(fetchCalls, "the rented number must be silent during an emergency stop").toHaveLength(0);
  });

  it("the stopped lead is HELD through holdLead, so it still has a way out", async () => {
    // killSwitchOn fails CLOSED on an unreadable vault, so a transient blip
    // must not drop a flush with no re-delivery ladder: the hold carries the
    // rung-4 payload exactly as every other hold does.
    store.config.set("KILL_SWITCH", "1");
    const { sendForLead } = await import("./dispatch");
    await sendForLead(lead({ state: "draft" }), "freeform", INPUT);
    const row = store.rows("waba_leads").find((r) => r.id === 7) as
      | { state?: string; fallback?: { text?: string } }
      | undefined;
    expect(row?.state).toBe("held");
    expect(row?.fallback?.text).toBe(INPUT.freeformText);
  });

  it("with the stop off the same flush sends - the guard is the switch, not the lane", async () => {
    const { sendForLead } = await import("./dispatch");
    const out = await sendForLead(lead(), "freeform", INPUT);
    expect(out.outcome).toBe("sent");
    expect(fetchCalls).toHaveLength(1);
  });

});
