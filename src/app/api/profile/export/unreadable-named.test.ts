import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT F166 (and the export half of F168).
//
// The DSAR export promised, in its own header, that "tables that could not be
// read are named in `unreadable` rather than silently returned empty". Both of
// its catch blocks were unreachable: sbSelect returns [] for no connection, for
// any non-2xx and from its own catch, and never throws. So a table the store
// refused to read was handed to the data subject as `"whatsapp_messages": []`
// with `"unreadable": []` - a signed statement that we hold nothing there,
// made while we hold all of it.
//
// Every test here RUNS the route against a Map-backed store whose per-table
// mode is the thing under test: the strict read's three answers (rows /
// missing / unavailable) plus the stale-column shape the refuter flagged.

type Mode = "ok" | "unavailable" | "missing" | "stale-select";

const state: {
  rows: Map<string, Record<string, unknown>[]>;
  mode: Map<string, Mode>;
} = { rows: new Map(), mode: new Map() };

vi.mock("@/lib/session", () => ({
  getSession: async () => ({ email: "someone@example.com", role: "user" }),
}));
vi.mock("@/lib/access", () => ({ getUser: async () => null }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ ok: true, retryAfter: 0 }) }));
vi.mock("@/lib/runtime-config", () => ({
  supabaseConfigured: () => true,
  // The permissive read the route used to drive off: every failure is [].
  sbSelect: async (table: string) =>
    (state.mode.get(table) ?? "ok") === "ok" ? state.rows.get(table) ?? [] : [],
  sbSelectStrict: async (table: string, query: string) => {
    const mode = state.mode.get(table) ?? "ok";
    if (mode === "unavailable") return { error: "unavailable" as const };
    if (mode === "missing") return { error: "missing" as const };
    // A column in the export's select list that this database does not have:
    // PostgREST answers 400 + 42703, which the strict read maps to "missing".
    // The table itself reads fine with select=*.
    if (mode === "stale-select" && !/select=\*/.test(query)) return { error: "missing" as const };
    return { rows: state.rows.get(table) ?? [] };
  },
}));

import { GET } from "./route";

type Body = {
  unreadable: string[];
  data: Record<string, unknown[] | undefined>;
};

const run = async (): Promise<Body> => (await (await GET()).json()) as Body;

beforeEach(() => {
  state.rows = new Map();
  state.mode = new Map();
});

describe("EXECUTED: the export names what it could not read", () => {
  it("an unreadable table is NAMED in `unreadable`, not exported as an empty array", async () => {
    state.rows.set("searches", [{ id: 1, user_email: "someone@example.com" }]);
    state.mode.set("whatsapp_messages", "unavailable");
    const body = await run();
    // THE ASSERTION THAT FAILED BEFORE: unreadable was always [].
    expect(body.unreadable).toContain("whatsapp_messages");
    expect(body.data.whatsapp_messages).toBeUndefined();
    // Readable tables still export normally around the failure.
    expect(body.data.searches).toEqual([{ id: 1, user_email: "someone@example.com" }]);
  });

  it("a table absent from this database is an honest empty array (not-yet-migrated is vacuous)", async () => {
    state.mode.set("wa_turns", "missing");
    const body = await run();
    expect(body.data.wa_turns).toEqual([]);
    expect(body.unreadable).not.toContain("wa_turns");
  });

  it("a stale export column list on a table that EXISTS and HAS rows is named, never a legitimate []", async () => {
    // corpus_embeddings narrows its export with exportSelect. If one of those
    // columns is missing on this database the strict read says "missing" - the
    // same answer as "table absent". The route probes the table itself before
    // believing that: rows exist, so the person is told we could not read it.
    state.mode.set("corpus_embeddings", "stale-select");
    state.rows.set("corpus_embeddings", [{ id: 1, snippet: "250 per day" }]);
    const body = await run();
    expect(body.unreadable).toContain("corpus_embeddings");
    expect(body.data.corpus_embeddings).toBeUndefined();
  });

  it("a stale export column list over NO rows is an honest empty array", async () => {
    state.mode.set("corpus_embeddings", "stale-select");
    state.rows.set("corpus_embeddings", []);
    const body = await run();
    expect(body.data.corpus_embeddings).toEqual([]);
    expect(body.unreadable).not.toContain("corpus_embeddings");
  });

  it("a child whose parents could not be listed is named, not silently empty", async () => {
    state.mode.set("feedback", "unavailable");
    const body = await run();
    expect(body.unreadable).toContain("feedback");
    expect(body.unreadable).toContain("feedback_images");
    expect(body.unreadable).toContain("feedback_replies");
    expect(body.data.feedback_images).toBeUndefined();
  });

  it("children of a readable parent export by parent id, and an empty parent set is []", async () => {
    state.rows.set("feedback", [{ id: 7, reporter_email: "someone@example.com" }]);
    state.rows.set("feedback_images", [{ id: 1, feedback_id: 7, created_at: "2026-09-01T00:00:00Z" }]);
    const body = await run();
    expect(body.data.feedback_images).toEqual([
      { id: 1, feedback_id: 7, created_at: "2026-09-01T00:00:00Z" },
    ]);
    expect(body.data.waba_events).toEqual([]);
    expect(body.unreadable).toEqual([]);
  });
});

describe("EXECUTED (F168): the audit copies in Storage are listed by name", () => {
  it("every inbound media row names its wa-media object; text rows are not listed", async () => {
    state.rows.set("whatsapp_messages", [
      {
        id: 1,
        direction: "inbound",
        wa_message_id: "3EB0A1",
        raw: { receiver: "someone@example.com", media: { key: {}, kind: "image", mime: null } },
      },
      {
        id: 2,
        direction: "inbound",
        wa_message_id: "3EB0B2",
        raw: { receiver: "someone@example.com", media: { key: {}, kind: "audio", mime: "audio/ogg; codecs=opus" } },
      },
      { id: 3, direction: "inbound", wa_message_id: "3EB0C3", raw: { receiver: "someone@example.com" } },
      {
        id: 4,
        direction: "outbound",
        wa_message_id: "3EB0D4",
        raw: { sender: "someone@example.com" },
      },
    ]);
    const body = await run();
    const media = body.data["storage:wa-media"] as
      | { waMessageId: string; path: string; kind: string }[]
      | undefined;
    expect(media).toBeDefined();
    expect(media).toContainEqual({ waMessageId: "3EB0A1", path: "wa-media/3EB0A1.jpg", kind: "image" });
    expect(media).toContainEqual({ waMessageId: "3EB0B2", path: "wa-media/3EB0B2.ogg", kind: "audio" });
    expect(media!.map((m) => m.waMessageId)).not.toContain("3EB0C3");
    expect(media!.map((m) => m.waMessageId)).not.toContain("3EB0D4");
    // Names only - never bytes.
    for (const m of media!) expect(Object.keys(m).sort()).toEqual(["kind", "path", "waMessageId"]);
  });

  it("when the transcripts could not be read, the media list is unknown too - named, not []", async () => {
    state.mode.set("whatsapp_messages", "unavailable");
    const body = await run();
    expect(body.unreadable).toContain("storage:wa-media");
    expect(body.data["storage:wa-media"]).toBeUndefined();
  });
});
