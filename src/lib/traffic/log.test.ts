import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/runtime-config", () => ({ sbInsert: vi.fn(async () => true) }));
const { shapeTrafficEvent } = await import("./log");
const { parseSubId } = await import("./subid");

const ok = { kind: "unit_loaded", placement: "guide-inline", market: "th", category: "scooter", session: "9a3f01bc", partner: "google" };
const NOW = new Date("2026-09-20T10:00:00Z");

describe("the traffic log stores vocabularies, never what a caller sent", () => {
  it("shapes a clean row and rebuilds the sub-id itself", () => {
    const out = shapeTrafficEvent(ok, ["google"], NOW);
    expect(out).toEqual({
      row: { day: "2026-09-20", kind: "unit_loaded", placement: "guide-inline", market: "th", category: "scooter", partner: "google", sub_id: "p1-mth-cscooter-9a3f01bc", session: "9a3f01bc", term: null },
    });
    expect(parseSubId((out as { row: { sub_id: string } }).row.sub_id)).not.toBeNull();
  });

  it("collapses hostile dimensions to the neutral bucket instead of storing them", () => {
    const out = shapeTrafficEvent({ ...ok, placement: "doron@example.com", market: "+66812345678", category: "<script>" }, ["google"], NOW);
    expect(out).toMatchObject({ row: { placement: "unknown", market: "xx", category: "other", sub_id: "p0-mxx-cother-9a3f01bc" } });
  });

  it("refuses an unknown kind, a malformed session, and a partner nobody configured", () => {
    expect(shapeTrafficEvent({ ...ok, kind: "purchase" }, ["google"])).toEqual({ refused: "unknown kind" });
    expect(shapeTrafficEvent({ ...ok, session: "doron@example.com" }, ["google"])).toEqual({ refused: "bad session" });
    expect(shapeTrafficEvent({ ...ok, session: "9A3F01BC" }, ["google"])).toEqual({ refused: "bad session" });
    expect(shapeTrafficEvent({ ...ok, partner: "evil" }, ["google"])).toEqual({ refused: "unknown partner" });
  });

  // A typed query is free text from a human. It can be a name.
  it("never stores a query a person typed - only a term Google issued", () => {
    const typed = shapeTrafficEvent({ ...ok, kind: "serp_view", term: "john smith bangkok", termFromUnit: false }, ["google"], NOW);
    expect(typed).toMatchObject({ row: { kind: "serp_view", term: null } });
    const issued = shapeTrafficEvent({ ...ok, kind: "serp_view", term: "  scooter   rental\nphuket ", termFromUnit: true }, ["google"], NOW);
    expect(issued).toMatchObject({ row: { term: "scooter rental phuket" } });
  });

  it("drops even an 'issued' term that looks like an address or a phone number", () => {
    for (const term of ["doron@example.com", "call 0812345678 now", "x".repeat(121)]) {
      expect(shapeTrafficEvent({ ...ok, kind: "serp_view", term, termFromUnit: true }, ["google"], NOW)).toMatchObject({ row: { term: null } });
    }
  });

  it("ignores a term on any other kind of event", () => {
    expect(shapeTrafficEvent({ ...ok, kind: "link_click", term: "scooter", termFromUnit: true }, ["google"], NOW)).toMatchObject({ row: { term: null } });
  });
});
