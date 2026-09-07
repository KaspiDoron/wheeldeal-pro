// AUDIT F146 (round 2) - the Trips card's closed-hunt verdict, defaulted at the
// CLIENT boundary as well as the server one.
//
// /api/deals now names WHO closed a hunt (`closedBy`), and the card picks its
// copy - and whether it still offers Re-open - from that discriminant. But the
// page read `s.closedBy` verbatim, so any payload that carries the old boolean
// alone (a browser holding a cached bundle against a freshly deployed route, a
// rolling deploy answering from the previous revision, and the CI browser spec
// tests/e2e/trips-list.spec.ts, whose fixture stubs `closed: true` with no
// `closedBy` key at all) fell through BOTH honest arms and rendered
// "Re-open this hunt" over a hunt the traveller had cleared - the exact 404
// button the closed-state copy exists to withdraw.
//
// The server's rule is already "an unlabelled marker is the traveller's own
// clear" (session-life.ts closedByOf). This is that same rule, applied to the
// wire shape the page actually receives, so the strict refusal stays the
// default on both sides of the fetch.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { huntClosure } from "./hunt-closure";

describe("F146 - huntClosure defaults an unlabelled close to the traveller's own clear", () => {
  it("THE BUG: `closed: true` with no closedBy is a clear, not a re-openable hunt", () => {
    // Byte-for-byte the shape tests/e2e/trips-list.spec.ts sends
    // ("a CLOSED hunt says so honestly and offers no live Re-open"): the whole
    // SessionSummary, with `closed: true` and no closedBy key anywhere.
    const e2eFixture = { id: "4", sid: 4, isLatest: false, query: "cleared hunt", closed: true };
    expect(huntClosure(e2eFixture)).toBe("user");
  });

  it("each named closer keeps its own verdict", () => {
    expect(huntClosure({ closed: true, closedBy: "user" })).toBe("user");
    expect(huntClosure({ closed: true, closedBy: "expired" })).toBe("expired");
    expect(huntClosure({ closed: true, closedBy: "deal" })).toBe("deal");
  });

  it("an open hunt is closed by nobody, whatever rides beside the flag", () => {
    expect(huntClosure({ closed: false })).toBeNull();
    expect(huntClosure({})).toBeNull();
    expect(huntClosure({ closed: false, closedBy: null })).toBeNull();
  });

  it("a word this build does not know is still the strict default", () => {
    // A newer route inventing a fourth reason must not unlock Re-open on an
    // older bundle - it must fall back to the refusal that cannot 404.
    expect(huntClosure({ closed: true, closedBy: "something-new" })).toBe("user");
    expect(huntClosure({ closed: true, closedBy: null })).toBe("user");
  });
});

describe("F146 - the Trips card asks the helper, not the raw field", () => {
  const page = readFileSync(join(process.cwd(), "src/app/deals/page.tsx"), "utf8");

  it("routes the card's verdict through huntClosure", () => {
    expect(page).toContain("huntClosure");
  });

  it("no longer branches on the undefaulted wire field", () => {
    // The shape that shipped the regression: an absent closedBy fell past both
    // arms into the Re-open button.
    expect(page).not.toContain('s.closedBy === "user" || s.closedBy === "deal"');
    expect(page).not.toContain('s.closedBy === "expired"');
  });
});
