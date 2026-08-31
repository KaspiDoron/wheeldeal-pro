import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));
vi.mock("../ai", () => ({
  chat: async () => null,
  chatDetailed: async () => ({ text: null }),
  chatVision: async () => null,
  extractJson: () => null,
}));
// The engine's DB boundary, driven per table by `db` below. `sessionTable` is
// the only method these tests execute, so the rest are inert.
const db: {
  offers: Array<Record<string, unknown>>;
  threads: Array<Record<string, unknown>>;
} = { offers: [], threads: [] };
vi.mock("../runtime-config", () => ({
  getConfig: async () => undefined,
  setConfig: async () => {},
  sbInsert: async () => true,
  sbUpdate: async () => {},
  sbSelect: async (table: string) =>
    table === "offers" ? db.offers : table === "negotiation_threads" ? db.threads : [],
  sbSelectStrict: async (table: string) =>
    table === "offers" ? { rows: db.offers } : { error: "missing" as const },
}));
vi.mock("../wa-guard", () => ({
  guardOutbound: async ({ text }: { text: string }) => ({ allow: true, text }),
  afterSend: async () => {},
}));
vi.mock("../search-session", () => ({
  sessionSinceIso: async () => new Date(1_700_000_000_000 - 3 * 3600_000).toISOString(),
  cheapestRivalFor: async () => undefined,
  // W12f: the session table is scoped by search_id now, not by the clock alone
  // - two hunts for the same vehicle class inside 18h used to cross-contaminate
  // the primary engine's leverage. These rows all belong to one hunt.
  currentSession: async () => ({ id: 1 }),
}));

import { planSiblingRebargain, MAX_FANOUT, STAGGER_MIN, FIRST_DELAY_MIN } from "./rebargain";
import { liveGraphIO } from "../graph/engine";
import type { SessionShopRow } from "../graph/types";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// W5.3 - THE SESSION ACTUALLY FIGHTS.
//
// Owner report 5 #9: "some of the more expensive didn't get a message of 'I
// have a lower price of X, can you give me a better price?' ... We are not
// bargaining enough."
//
// The mechanism was not suppressed - it did not exist. The rival card is only
// reachable on a turn that is HAPPENING in a given thread, and a priced thread
// scheduled no return of its own. So the shop at 300 could only ever hear about
// the 200 that landed twenty minutes later if something re-entered its thread,
// and nothing did. `materialDrop`'s docstring has promised "the caller enqueues
// bounded re-bargain wakeups for sibling threads" since the engine shipped; its
// three consumers were a telemetry field, an admin chip and the distiller.

const shop = (over: Partial<SessionShopRow>): SessionShopRow => ({
  vendorId: "b",
  vendorName: "Dearer Shop",
  pricePerDay: 300,
  currency: "THB",
  toNumber: "66812345678",
  ...over,
});

const input = (rows: SessionShopRow[]) => ({
  rows,
  excludeVendorId: "a",
  newLowPerDay: 200,
  currency: "THB",
});

describe("REPRODUCTION: the expensive shop finally hears the number", () => {
  it("a materially dearer sibling is re-entered", () => {
    const out = planSiblingRebargain(input([shop({})]));
    expect(out).toHaveLength(1);
    expect(out[0].vendorId).toBe("b");
    expect(out[0].pricePerDay).toBe(300);
    expect(out[0].delayMinutes).toBe(FIRST_DELAY_MIN);
  });

  it("dearest first - the shops with the most room to move", () => {
    const out = planSiblingRebargain(
      input([
        shop({ vendorId: "b", pricePerDay: 260, toNumber: "1" }),
        shop({ vendorId: "c", pricePerDay: 400, toNumber: "2" }),
        shop({ vendorId: "d", pricePerDay: 320, toNumber: "3" }),
      ])
    );
    expect(out.map((t) => t.pricePerDay)).toEqual([400, 320, 260]);
  });
});

describe("...and it is NOT a spam engine", () => {
  it("never the shop that just quoted - that is arguing with our own floor", () => {
    expect(planSiblingRebargain(input([shop({ vendorId: "a" })]))).toEqual([]);
    expect(planSiblingRebargain(input([shop({ isThisShop: true })]))).toEqual([]);
  });

  it("never a shop that has said 'last price' twice", () => {
    // The firm ladder is this app's promise not to badger. A cheaper rival is
    // new information; it is not a licence to re-open a closed conversation.
    expect(planSiblingRebargain(input([shop({ firmCount: 2 })]))).toEqual([]);
    expect(planSiblingRebargain(input([shop({ firmCount: 1 })]))).toHaveLength(1);
  });

  it("never a dead, closed or closing thread", () => {
    for (const phase of ["dead", "closed", "closing"] as const) {
      expect(planSiblingRebargain(input([shop({ phase })])), phase).toEqual([]);
    }
  });

  it("never a shop that is barely dearer - a turn spent to win nothing", () => {
    expect(planSiblingRebargain(input([shop({ pricePerDay: 205 })]))).toEqual([]);
    expect(planSiblingRebargain(input([shop({ pricePerDay: 240 })]))).toHaveLength(1);
  });

  it("never across currencies - that is invented leverage", () => {
    expect(planSiblingRebargain(input([shop({ currency: "MYR" })]))).toEqual([]);
  });

  it("never a shop with no live thread to re-enter", () => {
    expect(planSiblingRebargain(input([shop({ toNumber: undefined })]))).toEqual([]);
  });

  it("never a shop the traveller took off the table", () => {
    const out = planSiblingRebargain({ ...input([shop({})]), excludeVendorIds: ["b"] });
    expect(out).toEqual([]);
  });

  it("HARD CEILING on messages per drop", () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      shop({ vendorId: `v${i}`, toNumber: `6${i}`, pricePerDay: 300 + i })
    );
    expect(planSiblingRebargain(input(rows))).toHaveLength(MAX_FANOUT);
  });

  it("staggered, so wa-guard is never handed a burst", () => {
    const rows = Array.from({ length: 4 }, (_, i) =>
      shop({ vendorId: `v${i}`, toNumber: `6${i}`, pricePerDay: 400 - i })
    );
    const out = planSiblingRebargain(input(rows));
    expect(out.map((t) => t.delayMinutes)).toEqual([
      FIRST_DELAY_MIN,
      FIRST_DELAY_MIN + STAGGER_MIN,
      FIRST_DELAY_MIN + 2 * STAGGER_MIN,
      FIRST_DELAY_MIN + 3 * STAGGER_MIN,
    ]);
  });

  it("a nonsense low is not an event at all", () => {
    expect(planSiblingRebargain({ ...input([shop({})]), newLowPerDay: 0 })).toEqual([]);
    expect(planSiblingRebargain({ ...input([shop({})]), newLowPerDay: Number.NaN })).toEqual([]);
  });
});

describe("the promise in the docstring is now wired", () => {
  it("materialDrop reaches the planner, not only telemetry", () => {
    const live = read("src/lib/spte/live.ts");
    expect(live).toMatch(/if \(outcome\.materialDrop && input\.ctx\.sender\)/);
    expect(live).toMatch(/planSiblingRebargain/);
    expect(live).toMatch(/swarm-rebargain/);
  });

  it("a priced thread schedules its own return, past the 3-minute pause band", () => {
    const live = read("src/lib/spte/live.ts");
    expect(live).toMatch(/const PRICE_WATCH_MINUTES = \d+/);
    const minutes = Number(live.match(/const PRICE_WATCH_MINUTES = (\d+)/)![1]);
    // The gap the owner described - a quote at 10:00, a cheaper one at 10:20 -
    // cannot be spanned by the model's clamped 1-3 minute pause.
    expect(minutes).toBeGreaterThan(3);
  });

  it("...and exactly ONCE per thread, durably", () => {
    const live = read("src/lib/spte/live.ts");
    expect(live).toMatch(/!outcome\.digest\.priceWatchArmed/);
    expect(live).toMatch(/outcome\.digest\.priceWatchArmed = true/);
    // Durable or it is not a bound: an in-memory flag re-arms on every cold
    // start and the negotiator becomes a slow broadcast loop.
    expect(read("src/lib/spte/digest.ts")).toMatch(/priceWatchArmed/);
  });

  it("the model's own strategic pause is STILL clamped to 3 minutes", () => {
    // Loosening that band would give a hallucinated "wait until they open
    // tomorrow" the run of the thread again - the "until 08:28 AM" incident.
    expect(read("src/lib/spte/wait.ts")).toMatch(/WAIT_MAX_MINUTES = 3/);
  });
});

describe("the emptiers that were still real", () => {
  it("the offers window is bounded per VENDOR, not per row", () => {
    // limit=16 was applied by Postgres BEFORE the per-vendor dedupe, and a
    // negotiation writes one offers row per round - so three chatty shops
    // filled the whole window and every other shop in the hunt was invisible.
    const engine = read("src/lib/graph/engine.ts");
    expect(engine).not.toMatch(/order=created_at\.desc&limit=16`\s*\)\.catch/);
    expect(engine).toMatch(/order=created_at\.desc&limit=200/);
  });

  it("a board price with no currency inherits the session's, not undefined", () => {
    // validRivals requires strict currency equality and a priceless thread row
    // has no currency to inherit - so a price rescued off a photo was dropped
    // by the very next filter.
    expect(read("src/lib/graph/engine.ts")).toMatch(/cheapest\.currency \?\? r\.currency \?\? sessionCurrency/);
  });

  it("ALREADY FIXED BY W4.5: SPTE persists the thread's price", () => {
    // Emptier (1) - every thread row was dropped for having no price. This is
    // a pin, not a change: persistThreadOutcome already writes it.
    expect(read("src/lib/spte/live.ts")).toMatch(/fields\.pricePerDay = input\.usablePrice/);
  });

  it("ALREADY FIXED BY W4.5: bargain reads the STANDING quote", () => {
    // Emptier's cousin - `bargain` required a price in THIS inbound message, so
    // a shop replying "ok for you?" made every price move illegal.
    expect(read("src/lib/spte/policy.ts")).toMatch(/const standingQuote = quoteOnTable\(ctx\)/);
    expect(read("src/lib/spte/policy.ts")).toMatch(/const priceKnown = typeof standingQuote === "number"/);
  });
});

// ---------------------------------------------------------------------------
// THE WIRING, EXECUTED (not read as text).
//
// Everything above this line tests the PLANNER with rows handed to it by the
// test. The defect that survived that suite was one layer earlier: the row the
// planner is actually given. `liveGraphIO().sessionTable` builds the session
// blackboard from two reads - `negotiation_threads` and `offers` - and the
// offers branch REPLACES the thread row. It rebuilt that row without
// `toNumber` or `firmCount`, so:
//
//   - a live thread whose price only exists as an `offers` row (the precise
//     case the offers join was added to rescue) reached the planner with no
//     number to re-enter, and was dropped by "no live thread to re-enter";
//   - a shop that had said "last price" twice lost its firm count on the same
//     path, so the one branch that skipped the ladder would have badgered it.
//
// The pins in "the emptiers that were still real" could not see either, because
// a missing property leaves no string behind to grep for. These run the real
// method and feed its real output to the real planner.
// ---------------------------------------------------------------------------

describe("sessionTable -> planSiblingRebargain, executed end to end", () => {
  const io = liveGraphIO(async () => ({ ok: true }));

  /** The shop we just heard from (the new low) plus one dearer sibling whose
   *  price lives in `offers` while its thread row is priceless. */
  const seed = (threadFields: Record<string, unknown>) => {
    db.threads = [
      {
        vendor_id: "dearer",
        vendor_name: "Dearer Shop",
        to_number: "66812345678",
        phase: "bargain",
        fields: threadFields,
      },
    ];
    db.offers = [
      {
        vendor_id: "dearer",
        vendor_name: "Dearer Shop",
        price_per_day: 300,
        currency: "THB",
        duration_days: 3,
        quote_basis_days: null,
      },
    ];
  };

  it("carries the shop's NUMBER through the offers join, so the swarm can reach it", async () => {
    seed({ fulfillment: "pickup" }); // priceless thread row - offers wins
    const rows = await io.sessionTable("t@example.com", "cheapest", "motorbike-125");
    const row = rows.find((r) => r.vendorId === "dearer");
    expect(row?.pricePerDay).toBe(300);
    expect(row?.toNumber).toBe("66812345678");

    const targets = planSiblingRebargain({
      rows,
      excludeVendorId: "cheapest",
      newLowPerDay: 200,
      currency: "THB",
    });
    expect(targets.map((t) => t.vendorId)).toEqual(["dearer"]);
    expect(targets[0].toNumber).toBe("66812345678");
  });

  it("...and the FIRM COUNT with it, so the ladder still bars a shop that refused twice", async () => {
    seed({ fulfillment: "pickup", digest: { firmCount: 2 } });
    const rows = await io.sessionTable("t@example.com", "cheapest", "motorbike-125");
    expect(rows.find((r) => r.vendorId === "dearer")?.firmCount).toBe(2);

    expect(
      planSiblingRebargain({
        rows,
        excludeVendorId: "cheapest",
        newLowPerDay: 200,
        currency: "THB",
      })
    ).toEqual([]);
  });

  it("a PRICED thread row keeps winning - the offers branch never runs for it", async () => {
    // Guards the fix from the opposite direction: the thread row already
    // carries both fields, and short-circuiting must not change.
    seed({ pricePerDay: 340, currency: "THB", fulfillment: "pickup", digest: { firmCount: 1 } });
    const rows = await io.sessionTable("t@example.com", "cheapest", "motorbike-125");
    const row = rows.find((r) => r.vendorId === "dearer");
    expect(row?.pricePerDay).toBe(340);
    expect(row?.toNumber).toBe("66812345678");
    expect(row?.firmCount).toBe(1);
  });
});
