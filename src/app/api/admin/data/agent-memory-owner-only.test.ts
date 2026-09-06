import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT F172: agent_training WAS NOT ownerOnly IN THE DATA TAB.
//
// The route's own docblock says tables carrying message TEXT are owner-only,
// and marks vendor_replies, bargain_drafts, whatsapp_messages and wa_outbox.
// agent_training sat two lines below whatsapp_messages with no flag - while
// the Ops Center writes `[OPS-EXEMPLAR ...] Agent: ... Shop: ...` rows into
// it, built verbatim from a traveller's whatsapp_messages bodies. So a
// runtime-promoted admin was refused the transcript on one row and handed it
// on the next. Executed against the real route over a Map-backed store.

const session: { role: "admin" | "owner" } = { role: "admin" };

vi.mock("@/lib/session", () => ({
  requireManagement: async () => ({
    email: "someone@example.com",
    role: session.role,
    plan: "ultra",
    issuedAt: 0,
  }),
}));

vi.mock("@/lib/runtime-config", async () => {
  const h = await import("@/lib/privacy/postgrest-store.test-helper");
  return h.runtimeConfigMock();
});

import { store } from "@/lib/privacy/postgrest-store.test-helper";
import { GET } from "./route";

const EXCHANGE = "Shop: 250 baht per day, helmet included";

const get = (query = "") => GET(new Request(`http://local/api/admin/data${query}`));

beforeEach(() => {
  store.reset();
  session.role = "admin";
  store.seed("agent_training", [
    {
      id: 1,
      text: `[OPS-EXEMPLAR 2026-09-02] Owner-approved negotiation with Sunrise Rentals:\nAgent: hi\n${EXCHANGE}`,
      note: "Bookmarked in the Ops Center",
      source: "ops-exemplar",
      added_by: "owner@example.com",
      created_at: "2026-09-02T10:00:00.000Z",
    },
  ]);
});

describe("EXECUTED (F172): Agent memory is owner-only in the Data tab", () => {
  it("a non-owner admin asking for the rows is refused with the existing owner-only 403", async () => {
    const res = await get("?table=agent_training");
    // THE ASSERTION THAT FAILED BEFORE: the row path answered 200 with the
    // verbatim exchange.
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toContain("Conversation content is owner-only");
    expect(text).not.toContain(EXCHANGE);
  });

  it("the listing still shows that admin the COUNT, marked locked (a number is not a transcript)", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tables: { name: string; count: number | null; ownerOnly: boolean }[];
    };
    const row = body.tables.find((t) => t.name === "agent_training");
    expect(row?.count).toBe(1);
    expect(row?.ownerOnly).toBe(true);
  });

  it("the owner reads the rows as before", async () => {
    session.role = "owner";
    const res = await get("?table=agent_training");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: { text: string }[] };
    expect(body.rows[0]?.text).toContain(EXCHANGE);
    const listing = (await (await get()).json()) as { tables: { name: string; ownerOnly: boolean }[] };
    expect(listing.tables.find((t) => t.name === "agent_training")?.ownerOnly).toBe(false);
  });
});
