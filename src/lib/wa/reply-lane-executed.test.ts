import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// WAVE 8'S CENTREPIECE WAS INERT, AND ITS TESTS COULD NOT SEE THAT.
//
// "Wait to the edge instead of re-parking" was asserted entirely by regex over
// the source - including one assertion that pinned the exact arithmetic that
// was wrong. An adversarial re-audit executed the real `claimSendSlots` and
// found two P0s:
//
//  1. On a lost lane it returned the BUCKET EDGE as retryAtMs, while the
//     straddle guard refuses anything inside `prevAt + gap`. prevAt sits
//     strictly INSIDE the previous bucket, so the edge is always early - by up
//     to a full gap. The caller takes ONE wait, so it slept to an instant that
//     was still refused, burned its allowance, and re-parked. On a 7-shop
//     burst: 1 reply on the wire, 6 parked 20-40s.
//
//  2. The straddle check probed the previous bucket with an INSERT. On a win
//     that CREATED a row stamped now, and no refusal path released it - so a
//     later attempt read a failed attempt as a previous SEND, and held a shop
//     that had never been messaged for a full gap. Spacing was being measured
//     from the first ATTEMPT rather than the last SEND, on all three lanes.
//
// Every test here RUNS the claim machinery. Test 1 and 3 fail against the code
// as it stood before this wave.

const state: {
  claims: Map<string, number>;
  nowMs: number;
} = { claims: new Map(), nowMs: 1_700_000_000_000 };

vi.mock("../runtime-config", () => ({
  sbInsertClaim: async (_t: string, row: { sender_key: string; slot_key: string }) => {
    const key = `${row.sender_key}|${row.slot_key}`;
    if (state.claims.has(key)) return "lost" as const;
    state.claims.set(key, state.nowMs);
    return "won" as const;
  },
  sbDelete: async (_t: string, query: string) => {
    const sender = decodeURIComponent(/sender_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    const slot = decodeURIComponent(/slot_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    state.claims.delete(`${sender}|${slot}`);
  },
  sbInsert: async () => true,
  sbSelectStrict: async (_t: string, query: string) => {
    const sender = decodeURIComponent(/sender_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    const slot = decodeURIComponent(/slot_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    const at = state.claims.get(`${sender}|${slot}`);
    return { rows: at ? [{ created_at: new Date(at).toISOString() }] : [] };
  },
}));

import { claimSendSlots, gapBucket } from "./pacing";

const SENDER = "traveller@example.com";
const GAP = 5;
const FLEET_GAP = 6;

const replyClaim = (shop: string, text: string) =>
  claimSendSlots({
    senderKey: SENDER,
    toDigits: shop,
    text,
    auto: true,
    gapSeconds: GAP,
    perRecipient: true,
    fleetGapSeconds: FLEET_GAP,
    nowMs: state.nowMs,
  });

beforeEach(() => {
  state.claims = new Map();
  // Start 2s INTO a fleet bucket - the case where the bucket edge and the true
  // free-at instant disagree, which is almost always.
  const base = 1_700_000_000_000;
  state.nowMs = gapBucket(base, FLEET_GAP) * FLEET_GAP * 1000 + 2_000;
});

describe("retryAtMs names the instant the lane is REALLY free", () => {
  it("EXECUTED: sleeping to the advertised instant SUCCEEDS on the second claim", async () => {
    // Shop A takes the fleet slot 2s into the bucket.
    const first = await replyClaim("66900000001", "first reply");
    expect(first.ok).toBe(true);

    // Shop B answers immediately and loses the fleet lane.
    const second = await replyClaim("66900000002", "second reply");
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("expected a refusal");
    expect(second.kind).toBe("pacing");
    expect(typeof second.retryAtMs).toBe("number");

    // THE ASSERTION THAT FAILED BEFORE. Advance to exactly the instant the
    // refusal advertised and claim again: it must now be allowed. Against the
    // bucket-edge answer this was still refused, and the caller - which waits
    // once - re-parked the row.
    state.nowMs = second.retryAtMs ?? state.nowMs;
    const retry = await replyClaim("66900000002", "second reply");
    expect(retry.ok).toBe(true);
  });

  it("EXECUTED: the advertised instant is never earlier than a full gap after the winner", async () => {
    const winnerAt = state.nowMs;
    await replyClaim("66900000001", "first reply");
    const refused = await replyClaim("66900000002", "second reply");
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.retryAtMs ?? 0).toBeGreaterThanOrEqual(winnerAt + FLEET_GAP * 1000);
  });
});

describe("a FAILED attempt is never mistaken for a send", () => {
  it("EXECUTED: losing a lane leaves no residue that holds an unmessaged shop", async () => {
    // Shop A wins everything. Shop B attempts and loses the fleet lane only -
    // nothing has ever been sent to shop B.
    await replyClaim("66900000001", "first reply");
    const refused = await replyClaim("66900000002", "second reply");
    expect(refused.ok).toBe(false);

    // Move a full fleet gap on, so the fleet lane is genuinely free and shop
    // B's own recipient mutex has never been used. The claim must succeed.
    //
    // Before the fix, shop B's FIRST attempt had written a probe row into its
    // previous recipient bucket stamped at attempt time - so this read as "we
    // messaged this shop moments ago" and refused for another 8s, on the
    // strength of a send that never happened.
    state.nowMs += FLEET_GAP * 1000 + 500;
    const later = await replyClaim("66900000002", "second reply");
    expect(later.ok).toBe(true);
  });

  it("EXECUTED: a refused attempt writes no claim row for a bucket it did not win", async () => {
    await replyClaim("66900000001", "first reply");
    const before = new Set(state.claims.keys());
    await replyClaim("66900000002", "second reply");
    const added = [...state.claims.keys()].filter((k) => !before.has(k));
    // The refused attempt must own nothing. Any row it leaves behind is a lie
    // some later claim will read as history.
    expect(added).toEqual([]);
  });
});

describe("the anti-ban guarantees the lanes exist for still hold", () => {
  it("EXECUTED: two sends to the SAME shop are still 8s apart", async () => {
    const ok = await replyClaim("66900000001", "first");
    expect(ok.ok).toBe(true);
    // Same shop, immediately: the recipient mutex refuses regardless of lane.
    state.nowMs += 1_000;
    const tooSoon = await replyClaim("66900000001", "second");
    expect(tooSoon.ok).toBe(false);
    // And it is still refused at 7s.
    state.nowMs += 6_000;
    expect((await replyClaim("66900000001", "third")).ok).toBe(false);
  });

  it("EXECUTED: the fleet still trickles - two shops cannot send in the same instant", async () => {
    expect((await replyClaim("66900000001", "a")).ok).toBe(true);
    expect((await replyClaim("66900000002", "b")).ok).toBe(false);
    expect((await replyClaim("66900000003", "c")).ok).toBe(false);
  });

  it("EXECUTED: an identical message to the same shop is a DUPLICATE, not pacing", async () => {
    expect((await replyClaim("66900000001", "same words")).ok).toBe(true);
    state.nowMs += 60_000;
    const again = await replyClaim("66900000001", "same words");
    expect(again).toEqual({ ok: false, kind: "duplicate" });
  });
});

describe("the burst the owner reported", () => {
  it("EXECUTED: seven shops answering at once all reach the wire within the fleet trickle", async () => {
    // Seven distinct shops, each with a reply ready. The fleet gap means they
    // take turns - that is the anti-ban design and it is NOT the bug. The bug
    // was that a shop refused at t had no usable instant to come back at, so it
    // re-parked for 20-40s and then waited for the next drain.
    //
    // Here every refusal is followed to its own advertised instant, which is
    // exactly what the caller now does. All seven must land, and the last must
    // land inside the fleet trickle rather than minutes later.
    const shops = Array.from({ length: 7 }, (_, i) => `6690000000${i + 1}`);
    const start = state.nowMs;
    let sent = 0;
    for (const shop of shops) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const r = await replyClaim(shop, `reply to ${shop}`);
        if (r.ok) {
          sent += 1;
          break;
        }
        if (r.ok || r.kind !== "pacing" || typeof r.retryAtMs !== "number") break;
        state.nowMs = Math.max(state.nowMs + 1, r.retryAtMs);
      }
    }
    expect(sent).toBe(7);
    // Seven sends at a 6s fleet gap is ~36s by construction. The failure this
    // replaces put the 7th reply minutes out.
    const elapsed = (state.nowMs - start) / 1000;
    expect(elapsed).toBeLessThanOrEqual(7 * FLEET_GAP + 2);
  });
});
