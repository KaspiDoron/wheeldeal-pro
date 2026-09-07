import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT F162: agent_training CARRIES VERBATIM CROSS-USER WHATSAPP EXCHANGES,
// AND /api/admin/training SERVED THEM TO ANY MANAGEMENT SESSION.
//
// The Ops Center's bookmark, correction and misread-lesson actions write rows
// whose `text` embeds another traveller's shop and agent messages. GET here
// returned the 100 newest rows unfiltered to role "admin" (page.tsx fetches
// it on first paint for every management session), and DELETE / PATCH let
// that admin destroy or rewrite the owner's curated corpus - rows coaching.ts
// injects on the live reply path.
//
// The split admin/data already ships: the owner keeps the full text; a
// non-owner admin keeps id, note, source, provenance and the count (so the
// Memory tile stays useful) but the text of every ops-authored row is
// withheld, and writes to those rows are refused with the same 403 wording.
// Executed against the real route over a Map-backed store.

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

vi.mock("@/lib/ai", () => ({ chatVision: async () => "" }));

import { store } from "@/lib/privacy/postgrest-store.test-helper";
import { GET, DELETE, PATCH } from "./route";

const SHOP_LINE = "Shop: 250 baht per day, helmet included";
const LESSON_QUOTE = 'When Krabi Bike Rent said: "we only have the 160cc left"';
const OWNER_PASTE = "Agent: can you do 240 for the week? Shop: ok 245 final";

const del = (id: number) =>
  DELETE(new Request(`http://local/api/admin/training?id=${id}`, { method: "DELETE" }));
const patch = (id: number, text: string) =>
  PATCH(
    new Request("http://local/api/admin/training", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, text }),
    })
  );

beforeEach(() => {
  store.reset();
  session.role = "admin";
  store.seed("agent_training", [
    {
      id: 1,
      text: `[OPS-EXEMPLAR 2026-09-02] Owner-approved negotiation with Sunrise Rentals:\nAgent: hi\n${SHOP_LINE}`,
      note: "Bookmarked in the Ops Center",
      source: "ops-exemplar",
      added_by: "owner@example.com",
      created_at: "2026-09-02T10:00:00.000Z",
    },
    {
      id: 2,
      text: `[LESSON 2026-09-02 | option-menu] ${LESSON_QUOTE} - that was a menu.`,
      note: "lesson:option-menu",
      source: "ops-lesson",
      added_by: "owner@example.com",
      created_at: "2026-09-02T11:00:00.000Z",
    },
    {
      id: 3,
      text: OWNER_PASTE,
      note: null,
      source: "text",
      added_by: "owner@example.com",
      created_at: "2026-09-01T10:00:00.000Z",
    },
  ]);
});

describe("EXECUTED (F162): ops-authored transcripts are owner-only on the training route", () => {
  it("a non-owner admin gets the count and provenance, never the exchange", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const raw = await res.text();
    // THE ASSERTION THAT FAILED BEFORE: the verbatim shop line rode the 200.
    expect(raw).not.toContain(SHOP_LINE);
    expect(raw).not.toContain("we only have the 160cc left");
    const body = JSON.parse(raw) as {
      examples: { id: number; text: string | null; source?: string; locked?: boolean }[];
    };
    // The Memory count and the rows' identity survive for management.
    expect(body.examples.map((e) => e.id).sort()).toEqual([1, 2, 3]);
    expect(body.examples.find((e) => e.id === 1)?.locked).toBe(true);
    expect(body.examples.find((e) => e.id === 1)?.text).toBeNull();
    expect(body.examples.find((e) => e.id === 1)?.source).toBe("ops-exemplar");
    // A hand-pasted, owner-authored snippet is not a transcript of a traveller.
    expect(body.examples.find((e) => e.id === 3)?.text).toBe(OWNER_PASTE);
  });

  it("the owner still reads every row in full", async () => {
    session.role = "owner";
    const body = (await (await GET()).json()) as {
      examples: { id: number; text: string | null; locked?: boolean }[];
    };
    expect(body.examples.find((e) => e.id === 1)?.text).toContain(SHOP_LINE);
    expect(body.examples.find((e) => e.id === 2)?.text).toContain(LESSON_QUOTE);
    expect(body.examples.every((e) => e.locked === false)).toBe(true);
  });

  it("a non-owner admin cannot DELETE an ops-authored row", async () => {
    const res = await del(1);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("Conversation content is owner-only");
    expect(store.rows("agent_training").some((r) => r.id === 1)).toBe(true);
  });

  it("a non-owner admin cannot PATCH an ops-authored row", async () => {
    const res = await patch(2, "the shop said something else entirely");
    expect(res.status).toBe(403);
    expect(store.rows("agent_training").find((r) => r.id === 2)?.text).toContain(LESSON_QUOTE);
  });

  it("that admin may still curate the hand-taught rows", async () => {
    const res = await del(3);
    expect(res.status).toBe(200);
    expect(store.rows("agent_training").some((r) => r.id === 3)).toBe(false);
  });

  it("the owner keeps full control of the ops rows", async () => {
    session.role = "owner";
    expect((await patch(1, "trimmed exemplar text")).status).toBe(200);
    expect(store.rows("agent_training").find((r) => r.id === 1)?.text).toBe("trimmed exemplar text");
    expect((await del(1)).status).toBe(200);
    expect(store.rows("agent_training").some((r) => r.id === 1)).toBe(false);
  });
});
