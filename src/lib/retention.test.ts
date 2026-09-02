import { describe, it, expect, vi, beforeEach } from "vitest";

// EXECUTED, not grepped: every case drives the real maybeRunRetention against
// a stubbed PostgREST layer, so a regression in the gate arithmetic or in the
// missing/unconfirmed split fails here rather than passing a source match.

const selectDark = vi.fn<(...a: unknown[]) => unknown>();
const rpc = vi.fn<(...a: unknown[]) => unknown>();
const noteEvent = vi.fn<(...a: unknown[]) => unknown>();

vi.mock("@/lib/runtime-config", () => ({
  sbSelectDark: (...a: unknown[]) => selectDark(...a),
  sbRpc: (...a: unknown[]) => rpc(...a),
}));
vi.mock("@/lib/events", () => ({
  noteAgentEvent: (...a: unknown[]) => noteEvent(...a),
}));

const NOW = Date.parse("2026-09-01T12:00:00Z");
const agoHours = (h: number) => new Date(NOW - h * 3600_000).toISOString();

async function run(now = NOW) {
  const { maybeRunRetention } = await import("./retention");
  return maybeRunRetention(now);
}

beforeEach(() => {
  vi.resetModules();
  selectDark.mockReset();
  rpc.mockReset();
  noteEvent.mockReset();
  noteEvent.mockResolvedValue(true);
});

describe("maybeRunRetention", () => {
  it("runs the prune when no heartbeat has ever been written", async () => {
    selectDark.mockResolvedValue([]);
    rpc.mockResolvedValue({ ok: true });
    expect(await run()).toBe("ran");
    expect(rpc).toHaveBeenCalledWith("prune_old_rows", { retain_days: 90 });
  });

  it("stands down while a recent heartbeat exists", async () => {
    selectDark.mockResolvedValue([{ created_at: agoHours(3), kind: "retention-ran" }]);
    expect(await run()).toBe("recent");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("takes over once the heartbeat ages past the gap - a missing pg_cron schedule", async () => {
    selectDark.mockResolvedValue([{ created_at: agoHours(30), kind: "retention-ran" }]);
    rpc.mockResolvedValue({ ok: true });
    expect(await run()).toBe("ran");
  });

  it("self-runs BEFORE the health tile calls retention stale", async () => {
    // The gate must be shorter than the tile's 48h stale window, or a database
    // this path is keeping current would still render red.
    const { RETENTION_MIN_GAP_MS } = await import("./retention");
    expect(RETENTION_MIN_GAP_MS).toBeLessThan(48 * 3600_000);
    // ...and longer than a day would be a skipped day.
    expect(RETENTION_MIN_GAP_MS).toBeLessThanOrEqual(24 * 3600_000);
  });

  it("does NOT prune when the heartbeat is unreadable - unknown is not zero", async () => {
    selectDark.mockResolvedValue(null);
    expect(await run()).toBe("unreadable");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("does NOT prune when the heartbeat read throws", async () => {
    selectDark.mockRejectedValue(new Error("network"));
    expect(await run()).toBe("unreadable");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("reports missing and breadcrumbs it when prune_old_rows was never created", async () => {
    selectDark.mockResolvedValue([]);
    rpc.mockResolvedValue({ ok: false, missing: true });
    expect(await run()).toBe("missing");
    expect(noteEvent).toHaveBeenCalledTimes(1);
    expect(noteEvent.mock.calls[0]?.[0]).toMatchObject({ kind: "retention-unavailable" });
  });

  it("the missing breadcrumb gates the NEXT attempt - no re-try every ping", async () => {
    selectDark.mockResolvedValue([{ created_at: agoHours(1), kind: "retention-unavailable" }]);
    expect(await run()).toBe("recent");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a non-404 failure is unconfirmed, not missing, and writes no breadcrumb", async () => {
    // A big first prune outlives sbRpc's client-side timeout while Postgres
    // still commits - so this must not be reported to the owner as "run the
    // SQL file", and must not poison the gate.
    selectDark.mockResolvedValue([]);
    rpc.mockResolvedValue({ ok: false, missing: false });
    expect(await run()).toBe("unconfirmed");
    expect(noteEvent).not.toHaveBeenCalled();
  });

  it("an RPC that throws is unconfirmed, never a crash into the cron ping", async () => {
    selectDark.mockResolvedValue([]);
    rpc.mockRejectedValue(new Error("aborted"));
    await expect(run()).resolves.toBe("unconfirmed");
  });

  it("prunes to the same window the pg_cron schedule uses", async () => {
    const { RETENTION_RETAIN_DAYS } = await import("./retention");
    const sql = (await import("node:fs")).readFileSync("supabase/retention.sql", "utf8");
    // retention.sql schedules `select public.prune_old_rows(90)` - the two
    // paths must agree or the policy depends on who ran it.
    expect(sql).toContain(`prune_old_rows(${RETENTION_RETAIN_DAYS})`);
  });
});
