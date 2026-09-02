import { describe, it, expect } from "vitest";
import { classifyIngestDetailed, DRILL_INGEST_WINDOW_MS } from "./thread-gate";
import { identityKey } from "./phone-key";
import { digitsOnly } from "../phone";
import { trackerStageForLedger } from "../client/ledger-stage";
import { STAGE_ORDER, stageRank } from "../client/stage-order";
import { isLoudDrop, dropFeedItem } from "./safety-signals";

// THE INCIDENT THIS FILE PINS.
//
// Three Bali shops replied on the traveller's WhatsApp at 10:20-10:21. At 10:22
// the app still listed all six under "AWAITING REPLY (6)". The admin drop
// counters read `vendor-gate: 27 (65)` and `unresolved-identity: 1`.
//
// Four independent mechanisms each reproduce that screen on their own. Every
// one of them is executed here, not grepped.

const HOURS = 3600_000;
const row = (raw: Record<string, unknown> | null, agoMs: number) => ({
  received_at: new Date(Date.now() - agoMs).toISOString(),
  raw,
});

describe("1. the ledger's `replied` stage can actually reach the card", () => {
  it("every stage the ledger can report is rankable by the card", () => {
    // The advance rule is `rank(target) > rank(current)`, and an unranked
    // target scores -1, so it can NEVER be applied. `replied` was unranked -
    // the one stage the funnel ledger was taught to write and the Tracker was
    // taught to draw. A shop that answered was pinned on "Awaiting reply".
    const ledgerStages = [
      "contacted", "replied", "understood", "negotiating", "terms_pending",
      "price_received", "price_verified", "terms_collected", "verifying",
      "shop_confirmed", "booked", "completed", "declined", "out_of_stock",
      "unreachable",
    ];
    const unrankable: string[] = [];
    for (const s of ledgerStages) {
      const card = trackerStageForLedger(s);
      if (!card) continue;
      // Terminals are applied directly, not by rank.
      if (["declined", "out-of-stock", "no-contact"].includes(card)) continue;
      if (stageRank(card) < 0) unrankable.push(`${s} -> ${card}`);
    }
    expect(unrankable).toEqual([]);
  });

  it("a contacted card ADVANCES to replied", () => {
    expect(stageRank("replied")).toBeGreaterThan(stageRank("awaiting-response"));
  });

  it("...and replied still yields to negotiating and to a priced offer", () => {
    expect(stageRank("negotiating")).toBeGreaterThan(stageRank("replied"));
    expect(stageRank("offer-received")).toBeGreaterThan(stageRank("negotiating"));
  });

  it("the rank table is strictly ordered through the whole visible flow", () => {
    const flow = ["queued", "rfq-sent", "awaiting-response", "replied", "negotiating", "offer-received"];
    for (let i = 1; i < flow.length; i++) {
      expect(STAGE_ORDER[flow[i]]).toBeGreaterThan(STAGE_ORDER[flow[i - 1]]);
    }
  });
});

describe("2. one shop is one thread key, whatever the spelling", () => {
  // `contacted` is stamped with the number Google Places gave us (national);
  // `replied` with the number the inbound JID gave us (international). Keyed on
  // raw digits those are two different primary keys, so the ledger split into a
  // vendor-less `replied` row beside a stuck `contacted` one.
  const googleForm = "081236954642";
  const jidForm = "6281236954642";

  it("raw digits genuinely disagree - this is not a hypothetical", () => {
    expect(digitsOnly(googleForm)).not.toBe(digitsOnly(jidForm));
  });

  it("the identity key does not", () => {
    expect(identityKey(googleForm)).toBe(identityKey(jidForm));
    expect(identityKey("81236954642")).toBe(identityKey(jidForm));
  });
});

describe("3. the drill window is decided by the NEWEST anchor", () => {
  const drill = { vendorId: "test-6281236954642" };
  const real = { vendorId: "vendor-arka", rfq: { days: 3 } };

  it("a stale drill anchor no longer poisons a re-contacted real thread", () => {
    // Newest-first. A real RFQ sent an hour ago, a drill stamp from last week.
    const rows = [row(real, 1 * HOURS), row(drill, 168 * HOURS)];
    expect(classifyIngestDetailed(rows, Date.now())).toEqual({
      ok: true,
      reason: "active-thread",
    });
  });

  it("a genuine drill still retires on the short window", () => {
    const rows = [row(drill, DRILL_INGEST_WINDOW_MS + HOURS)];
    expect(classifyIngestDetailed(rows, Date.now()).reason).toBe("drill-expired");
  });

  it("a fresh drill is still ingestible inside its window", () => {
    expect(classifyIngestDetailed([row(drill, HOURS)], Date.now()).ok).toBe(true);
  });

  it("a row that is BOTH keeps the tighter window - privacy wins the tie", () => {
    const both = { vendorId: "test-62812", rfq: { days: 3 } };
    const rows = [row(both, DRILL_INGEST_WINDOW_MS + HOURS)];
    expect(classifyIngestDetailed(rows, Date.now()).ok).toBe(false);
  });

  it("a real thread inside 14 days is ingestible; past it, expired", () => {
    expect(classifyIngestDetailed([row(real, 24 * HOURS)], Date.now()).reason).toBe("active-thread");
    expect(classifyIngestDetailed([row(real, 15 * 24 * HOURS)], Date.now()).reason).toBe(
      "thread-expired"
    );
  });
});

describe("4. our own outage is never reported as a deliberate outcome", () => {
  it("thread-unreadable is LOUD and says it retries", () => {
    expect(isLoudDrop("thread-unreadable")).toBe(true);
    const item = dropFeedItem("inbound-dropped", JSON.stringify({ reason: "thread-unreadable" }));
    expect(item?.detail).toMatch(/retries automatically/);
  });

  it("origin-mismatch is LOUD and explains itself rather than going silent", () => {
    expect(isLoudDrop("origin-mismatch")).toBe(true);
    const item = dropFeedItem("inbound-dropped", JSON.stringify({ reason: "origin-mismatch" }));
    expect(item?.detail).toBeTruthy();
    expect(item?.detail).not.toMatch(/couldn't be processed automatically/);
  });

  it("vendor-gate stays BENIGN - the privacy gate doing its job is not an alarm", () => {
    expect(isLoudDrop("vendor-gate")).toBe(false);
    expect(dropFeedItem("inbound-dropped", JSON.stringify({ reason: "vendor-gate" }))).toBeNull();
  });

  it("unresolved-identity stays LOUD - that IS a muted shop reply", () => {
    expect(isLoudDrop("unresolved-identity")).toBe(true);
  });
});
