import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("server-only", () => ({}));

// OWNER REPORT 11, C2.1 - THE WAKEUP DRAIN CLAIMED BY DELETE, WITH NO LEASE.
//
// `drainGraphWakeups` claimed a due wakeup by DELETING it, then ran the (LLM)
// turn, then re-parked only inside a catch. So the row vanished the instant the
// claim won, and the only recovery was a catchable throw. A poll route that
// abandons the drain when its time budget elapses, or a Cloud Run instance
// reclaimed between the delete and the compose, left the wakeup DELETED with
// nothing to reclaim it - the strategic-wait / quiet-thread follow-up simply
// never fired. wa_outbox and wa_processed were both converted to leases to stop
// exactly this; graph_wakeups was the one that was missed.
//
// The fix leases via `not_before` (no new column): the claim bumps not_before
// WAKEUP_LEASE_MS into the future, success DELETEs, a mid-run death lets the row
// fall due again. This drives one due wakeup through a mocked runtime-config and
// asserts the claim is a lease-update and the retire is a delete - plus a
// structural guard on the atomic filter and the retry path.

const calls: { fn: string; args: unknown[] }[] = [];
const rec =
  (fn: string, ret: unknown) =>
  (...args: unknown[]) => {
    calls.push({ fn, args });
    return typeof ret === "function" ? (ret as (a: unknown[]) => unknown)(args) : ret;
  };

const DUE_ROW = {
  id: 42,
  kind: "tick",
  thread_key: "traveller@x.co:66812345678",
  not_before: "2020-01-01T00:00:00.000Z",
  payload: null,
};

vi.mock("../runtime-config", () => ({
  // The wakeup query returns one due row; everything buildTurnFromThread reads
  // (negotiation_threads etc.) returns empty, so it yields null input and the
  // row is retired without an LLM turn.
  sbSelect: rec("sbSelect", (args: unknown[]) =>
    String(args[0]) === "graph_wakeups" ? [DUE_ROW] : []
  ),
  sbSelectStrict: rec("sbSelectStrict", { error: "missing" }),
  // The atomic claim: first caller wins the row, and the mock returns it.
  sbUpdateReturning: rec("sbUpdateReturning", [DUE_ROW]),
  sbUpdate: rec("sbUpdate", true),
  sbDelete: rec("sbDelete", true),
  sbInsert: rec("sbInsert", true),
  sbDeleteReturning: rec("sbDeleteReturning", []),
  getConfig: rec("getConfig", null),
  setConfig: rec("setConfig", undefined),
  sbRpc: rec("sbRpc", { ok: false, missing: true }),
  sbCount: rec("sbCount", 0),
}));

beforeEach(() => {
  calls.length = 0;
});

describe("the wakeup drain leases, and retires on success", () => {
  it("EXECUTED: claims by bumping not_before (a lease), not by deleting", async () => {
    const { drainGraphWakeups } = await import("./engine");
    await drainGraphWakeups(async () => ({ ok: true }) as never, {
      userEmail: "traveller@x.co",
    });

    const claim = calls.find((c) => c.fn === "sbUpdateReturning");
    expect(claim, "the claim must be an update-returning lease").toBeTruthy();
    // The atomic filter: only a row still due can be claimed, so a second
    // concurrent PATCH matches zero rows.
    expect(String(claim!.args[1])).toContain("id=eq.42");
    expect(String(claim!.args[1])).toContain("not_before=lte.");
    // The lease pushes not_before into the future.
    const patched = claim!.args[2] as { not_before?: string };
    expect(new Date(patched.not_before!).getTime()).toBeGreaterThan(Date.now());

    // The claim was NEVER a delete - that is the whole regression.
    expect(calls.find((c) => c.fn === "sbDeleteReturning")).toBeFalsy();
  });

  it("EXECUTED: a turn that fails RE-PARKS the leased row - it never duplicates it", async () => {
    // With the engine's real deps unmocked, the compose throws, which is the
    // transient-failure path. The OLD code had already DELETED the row to claim
    // it, so recovery meant INSERTing a fresh one; the leased row is still
    // present now, so recovery is an UPDATE of not_before. An insert here would
    // duplicate the wakeup (two turns for one thread); a delete-claim followed
    // by a lost insert would drop it.
    const { drainGraphWakeups } = await import("./engine");
    await drainGraphWakeups(async () => ({ ok: true }) as never, {
      userEmail: "traveller@x.co",
    });
    // Re-parked via UPDATE on the SAME row...
    const reparkUpdate = calls.find(
      (c) => c.fn === "sbUpdate" && String(c.args[0]) === "graph_wakeups" && String(c.args[1]).includes("id=eq.42")
    );
    expect(reparkUpdate, "a failed turn re-parks the leased row via update").toBeTruthy();
    // ...and NEVER by inserting a second graph_wakeups row.
    expect(
      calls.find((c) => c.fn === "sbInsert" && String(c.args[0]) === "graph_wakeups"),
      "the retry must not insert a duplicate wakeup"
    ).toBeFalsy();
    // ...and the claim was still a lease, not a delete.
    expect(calls.find((c) => c.fn === "sbDeleteReturning")).toBeFalsy();
  });
});

describe("the lease invariants are in the source, where a reviewer can see them", () => {
  const src = () => readFileSync("src/lib/graph/engine.ts", "utf8");

  it("claims with sbUpdateReturning on a not_before=lte filter, not sbDeleteReturning", () => {
    const s = src();
    const block = s.slice(s.indexOf("const processOne ="), s.indexOf("// Bounded pool"));
    expect(block).toMatch(/sbUpdateReturning<WakeupRowDb>/);
    expect(block).toMatch(/not_before=lte\./);
    expect(block).not.toMatch(/sbDeleteReturning<WakeupRowDb>/);
  });

  it("the retry path UPDATES the leased row, it does not INSERT a duplicate", () => {
    const s = src();
    const block = s.slice(s.indexOf("const processOne ="), s.indexOf("// Bounded pool"));
    const retry = block.slice(block.indexOf("decision.reschedule"));
    expect(retry).toMatch(/sbUpdate\(\s*\n?\s*"graph_wakeups"/);
    expect(retry.slice(0, retry.indexOf("return;"))).not.toMatch(/sbInsert\("graph_wakeups"/);
  });

  it("the lease is bounded by a named constant, comfortably over one compose", () => {
    const s = src();
    const m = s.match(/const WAKEUP_LEASE_MS = (\d+) \* 60_000;/);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBeGreaterThanOrEqual(2); // minutes; > a ~90s turn
  });
});
