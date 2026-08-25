import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
vi.mock("server-only", () => ({}));
import {
  egressReading,
  projectAtUsers,
  formatBytes,
  FREE_TIER_EGRESS_BYTES,
  MIN_SAMPLE_DAYS,
} from "./egress";

const GB = 1024 ** 3;

// OWNER REPORT 10, W3 - the ceiling that only existed on somebody else's screen.
//
// The report-8 audit put Supabase's free 5 GB/month egress FIRST, ahead of the
// Evolution hosts, and every plan since ended with the same instruction: watch
// the Supabase usage graph during a real hunt. That needs a human present at
// the moment traffic happens, cannot be checked afterwards, and leaves nothing
// behind. So the app counts its own.

describe("the projection answers the question an invite wave asks", () => {
  it("a quiet month is green, and says what it does not count", () => {
    const r = egressReading(GB * 0.2, 7);
    expect(r.state).toBe("ok");
    expect(r.projectedMonthBytes).toBeCloseTo((GB * 0.2 * 30) / 7, -6);
    expect(r.detail).toMatch(/writes, Storage and Realtime are not counted/);
  });

  it("WARNS before the line, not after - the next wave is what crosses it", () => {
    // 60% of the allowance, projected.
    const r = egressReading(FREE_TIER_EGRESS_BYTES * 0.65 * (7 / 30), 7);
    expect(r.state).toBe("warn");
    expect(r.detail).toMatch(/BEFORE the wave/);
  });

  it("ALARMS with the decision attached, not just a colour", () => {
    const r = egressReading(FREE_TIER_EGRESS_BYTES * 1.4 * (7 / 30), 7);
    expect(r.state).toBe("alarm");
    expect(r.detail).toMatch(/will NOT hold this month/);
    // The panel must name the actual remedy and its price, or the owner is left
    // with a red tile and no move.
    expect(r.detail).toMatch(/Supabase Pro is \$25\/mo/);
  });

  it("A SHORT SAMPLE IS NOT A VERDICT - twenty minutes does not project a month", () => {
    // The failure mode this guards: one tester's hunt, extrapolated 30 days,
    // produces a confident and wildly wrong number on a launch panel - and a
    // confident wrong number gets acted on where a dash does not.
    const r = egressReading(GB * 0.05, 20 / (60 * 24));
    expect(r.state).toBe("unknown");
    expect(r.projectedMonthBytes).toBeNull();
    expect(r.detail).toMatch(/not projected from less than 12 hours/);
    // ...and it still reports what it HAS measured, so the meter is visibly alive.
    expect(r.detail).toMatch(/measured so far/);
  });

  it("the sample floor is half a day", () => {
    expect(MIN_SAMPLE_DAYS).toBe(0.5);
    expect(egressReading(GB, MIN_SAMPLE_DAYS - 0.01).state).toBe("unknown");
    expect(egressReading(GB, MIN_SAMPLE_DAYS).state).not.toBe("unknown");
  });

  it("UNREADABLE IS NOT ZERO - an absent sensor is not good news", () => {
    const r = egressReading(null, 7);
    expect(r.state).toBe("unknown");
    expect(r.bytes).toBeNull();
    expect(r.detail).toMatch(/not a zero/);
  });

  it("EXECUTED: the 25 -> 100 tester question, which is why this number exists", () => {
    // A day at 25 testers using 300 MB. Four times the testers is four times
    // the traffic, and that is what decides whether the fleet plan needs Pro.
    const day = 300 * 1024 * 1024;
    const at25 = projectAtUsers(day, 1, 25, 25);
    const at100 = projectAtUsers(day, 1, 25, 100);
    expect(at100.projectedMonthBytes / at25.projectedMonthBytes).toBeCloseTo(4, 5);
    // 300 MB/day at 25 users is ~9 GB/month - already over. At 100 it is ~36.
    expect(at25.fraction).toBeGreaterThan(1);
    expect(at100.fraction).toBeGreaterThan(4);
  });

  it("formatBytes reads like a person wrote it", () => {
    expect(formatBytes(5 * GB)).toBe("5.00 GB");
    expect(formatBytes(1536 * 1024)).toBe("1.5 MB");
    expect(formatBytes(2048)).toBe("2 KB");
  });
});

describe("the meter sits at the ONE place every read passes", () => {
  const src = () => readFileSync("src/lib/runtime-config.ts", "utf8");

  it("both read chokepoints weigh their response", () => {
    const s = src();
    const sel = s.slice(s.indexOf("export async function sbSelect<"));
    expect(sel.slice(0, sel.indexOf("\n}"))).toMatch(/noteEgress\(measuredBytes\(res, text\)\)/);
    const strict = s.slice(s.indexOf("export async function sbSelectStrict<"));
    expect(strict.slice(0, strict.indexOf("\n}"))).toMatch(
      /noteEgress\(measuredBytes\(res, text\)\)/
    );
  });

  it("BYTE length, not string length - this app carries Thai", () => {
    // `.length` under-counts Thai, Lao, Khmer and Myanmar text by up to 3x, and
    // under-counting a safety ceiling is the wrong direction to be wrong in.
    const fn = src().slice(src().indexOf("function measuredBytes("));
    expect(fn.slice(0, fn.indexOf("\n}"))).toMatch(/Buffer\.byteLength\(text, "utf8"\)/);
    // The wire size is preferred where PostgREST declares it.
    expect(fn.slice(0, fn.indexOf("\n}"))).toMatch(/content-length/);
  });

  it("the flush is bounded and never awaited by a read", () => {
    const s = src();
    const fn = s.slice(s.indexOf("function noteEgress("));
    const body = fn.slice(0, fn.indexOf("\n}"));
    // Fire-and-forget, so telemetry can never delay or fail a query.
    expect(body).toMatch(/void sbInsert\("api_usage"/);
    // ...and at most one write per instance per flush, not one per query.
    expect(body).toMatch(/egressBytes < EGRESS_FLUSH_BYTES && now - egressLastFlush < EGRESS_FLUSH_MS/);
    expect(body).toMatch(/if \(egressFlushing\) return;/);
  });

  it("the panel renders it, with the ceiling attached", () => {
    const route = readFileSync("src/app/api/admin/chokepoints/route.ts", "utf8");
    expect(route).toMatch(/id: "egress"/);
    expect(route).toMatch(/% of 5 GB/);
    // Fail-dark: an unreadable counter must not paint a comfortable zero.
    expect(route).toMatch(/if \(rows === null\) return egressReading\(null, 0\)/);
    // The sample starts at the OLDEST flush, not seven days ago.
    expect(route).toMatch(/const firstAt = Date\.parse\(rows\[0\]\.created_at\)/);
  });
});

// ---------------------------------------------------------------------------
// EXECUTED: the meter really counts, through the real sbSelect.
//
// The greps above prove the call site exists. They cannot prove it ADDS UP -
// and a counter that is wired but always reports zero is the exact shape of
// failure this whole panel exists to undo.
// ---------------------------------------------------------------------------
describe("EXECUTED: bytes are counted through the real read path", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  const stub = (body: string, headers: Record<string, string> = {}) => {
    globalThis.fetch = (async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json", ...headers },
      })) as typeof fetch;
  };

  it("a select adds its payload to the pending total", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    const { sbSelect, pendingEgressBytes } = await import("../runtime-config");
    const payload = JSON.stringify([{ a: "x".repeat(500) }]);
    stub(payload);
    const before = pendingEgressBytes();
    const rows = await sbSelect("agent_events", "select=a&limit=1");
    // The rows still arrive - measuring must not change what a read returns.
    expect(rows).toEqual([{ a: "x".repeat(500) }]);
    expect(pendingEgressBytes() - before).toBe(Buffer.byteLength(payload, "utf8"));
  });

  it("THAI IS NOT UNDER-COUNTED - the reason it is byte length", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    const { sbSelect, pendingEgressBytes } = await import("../runtime-config");
    const thai = JSON.stringify([{ body: "ราคาต่อวัน ๒๐๐ บาท" }]);
    stub(thai);
    const before = pendingEgressBytes();
    await sbSelect("whatsapp_messages", "select=body&limit=1");
    const counted = pendingEgressBytes() - before;
    expect(counted).toBe(Buffer.byteLength(thai, "utf8"));
    // The bug this guards: `.length` would report far fewer bytes than the wire
    // actually carried, so the ceiling would look further away than it is.
    expect(counted).toBeGreaterThan(thai.length);
  });

  it("the declared wire size WINS over the decoded length", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    const { sbSelect, pendingEgressBytes } = await import("../runtime-config");
    // Compressed on the wire: content-length is smaller than the decoded body,
    // and it is the number Supabase bills.
    stub(JSON.stringify([{ a: "y".repeat(2000) }]), { "content-length": "137" });
    const before = pendingEgressBytes();
    await sbSelect("agent_events", "select=a&limit=1");
    expect(pendingEgressBytes() - before).toBe(137);
  });

  it("a FAILED read counts nothing - there was no payload", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    const { sbSelect, pendingEgressBytes } = await import("../runtime-config");
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    const before = pendingEgressBytes();
    expect(await sbSelect("agent_events", "select=a&limit=1")).toEqual([]);
    expect(pendingEgressBytes()).toBe(before);
  });

  it("a malformed body still behaves exactly as it did - empty, not thrown", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    const { sbSelect } = await import("../runtime-config");
    stub("{not json");
    // text()+JSON.parse must fall into the same catch json() did.
    await expect(sbSelect("agent_events", "select=a&limit=1")).resolves.toEqual([]);
  });

  it("sbSelectStrict counts too, and still discriminates its three answers", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    const { sbSelectStrict, pendingEgressBytes } = await import("../runtime-config");
    const payload = JSON.stringify([{ id: 1 }]);
    stub(payload);
    const before = pendingEgressBytes();
    const ok = await sbSelectStrict("agent_events", "select=id&limit=1");
    expect(ok).toEqual({ rows: [{ id: 1 }] });
    expect(pendingEgressBytes() - before).toBe(Buffer.byteLength(payload, "utf8"));

    globalThis.fetch = (async () => new Response("", { status: 404 })) as typeof fetch;
    expect(await sbSelectStrict("nope", "select=id")).toEqual({ error: "missing" });
  });
});
