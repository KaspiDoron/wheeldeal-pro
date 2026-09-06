import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "crypto";

vi.mock("server-only", () => ({}));

// AUDIT F254: THE META WEBHOOK'S WAKEUP DRAIN WAS UNSCOPED, UNBUDGETED, AND
// PUT EVERY DRAINED TRAVELLER'S NEGOTIATION TURN ON THE COMPANY NUMBER.
//
// The tail of the Cloud API webhook called `drainGraphWakeups` with NO options
// - so the SELECT was `graph_wakeups?not_before=lte.now&limit=24` across the
// whole fleet and one inbound webhook could claim up to 24 OTHER travellers'
// due strategic-wait ticks and run their full multi-agent composes inside a
// stranger's request - and with a send callback that dropped the wakeup's own
// senderKey and posted through `sendWhatsApp`, the shared WHATSAPP_PHONE_
// NUMBER_ID. Traveller B's next bargain left on the company number instead of
// B's own linked wire, which the transport contract forbids ("the reply leg is
// always the traveller's own wire"). No budget, either: DrainWakeupOptions had
// only `userEmail`, so there was not even a way to bound it here.
//
// The fix mirrors the Evolution webhook tail (wa/ingest.ts): one drain per
// receiver this delivery actually resolved, scoped by `userEmail`, bounded by
// `budgetMs`, and sending through `sendFromUser(senderKey, ...)` so a wakeup
// always leaves on its owner's wire. resolveTransport cannot pick the Cloud
// sender by design (transports/index.ts keeps "cloud" out of the adapter set),
// and the evolution adapter IS sendFromUser - so the drain calls it directly,
// exactly as every other drain does.
//
// EXECUTED against the real POST: a signed delivery, the Map-backed store
// holding the outbound row that attributes the shop to its traveller, and the
// drain recorded at the module boundary together with the callback it was
// handed.

const rec = vi.hoisted(() => ({
  drains: [] as { send: unknown; opts: unknown }[],
  sendFromUser: [] as unknown[][],
  sendWhatsApp: [] as unknown[][],
  processed: [] as unknown[],
}));

vi.mock("@/lib/runtime-config", async () => {
  const h = await import("@/lib/privacy/postgrest-store.test-helper");
  return h.runtimeConfigMock();
});
vi.mock("@/lib/agent-loop", () => ({
  processVendorReply: async (o: unknown) => {
    rec.processed.push(o);
  },
}));
vi.mock("@/lib/drill", () => ({ isVendorThread: async () => true }));
vi.mock("@/lib/wa/inbound-claim", () => ({
  claimInboundStore: async () => true,
  releaseInboundStore: async () => true,
}));
vi.mock("@/lib/whatsapp", () => ({
  sendWhatsApp: async (...args: unknown[]) => {
    rec.sendWhatsApp.push(args);
    return { ok: true, channel: "cloud-api" };
  },
  whatsappConfigured: async () => true,
}));
vi.mock("@/lib/evolution", () => ({
  sendFromUser: async (...args: unknown[]) => {
    rec.sendFromUser.push(args);
    return { ok: true, messageId: "3EB0" };
  },
  // null token -> the kick block stands down; the drain is what is under test.
  webhookToken: async () => null,
}));
vi.mock("@/lib/wa-guard", () => ({
  drainOutbox: async () => 0,
  afterSend: async () => {},
}));
vi.mock("@/lib/graph/engine", () => ({
  drainGraphWakeups: async (send: unknown, opts: unknown) => {
    rec.drains.push({ send, opts });
    return 0;
  },
}));

import { store } from "@/lib/privacy/postgrest-store.test-helper";
import { POST } from "@/app/api/webhooks/whatsapp/route";

const SECRET = "test-secret";
const SHOP = "66812345678";
const RECEIVER = "traveller@example.com";

const signed = (payload: unknown) => {
  const raw = JSON.stringify(payload);
  const sig = "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex");
  return new Request("http://localhost/api/webhooks/whatsapp", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": sig },
    body: raw,
  });
};

const delivery = () => ({
  entry: [
    {
      changes: [
        {
          value: {
            metadata: { phone_number_id: "1234567890" },
            messages: [{ id: "wamid.HBgL1", from: SHOP, type: "text", text: { body: "250 per day" } }],
          },
        },
      ],
    },
  ],
});

type Send = (senderKey: string, to: string, text: string, lane?: "intro" | "reply") => Promise<unknown>;
type Opts = { userEmail?: string; budgetMs?: number } | undefined;

beforeEach(() => {
  store.reset();
  rec.drains.length = 0;
  rec.sendFromUser.length = 0;
  rec.sendWhatsApp.length = 0;
  rec.processed.length = 0;
  store.config.set("WHATSAPP_APP_SECRET", SECRET);
  // The outbound row that attributes this shop's reply to its traveller.
  store.seed("whatsapp_messages", [
    {
      id: 1,
      direction: "outbound",
      to_number: SHOP,
      body: "Hi! Do you have a scooter for 3 days?",
      received_at: new Date(Date.now() - 3600_000).toISOString(),
      raw: { sender: RECEIVER },
    },
  ]);
});

describe("EXECUTED (F254): the Meta webhook's wakeup drain is scoped, budgeted and on the owner's wire", () => {
  it("drains ONLY the receiver this delivery resolved, under a budget", async () => {
    const res = await POST(signed(delivery()));
    expect(res.status).toBe(200);
    // The inline reply ran for the resolved traveller (sanity: attribution worked).
    expect(rec.processed).toHaveLength(1);
    expect((rec.processed[0] as { senderEmail?: string }).senderEmail).toBe(RECEIVER);

    expect(rec.drains.length).toBeGreaterThanOrEqual(1);
    for (const d of rec.drains) {
      const opts = d.opts as Opts;
      // THE ASSERTION THAT FAILED BEFORE: `drainGraphWakeups(cb)` with no
      // options - a fleet-wide, unbounded drain inside one shop's webhook.
      expect(opts?.userEmail, "the drain must be scoped to the receiver").toBe(RECEIVER);
      expect(opts?.budgetMs, "the drain must carry its own deadline").toBeGreaterThanOrEqual(5_000);
      expect(opts?.budgetMs).toBeLessThanOrEqual(8_000);
    }
  });

  it("the send it hands the drain leaves on the wakeup's OWN sender, never the company number", async () => {
    await POST(signed(delivery()));
    expect(rec.drains.length).toBeGreaterThanOrEqual(1);
    const send = rec.drains[0].send as Send;
    // A wakeup for a different traveller than the one this webhook resolved
    // must still leave on ITS owner's wire.
    await send("other@example.com", "66898765432", "Could you do 220 for the three days?", "reply");
    expect(rec.sendWhatsApp, "a wakeup must not post through the shared Cloud number").toHaveLength(0);
    expect(rec.sendFromUser).toHaveLength(1);
    const [senderKey, to, text, fast, extra] = rec.sendFromUser[0] as [string, string, string, boolean, { lane?: string }];
    expect(senderKey).toBe("other@example.com");
    expect(to).toBe("66898765432");
    expect(text).toBe("Could you do 220 for the three days?");
    // fast=true, lane forwarded - the shape every other drain uses.
    expect(fast).toBe(true);
    expect(extra?.lane).toBe("reply");
  });

  it("a delivery that resolved NO receiver drains nothing at all", async () => {
    store.reset();
    store.config.set("WHATSAPP_APP_SECRET", SECRET);
    const res = await POST(signed(delivery()));
    expect(res.status).toBe(200);
    expect(rec.processed).toHaveLength(0);
    // Before: an unattributed delivery still ran the whole fleet's wakeups.
    expect(rec.drains).toHaveLength(0);
  });
});
