import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { promiseOf, reconcileRfq } from "./rental-params";
import type { StructuredRFQ } from "../types";

// ONE SEARCH, ONE TRUTH (owner report 6, wave B).
//
// THE FIELD CASE: the owner searched 5 days, finished, then searched 4 days -
// and the same shop's thread welded the new hunt to the old one. The opener
// read fetched the first outbound EVER, promiseOf() preferred that old
// opener, reconcileRfq() overwrote the new 4 with the old 5, and the duration
// RAIL then "corrected" every correct draft back to 5. The agent typed
// "any chance you can do a bit better for 5 days?" under a shop that had just
// quoted "4 days for 1,000B".
//
// The fix is a boundary, not a patch: everything promise-shaped is fenced at
// the newest session-closed marker. These tests pin every fence and execute
// the exact mechanism.

const rfq = (durationDays: number): StructuredRFQ =>
  ({
    vehicleClass: "scooter",
    transmission: "any",
    durationDays,
    accessories: [],
    fulfillment: "any",
    vendorMessage: "",
  }) as unknown as StructuredRFQ;

describe("the mechanism, executed", () => {
  it("an OLD opener in reach overwrites the new search's duration (the bug)", () => {
    const oldOpener = rfq(5);
    const newAnchor = rfq(4);
    const promise = promiseOf(oldOpener, null, newAnchor);
    const resolved = reconcileRfq(newAnchor, promise);
    // This is WHY the fence must exist: with the old opener visible, 5 wins.
    expect(resolved?.durationDays).toBe(5);
  });

  it("with the old opener fenced out, the new search keeps its own terms", () => {
    const newAnchor = rfq(4);
    // Boundary excluded the old row: the opener the resolver sees is the NEW
    // search's own first outbound (or nothing at all).
    const promise = promiseOf(undefined, null, newAnchor);
    const resolved = reconcileRfq(newAnchor, promise);
    expect(resolved?.durationDays).toBe(4);
  });
});

describe("every promise-shaped read is fenced at the session boundary", () => {
  const tc = readFileSync(join(process.cwd(), "src/lib/wa/thread-context.ts"), "utf8");

  it("a sessionBoundary helper reads the newest session-closed marker", () => {
    expect(tc).toMatch(/async function sessionBoundary/);
    expect(tc).toMatch(/raw->>kind=eq\.session-closed&order=received_at\.desc&limit=1/);
  });

  it("resolveThreadContext's opener is the CURRENT search's first outbound", () => {
    // The opener query carries the boundary bound before its ascending sort.
    expect(tc).toMatch(/\$\{sinceBound\}&order=received_at\.asc&limit=1&or=\$\{or\}/);
  });

  it("the rfq anchor only comes from in-session rows; identity may not", () => {
    expect(tc).toMatch(/rows\.find\(\(r\) => inSession\(r\) && r\.raw\?\.rfq != null\)/);
    // Identity (vendor name/id) is durable and still reads the full window.
    expect(tc).toMatch(/rows\.find\(\(r\) => r\.raw\?\.vendorId\)/);
  });

  it("the self-heal cannot adopt a dead thread into a new search", () => {
    expect(tc).toMatch(/!anchor && gate\.ok && rows\.some\(inSession\)/);
  });

  it("promisedRfq (draft/custom-send path) is fenced the same way", () => {
    const fn = tc.slice(tc.indexOf("export async function promisedRfq"), tc.indexOf("export async function resolveThreadContext"));
    expect(fn).toMatch(/sessionBoundary\(senderEmail\)/);
    expect(fn).toMatch(/\$\{sinceBound\}&order=received_at\.asc&limit=1/);
  });
});

describe("the composer's memory is cut at the boundary too", () => {
  const loop = readFileSync(join(process.cwd(), "src/lib/agent-loop.ts"), "utf8");

  it("history/thread reads carry the boundary bound", () => {
    // Both the outbound and inbound history reads take the bound.
    const matches = loop.match(/\$\{sinceBound\}&order=received_at\.desc&limit=24/g) ?? [];
    expect(matches.length).toBe(2);
    expect(loop).toMatch(/sessionBoundaryAt\s*\?\s*`&received_at=gt\./);
  });
});

describe("per-search thread state dies with the session", () => {
  const close = readFileSync(join(process.cwd(), "src/lib/session-close.ts"), "utf8");

  it("resets rounds, standing quote, confirm ledger and price-watch", () => {
    for (const k of ['"round"', '"firmCount"', '"pricePerDay"', '"declined"']) {
      expect(close, `field key ${k}`).toContain(k);
    }
    for (const k of ['"quotedPricePerDay"', '"confirmAsked"', '"awaitingConfirmation"', '"priceWatchArmed"']) {
      expect(close, `digest key ${k}`).toContain(k);
    }
  });

  it("un-mutes threads the previous search closed", () => {
    // hasClosed() greps digest facts for these words; the previous search's
    // decline answered the previous request, never the next one.
    expect(close).toMatch(/closed\|goodbye\|declined\|walked away/);
    expect(close).toMatch(/phase: "opening"/);
    // AND THE RESET IS VERSIONED (audit F033): a bare thread_key PATCH left
    // `version` untouched, so a turn holding the pre-close version still won
    // its own cas afterwards and wrote every deleted key straight back.
    expect(close).toMatch(/patchThreadFields\(/);
    expect(close).not.toMatch(/sbUpdate\(\s*\n?\s*"negotiation_threads"/);
  });
});
