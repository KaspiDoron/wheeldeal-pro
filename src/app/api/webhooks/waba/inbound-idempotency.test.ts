// AUDIT F058 (the webhook half): the WABA inbound webhook had no message-id
// idempotency at all.
//
// POST loops entries/changes and calls handleInbound(m) unconditionally, so a
// redelivery of the same inbound - Meta redelivers whenever the 200 is slow,
// and a multi-lead flush is several serial 12s-bounded sends - re-ran the
// held-lead flush from the top. wa_inbound_seen is already this repo's
// message-id dedupe table (wa/inbound-claim.ts) and is already registered in
// privacy/user-tables.ts; the WABA lane simply never used it.
//
// EXECUTED against the real POST, with the flush recorded at the module
// boundary. The gate sits on the MESSAGE path only: statuses (delivery, read,
// 131049) must not pay a claims round trip.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const rec = vi.hoisted(() => ({ flushes: [] as string[] }));

vi.mock("@/lib/runtime-config", async () => {
  const h = await import("@/lib/privacy/postgrest-store.test-helper");
  return h.runtimeConfigMock();
});
vi.mock("@/lib/waba/dispatch", () => ({
  onAgencyReplied: async (from: string) => {
    rec.flushes.push(from);
    return { opened: true, flushed: 1 };
  },
}));

import { store } from "@/lib/privacy/postgrest-store.test-helper";
import { POST } from "@/app/api/webhooks/waba/route";

const SECRET = "test-secret";
const AGENCY = "66812345678";

const delivery = (id: string) => ({
  entry: [
    {
      changes: [
        {
          value: {
            messages: [{ id, from: AGENCY, type: "text", text: { body: "yes we have scooters" } }],
          },
        },
      ],
    },
  ],
});

const statusDelivery = () => ({
  entry: [{ changes: [{ value: { statuses: [{ id: "wamid.OUT1", status: "delivered", recipient_id: AGENCY }] } }] }],
});

const post = (payload: unknown) =>
  POST(
    new Request("http://localhost/api/webhooks/waba", {
      method: "POST",
      headers: { "content-type": "application/json", "x-waba-secret": SECRET },
      body: JSON.stringify(payload),
    })
  );

beforeEach(() => {
  store.reset();
  rec.flushes.length = 0;
  store.config.set("WABA_ENABLED", "on");
  store.config.set("WABA_WEBHOOK_SECRET", SECRET);
});

describe("EXECUTED (F058): the WABA webhook is idempotent on the message id", () => {
  it("a redelivered inbound does no work the second time", async () => {
    const first = await post(delivery("wamid.IN1"));
    const second = await post(delivery("wamid.IN1"));
    expect(first.status).toBe(200);
    // Still a 200: a 4xx would make the provider retry the same delivery
    // forever, which is the failure this gate exists to absorb.
    expect(second.status).toBe(200);
    expect(rec.flushes, "one inbound is one flush, however often it is delivered").toHaveLength(1);
  });

  it("a genuinely new inbound from the same agency still flushes", async () => {
    await post(delivery("wamid.IN1"));
    await post(delivery("wamid.IN2"));
    expect(rec.flushes).toHaveLength(2);
  });

  it("statuses do not pay for the dedupe - the gate is on the message path", async () => {
    // delivered / read / 131049 arrive far more often than messages do, and
    // they are already write-once on their own columns.
    await post(statusDelivery());
    expect(store.rows("wa_inbound_seen")).toHaveLength(0);
    expect(rec.flushes).toHaveLength(0);
  });
});
