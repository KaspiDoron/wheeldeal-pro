import { describe, it, expect, vi, beforeEach } from "vitest";

// THE WRITE PATH, on a store we control.
//
// cookies.test.ts covers the pure helpers (normalizePath, sanitizeProps) and
// greps the route for its gates. This covers the one thing neither can: the
// ROW that actually reaches the database - its key, its shape, and whether
// `stored` tells the truth about a failed insert.
//
// It matters most for the scrubbing. `normalizePath` being correct in isolation
// proves nothing about whether `collectEvents` actually runs a client-supplied
// path through it, and "the query string is dropped" is a promise printed on
// the Cookie Policy page.

vi.mock("server-only", () => ({}));

const db: { inserts: { table: string; rows: Record<string, unknown>[] }[]; fail: boolean } = {
  inserts: [],
  fail: false,
};

vi.mock("../runtime-config", () => ({
  sbInsert: async (table: string, rows: Record<string, unknown>[]) => {
    db.inserts.push({ table, rows });
    return !db.fail;
  },
}));

import { collectEvents, MAX_EVENTS_PER_BATCH } from "./events";

beforeEach(() => {
  db.inserts = [];
  db.fail = false;
});

const row = () => db.inserts[0]?.rows[0] as Record<string, unknown>;

describe("collectEvents writes a row a person could be shown", () => {
  it("keys the row by email, into the table the erasure registry walks", async () => {
    const res = await collectEvents({
      email: "  Traveller@Test.CO ",
      analyticsId: "abcdefgh12345678",
      events: [{ name: "screen_view", props: { path: "/profile" } }],
    });
    expect(res.accepted).toBe(1);
    expect(res.stored).toBe(true);
    expect(db.inserts[0].table).toBe("product_events");
    expect(row().user_email).toBe("traveller@test.co");
    expect(row().kind).toBe("web");
    expect(row().stage).toBe("screen_view");
  });

  it("the analytics id is a COLUMN, never the identity", async () => {
    await collectEvents({
      email: "a@b.co",
      analyticsId: "abcdefgh12345678",
      events: [{ name: "screen_view" }],
    });
    expect(row().session_id).toBe("abcdefgh12345678");
    // ...and its absence is not an error: a person can consent to analytics on
    // a device whose id cookie was blocked, and their events still count.
    db.inserts = [];
    await collectEvents({ email: "a@b.co", analyticsId: null, events: [{ name: "screen_view" }] });
    expect(row().session_id).toBeNull();
  });

  it("NO EMAIL, NO ROW - there is no anonymous behavioural table here", async () => {
    const res = await collectEvents({
      email: "",
      analyticsId: "abcdefgh12345678",
      events: [{ name: "screen_view" }],
    });
    expect(res.stored).toBeNull();
    expect(db.inserts).toEqual([]);
  });

  it("the client's path is scrubbed on the way IN, not merely scrubbable", async () => {
    await collectEvents({
      email: "a@b.co",
      analyticsId: null,
      // A query with a search term in it and an id in the path - the two things
      // /cookies promises are removed before anything is stored.
      events: [{ name: "screen_view", props: { path: "/deals/7f3a9c21?q=Kata%20Beach" } }],
    });
    const props = row().props as Record<string, unknown>;
    expect(props.path).toBe("/deals/:id");
    expect(JSON.stringify(props)).not.toContain("Kata");
    expect(JSON.stringify(props)).not.toContain("7f3a9c21");
  });

  it("unknown event names are dropped, and the rest of the batch still lands", async () => {
    const res = await collectEvents({
      email: "a@b.co",
      analyticsId: null,
      events: [
        { name: "screen_view" },
        { name: "exfiltrate" },
        { name: "booking_opened" },
      ],
    });
    expect(res.accepted).toBe(2);
    expect(res.rejected).toBe(1);
    expect(db.inserts[0].rows.map((r) => r.stage)).toEqual(["screen_view", "booking_opened"]);
  });

  it("a batch of nothing but junk writes nothing at all", async () => {
    const res = await collectEvents({
      email: "a@b.co",
      analyticsId: null,
      events: [{ name: "nope" }, { name: "" }],
    });
    expect(res.accepted).toBe(0);
    expect(res.rejected).toBe(2);
    expect(res.stored).toBeNull();
    expect(db.inserts).toEqual([]);
  });

  it("an oversized batch is capped rather than accepted whole", async () => {
    const res = await collectEvents({
      email: "a@b.co",
      analyticsId: null,
      events: Array.from({ length: 500 }, () => ({ name: "screen_view" })),
    });
    expect(res.accepted).toBe(MAX_EVENTS_PER_BATCH);
  });

  it("a client clock outside a day is replaced with the server's", async () => {
    const now = Date.now();
    await collectEvents({
      email: "a@b.co",
      analyticsId: null,
      events: [
        { name: "screen_view", at: 0 },
        { name: "screen_view", at: now - 60_000 },
      ],
    });
    const [absurd, plausible] = db.inserts[0].rows.map(
      (r) => Date.parse((r.props as { at: string }).at)
    );
    // The absurd one is snapped to now; the plausible one is kept verbatim.
    expect(Math.abs(absurd - now)).toBeLessThan(5_000);
    expect(Math.abs(plausible - (now - 60_000))).toBeLessThan(1_000);
  });

  it("a failed insert is reported as failed, not swallowed as success", async () => {
    // The honest-writes rule: a beacon that says ok over a dead table is how an
    // analytics surface reads zero for a week with nobody able to tell whether
    // that is the truth or the plumbing.
    db.fail = true;
    const res = await collectEvents({
      email: "a@b.co",
      analyticsId: null,
      events: [{ name: "screen_view" }],
    });
    expect(res.accepted).toBe(1);
    expect(res.stored).toBe(false);
  });
});
