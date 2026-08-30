// WIRING CHECK - the ledger is only as true as its writers. stages.test.ts
// proves the rules; THIS file pins that every stage in the vocabulary has a
// writer at the evidence point the design named, so a refactor cannot silently
// orphan a rung (the exact failure mode the audit found five times over:
// readers with no writers rendering as confident zeros).
//
// Source pins, deliberately: the sites live inside route handlers and the
// drain loop, which no unit harness executes end-to-end - the route-level
// funnel e2e is a RECORDED deferral (RUNBOOK.md: a faithful harness means
// emulating PostgREST semantics across a dozen tables; a mocked-into-
// tautology version would be the fake-test class the audit condemned). Each
// pin is scoped to its file so a hit elsewhere cannot satisfy it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const outreach = read("src/app/api/outreach/route.ts");
const mass = read("src/app/api/outreach/mass/route.ts");
const ingest = read("src/lib/wa/ingest.ts");
const loop = read("src/lib/agent-loop.ts");
const live = read("src/lib/spte/live.ts");
const guard = read("src/lib/wa-guard.ts");
const bookings = read("src/app/api/bookings/route.ts");
const closeDeal = read("src/app/api/negotiate/close-deal/route.ts");
const sessionClose = read("src/lib/session-close.ts");

describe("every funnel stage has its writer at the designed evidence point", () => {
  it("selected: the single Ask (restart) and the mass batch (no restart)", () => {
    expect(outreach).toMatch(/"selected",\s*\n\s*"traveller asked this shop/);
    expect(outreach).toMatch(/\{ restart: true \}/);
    expect(mass).toMatch(/"selected",\s*\n\s*"mass outreach included this shop"/);
    // Mass must NOT restart - it sweeps shops already mid-conversation.
    expect(mass).not.toMatch(/restart: true/);
  });

  it("contact_queued: both park paths in both routes", () => {
    expect(outreach.match(/"contact_queued"/g)?.length).toBe(2);
    expect(mass.match(/"contact_queued"/g)?.length).toBe(2);
  });

  it("contacted: the direct-send TRUTH-RULE row and the drain's delivery", () => {
    expect(outreach).toMatch(/kind === "rfq" \? "contacted" : "negotiating"/);
    expect(mass).toMatch(/"contacted",\s*\n\s*"RFQ delivered to the shop"/);
    expect(guard).toMatch(/mk === "rfq" \? "contacted" : "negotiating"/);
  });

  it("replied: stamped at the inbound store, deliberately before any understanding", () => {
    expect(ingest).toMatch(/"replied",\s*\n\s*"inbound message stored"/);
  });

  it("understood vs price_received: the split that ends the sticker promotion", () => {
    expect(loop).toMatch(/"price_received", "shop quoted a grounded price"/);
    expect(loop).toMatch(/"understood", "reply carried an actionable fact"/);
    // A substitute's price must not claim the requested vehicle's price rung.
    expect(loop).toMatch(/priced = Boolean\(usablePrice\) && extraction\.matchesSpec !== false/);
  });

  it("price_verified: the vision-reconcile confirmation", () => {
    expect(loop).toMatch(/"price_verified",\s*\n\s*"typed price matches the price sheet photo"/);
  });

  it("negotiating / terms_pending / terms_collected: the engine's own moves, quote-gated", () => {
    expect(live).toMatch(/"terms_collected"/);
    expect(live).toMatch(/"terms_pending"/);
    expect(live).toMatch(/"negotiating"/);
    // All three rungs require a standing quote.
    expect(live).toMatch(/const quoted = \(outcome\.digest\.quotedPricePerDay \?\? 0\) > 0/);
    expect(live).toMatch(/!quoted\s*\n\s*\? undefined/);
  });

  it("declined and out_of_stock: the comprehension laterals", () => {
    expect(loop).toMatch(/"declined", "shop walked away"/);
    expect(loop).toMatch(/"out_of_stock", "shop said the vehicle is not available"/);
    // Explicit availability is the only key out of out_of_stock.
    expect(loop).toMatch(/overridesOutOfStock: extraction\.shopUnavailable === false/);
  });

  it("unreachable: only at the RFQ give-up, keyed on the row's own kind", () => {
    expect(guard).toMatch(/kind === "rfq"[\s\S]{0,400}"unreachable",\s*\n\s*"gave up delivering the RFQ"/);
  });

  it("booked: the booking store and the deal lock, both with availability override", () => {
    expect(bookings).toMatch(/"booked",\s*\n\s*"booking stored"/);
    expect(closeDeal).toMatch(/"booked",\s*\n\s*"traveller locked the deal"/);
    expect(bookings).toMatch(/overridesOutOfStock: true/);
  });

  it("dead: session close writes the death event and clears the row for reuse", () => {
    expect(sessionClose).toMatch(/to: "dead"/);
    expect(sessionClose).toMatch(/patch\.stage = null/);
    // A booked/completed thread did not die - no death event over a win.
    expect(sessionClose).toMatch(/t\.stage !== "booked" && t\.stage !== "completed"/);
  });

  it("the orphan events gained their join columns (wa-send-unconfirmed / EVERY wa-send-dropped)", () => {
    const unconfirmed = guard.slice(guard.indexOf('kind: "wa-send-unconfirmed"'));
    expect(unconfirmed.slice(0, 400)).toContain("user_email: row.sender_key");
    // Every WRITE site (kind: with a trailing comma - the prose mentions of the
    // kind name don't match), not just the first: the duplicate-hold give-up
    // was a third writer the first-occurrence check missed.
    const writeSites = [...guard.matchAll(/kind: "wa-send-dropped",/g)];
    expect(writeSites.length).toBeGreaterThanOrEqual(2);
    for (const m of writeSites) {
      const window = guard.slice(m.index!, m.index! + 400);
      expect(window).toContain("user_email: row.sender_key");
      expect(window).toContain("to_number: row.to_number");
    }
  });
});
