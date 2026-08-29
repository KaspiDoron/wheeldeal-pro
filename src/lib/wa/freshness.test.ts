import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { judgeFreshness } from "./freshness";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// KO TAO, 31 JULY.
//
//   12:22  shop: "I can give you 180 baht for one day."
//   ~12:23 engine composes "That's a bit high for me..."   <- correct, then
//   12:38  shop: "My shop doesn't have free motorcycles..."
//   12:39  WE SEND THE 12:23 SENTENCE                       <- wrong, now
//   12:43  and then agree a price
//
// Both messages were true when written and false when sent. The send path had
// no way to notice: it re-checks the anti-ban guard, the cancellation
// tombstone and the pacing claim, and none of those reads the conversation.

describe("a draft composed against inbound N is never sent after N+1 exists", () => {
  const composedAgainst = {
    inboundId: "msg-12-22",
    inboundAt: "2026-07-31T05:23:00.000Z",
    quotePerDay: 180,
    move: "bargain",
  };

  it("REPRODUCTION: the 12:39 bargain is refused once the 12:38 reply exists", () => {
    const v = judgeFreshness({
      composedAgainst,
      latestInboundId: "msg-12-38",
      latestInboundAt: "2026-07-31T05:38:00.000Z",
    });
    expect(v.stale).toBe(true);
    expect(v.reason).toBe("newer-inbound");
    expect(v.detail).toContain("msg-12-38");
  });

  it("the same draft sends while it is still the newest thing said", () => {
    const v = judgeFreshness({
      composedAgainst,
      latestInboundId: "msg-12-22",
      latestInboundAt: "2026-07-31T05:22:00.000Z",
    });
    expect(v.stale).toBe(false);
  });

  it("identity beats time - an id match is fresh however the clocks disagree", () => {
    // Provider ids are exact; wall clocks between the app and the database are
    // not. When we have the id, it decides.
    const v = judgeFreshness({
      composedAgainst,
      latestInboundId: "msg-12-22",
      latestInboundAt: "2099-01-01T00:00:00.000Z",
    });
    expect(v.stale).toBe(false);
  });

  it("falls back to time only when no id was ever stamped", () => {
    const noId = { inboundAt: "2026-07-31T05:23:00.000Z", move: "bargain" };
    expect(
      judgeFreshness({ composedAgainst: noId, latestInboundAt: "2026-07-31T05:38:00.000Z" }).stale
    ).toBe(true);
    // Equal timestamps are the same message seen twice, not a new one.
    expect(
      judgeFreshness({ composedAgainst: noId, latestInboundAt: "2026-07-31T05:23:00.000Z" }).stale
    ).toBe(false);
  });
});

describe("the shop running out kills a price move that predates it", () => {
  const priceMove = { inboundId: "m1", stockState: "unknown" as const, move: "bargain" };

  it("a bargain written while there was stock does not go out after there isn't", () => {
    const v = judgeFreshness({
      composedAgainst: priceMove,
      latestInboundId: "m1",
      stockNow: "out-of-stock",
    });
    expect(v.stale).toBe(true);
    expect(v.reason).toBe("stock-flipped");
  });

  it("a non-price move still goes out - a thread that went quiet can be asked", () => {
    const v = judgeFreshness({
      composedAgainst: { inboundId: "m1", move: "clarify" },
      latestInboundId: "m1",
      stockNow: "out-of-stock",
    });
    expect(v.stale).toBe(false);
  });

  it("a shop that RESTOCKED is one we can talk prices with again", () => {
    const v = judgeFreshness({
      composedAgainst: { inboundId: "m1", stockState: "out-of-stock", move: "bargain" },
      latestInboundId: "m1",
      stockNow: "in-stock",
    });
    expect(v.stale).toBe(false);
  });
});

describe("it FAILS OPEN - a drop is destructive and must never be a guess", () => {
  it("no fingerprint (a cold intro, or a row parked before this shipped) sends", () => {
    expect(judgeFreshness({ latestInboundId: "anything" }).stale).toBe(false);
    expect(judgeFreshness({ composedAgainst: {}, latestInboundId: "anything" }).stale).toBe(false);
    expect(judgeFreshness({ composedAgainst: null, latestInboundId: "x" }).stale).toBe(false);
  });

  it("an unreadable thread state sends", () => {
    const v = judgeFreshness({
      composedAgainst: { inboundId: "m1", move: "bargain" },
      latestInboundId: null,
      latestInboundAt: null,
      stockNow: null,
    });
    expect(v.stale).toBe(false);
  });

  it("an unparseable timestamp is not treated as newer", () => {
    const v = judgeFreshness({
      composedAgainst: { inboundAt: "not a date", move: "bargain" },
      latestInboundAt: "2026-07-31T05:38:00.000Z",
    });
    expect(v.stale).toBe(false);
  });
});

describe("the wiring", () => {
  const guard = readCode("src/lib/wa-guard.ts");

  it("the gate runs in the drain, after cancellation and BEFORE the send claim", () => {
    const cancel = guard.indexOf("isCancelled");
    const stale = guard.indexOf("if (await staleDraftDropped(row, rowKind)) continue;");
    const claim = guard.indexOf("const claim = await claimSendSlots({");
    expect(cancel).toBeGreaterThan(0);
    expect(stale).toBeGreaterThan(cancel);
    expect(claim).toBeGreaterThan(stale);
  });

  it("DROP AND RECOMPOSE: a stale drop always schedules a fresh turn", () => {
    // Deleting alone would assume the newer inbound ran a turn of its own, and
    // it may not have - a guard refusal, a takeover flip, an LLM outage or a
    // vision offload all end a turn without composing. That assumption is how a
    // thread dies silently, so the drop schedules its own replacement.
    const fn = guard.slice(
      guard.indexOf("async function staleDraftDropped"),
      guard.indexOf("export async function drainOutbox")
    );
    expect(fn).toMatch(/completeOutboxRow\(row\.id\)/);
    expect(fn).toMatch(/kind: "wa-send-stale"/);
    expect(fn).toMatch(/sbInsert\("graph_wakeups"/);
    expect(fn).toMatch(/stale-draft-recompose/);
    // ...and the drop is never silent.
    expect(fn.indexOf('kind: "wa-send-stale"')).toBeLessThan(fn.indexOf('sbInsert("graph_wakeups"'));
  });

  it("cold intros and the user's own messages are exempt", () => {
    const fn = guard.slice(
      guard.indexOf("async function staleDraftDropped"),
      guard.indexOf("export async function drainOutbox")
    );
    // deal-close joined the exemption (owner report 6 A0): "the deal is on"
    // stays true whatever the shop said in between, and the recompose a
    // stale-drop schedules could never re-say it against a closed session.
    for (const kind of ['"rfq"', '"custom"', '"human-manual"', '"deal-close"']) {
      expect(fn).toContain(`rowKind === ${kind}`);
    }
  });

  it("every engine stamps what its draft is an answer to", () => {
    // The legacy loop's own stamp died with the legacy block; the LIVE engines
    // are the writers now (SPTE below; the graph engine composes through the
    // same guarded meta).
    expect(readCode("src/lib/spte/live.ts")).toMatch(/composedAgainst: \{/);
    // ...and the inbound id is threaded from the turn that owns it, through
    // the routed input's ctx.
    expect(readCode("src/lib/agent-loop.ts")).toMatch(/inboundId: opts\.waMessageId/);
    expect(readCode("src/lib/spte/live.ts")).toMatch(/inboundId: input\.ctx\.inboundId/);
  });
});
