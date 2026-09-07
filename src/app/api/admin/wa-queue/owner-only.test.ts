import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT F163: wa-queue SERVED wa_outbox MESSAGE BODIES TO ANY ADMIN, WHILE
// admin/data MARKS THE SAME TABLE OWNER-ONLY.
//
// The Command tab renders the queue panel for every management session, and
// GET here shipped the first 90 characters of every queued outbound message
// plus the shop's number, fleet-wide. The Data tab refuses that same admin
// the same table with "Conversation content is owner-only". The queue view
// stays management-visible - the parking reason, due state and lapsed claim
// are real ops signal - but the text and the recipient number are the
// owner's. Executed against the real route over a Map-backed store.

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
vi.mock("@/lib/wa-guard", () => ({ drainOutbox: async () => 0 }));
vi.mock("@/lib/evolution", () => ({ sendFromUser: async () => ({ ok: false }) }));

import { store } from "@/lib/privacy/postgrest-store.test-helper";
import { GET } from "./route";

const BODY =
  "Hi! We saw 250/day at another shop for the same Click 125i - could you do 240 for 5 days?";
const NUMBER = "66812345678";

beforeEach(() => {
  store.reset();
  session.role = "admin";
  store.seed("wa_outbox", [
    {
      id: 11,
      sender_key: "traveller@example.com",
      to_number: NUMBER,
      body: BODY,
      not_before: "2026-09-05T08:00:00.000Z",
      meta: { vendorName: "Sunrise Rentals", kind: "reply", reason: "Paced by the fleet gap." },
    },
  ]);
});

describe("EXECUTED (F163): the queue view keeps the ops signal and withholds the conversation", () => {
  it("a non-owner admin sees no fragment of the message body and not the shop's number", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const raw = await res.text();
    // THE ASSERTION THAT FAILED BEFORE: preview carried the first 90 chars.
    for (const fragment of ["250/day", "Click 125i", "could you do 240", BODY.slice(0, 30)]) {
      expect(raw, fragment).not.toContain(fragment);
    }
    expect(raw).not.toContain(NUMBER);
    const body = JSON.parse(raw) as {
      items: {
        id: number;
        to: string | null;
        preview: string | null;
        due: boolean;
        overdue: boolean;
        vendorName: string | null;
        kind: string | null;
        reason: string;
      }[];
      total: number;
    };
    // The ops signal survives for management.
    expect(body.total).toBe(1);
    expect(body.items[0].id).toBe(11);
    expect(body.items[0].vendorName).toBe("Sunrise Rentals");
    expect(body.items[0].kind).toBe("reply");
    expect(body.items[0].reason).toBe("Paced by the fleet gap.");
    expect(typeof body.items[0].due).toBe("boolean");
    expect(typeof body.items[0].overdue).toBe("boolean");
    expect(body.items[0].preview).toBeNull();
  });

  it("the owner still reads the preview and the number", async () => {
    session.role = "owner";
    const body = (await (await GET()).json()) as { items: { to: string; preview: string }[] };
    expect(body.items[0].preview).toBe(BODY.slice(0, 90));
    expect(body.items[0].to).toBe(NUMBER);
  });
});
