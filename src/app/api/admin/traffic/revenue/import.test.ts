// THE REVENUE IMPORT CHANGES MONEY FIGURES. Who may do it, what it writes, and
// what it says about a partial write are the three things worth pinning.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

let session: { email: string; role: string } | null = null;
const inserts: { table: string; rows: Record<string, unknown>[]; onConflict?: string }[] = [];
let failTable: string | null = null;

vi.mock("@/lib/session", () => ({ getSession: async () => session }));
vi.mock("@/lib/runtime-config", () => ({
  sbInsert: vi.fn(async (table: string, rows: Record<string, unknown>[], onConflict?: string) => {
    inserts.push({ table, rows, onConflict });
    return table !== failTable;
  }),
  getConfig: vi.fn(async (name: string) =>
    name === "TRAFFIC_PARTNERS" ? "feed-a|link|Feed A|on|https://feed.example/s?q={q}&subid={subid}||0.8" : name === "TRAFFIC_MODE" ? "live" : null
  ),
}));

const { POST } = await import("./route");

const SUB = "p1-mth-cscooter-9a3f01bc";
const CSV = `date,subid,clicks,revenue\n2026-09-19,${SUB},12,4.80\n2026-09-19,${SUB},oops,1\n`;
const post = (body: unknown) => POST(new Request("http://x/api/admin/traffic/revenue", { method: "POST", body: JSON.stringify(body) }));
const audit = () => inserts.filter((i) => i.table === "admin_audit").map((i) => i.rows[0]);
const revenue = () => inserts.filter((i) => i.table === "traffic_revenue");

beforeEach(() => {
  inserts.length = 0;
  failTable = null;
  session = { email: "owner@example.com", role: "owner" };
});

describe("who may import revenue", () => {
  it("refuses a signed-out caller and writes nothing", async () => {
    session = null;
    expect((await post({ partner: "feed-a", csv: CSV })).status).toBe(403);
    expect(inserts).toEqual([]);
  });

  // Management can READ the traffic screen. Changing the money on it is the
  // owner's alone - and an attempt is exactly what an audit trail is for.
  it("refuses an admin, and puts the refusal on the audit trail", async () => {
    session = { email: "admin@example.com", role: "admin" };
    expect((await post({ partner: "feed-a", csv: CSV })).status).toBe(403);
    expect(revenue()).toEqual([]);
    expect(audit()).toHaveLength(1);
    expect(audit()[0]).toMatchObject({ actor_email: "admin@example.com", action: "traffic.revenue-import", outcome: "refused" });
  });
});

describe("what an import writes", () => {
  it("upserts on (partner, day, sub_id) so a finalised report REPLACES the estimate", async () => {
    const res = await post({ partner: "feed-a", csv: CSV });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, saved: 1, total: 1, skipped: 1 });
    expect(revenue()).toHaveLength(1);
    expect(revenue()[0].onConflict).toBe("partner,day,sub_id");
    expect(revenue()[0].rows[0]).toEqual({
      partner: "feed-a",
      day: "2026-09-19",
      sub_id: SUB,
      clicks: 12,
      revenue: 4.8,
      currency: "USD",
      imported_by: "owner@example.com",
    });
    expect(audit()[0]).toMatchObject({ action: "traffic.revenue-import", outcome: "ok" });
  });

  it("refuses a partner that is not configured - real money must not be filed under a typo", async () => {
    expect((await post({ partner: "feed-b", csv: CSV })).status).toBe(400);
    expect(revenue()).toEqual([]);
  });

  it("refuses an empty or unreadable file with the reasons", async () => {
    expect((await post({ partner: "feed-a", csv: "" })).status).toBe(400);
    const res = await post({ partner: "feed-a", csv: "date,clicks,revenue\n2026-09-19,1,1" });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/sub/i);
    expect(revenue()).toEqual([]);
  });

  it("refuses an oversized upload before parsing it", async () => {
    expect((await post({ partner: "feed-a", csv: "x".repeat(4_000_001) })).status).toBe(413);
  });

  // HONEST WRITES: a database that dropped the batch is a 502 and ok:false,
  // never a success with a footnote - and the audit row says failed.
  it("reports a failed write as a failure", async () => {
    failTable = "traffic_revenue";
    const res = await post({ partner: "feed-a", csv: CSV });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, saved: 0, total: 1 });
    expect(audit().at(-1)).toMatchObject({ outcome: "failed" });
  });
});
