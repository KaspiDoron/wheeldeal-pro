import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { groupSearchSessions, sessionIdOf } from "./session-life";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// A HUNT THE TRAVELLER CAN SEE IN THE LIST IS "NO LONGER AVAILABLE".
//
// Three routes grouped `searches` rows into hunts with three private copies of
// the same loop. The copies matched; the QUERIES feeding them did not:
//
//   /api/deals          14 days x 30 rows
//   /api/deals/restore  unbounded x 40 rows
//   /api/deals/recheck  unbounded x 40 rows, and did not even SELECT `source`
//
// Restore then matched the tapped hunt by TIMESTAMP, with a one-second
// tolerance, against a boundary computed from its own row set. Past ~30 hunt
// rows the windows truncate the oldest hunt at different rows, the boundaries
// differ by minutes, the match fails, and the traveller is told the hunt is
// gone. `recheck` carried the identical branch, so price re-check broke too.

const row = (id: number, minutesAgo: number, source: string | null = "search") => ({
  id,
  source,
  created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
});

describe("one definition of a search session", () => {
  it("splits hunts on the 30-minute quiet gap, newest first", () => {
    const groups = groupSearchSessions([row(3, 5), row(2, 10), row(1, 200)]);
    expect(groups).toHaveLength(2);
    expect(groups[0].map((r) => r.id).sort()).toEqual([2, 3]);
    expect(groups[1].map((r) => r.id)).toEqual([1]);
  });

  it("a request BUILD is not a hunt", () => {
    // /api/profile writes a row for every RFQ build. They carry the newest
    // created_at and no snapshot, so grouping them makes a hunt start earlier
    // than it really did - which is one of the ways the boundaries drifted.
    const groups = groupSearchSessions([row(2, 5, "panel"), row(1, 6, "search")]);
    expect(groups).toHaveLength(1);
    expect(groups[0].map((r) => r.id)).toEqual([1]);
  });

  it("REPRODUCTION: two different row WINDOWS used to disagree about where a hunt starts", () => {
    // The full hunt, as the unbounded reader sees it.
    const full = [row(4, 5), row(3, 12), row(2, 20), row(1, 28)];
    // The same hunt as a TRUNCATED reader sees it - the oldest rows fell off
    // the end of its LIMIT. This is exactly the 30-vs-40 situation.
    const truncated = full.slice(0, 2);

    const a = groupSearchSessions(full);
    const b = groupSearchSessions(truncated);

    // Both see ONE hunt - but they disagree about when it began.
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0][0].created_at).not.toBe(b[0][0].created_at);

    // So a timestamp match across the two windows fails, with a tolerance of a
    // whole second. That was the bug.
    const startMs = Date.parse(b[0][0].created_at);
    const byTimestamp = a.findIndex(
      (g) => Math.abs(Date.parse(g[0].created_at) - startMs) < 1000
    );
    expect(byTimestamp, "matching by timestamp is what 404'd a live hunt").toBe(-1);

    // The row id does not move when the window does.
    const sid = sessionIdOf(b[0]);
    expect(a.findIndex((g) => g.some((r) => r.id === sid))).toBe(0);
  });

  it("sessionIdOf is the first row's id, and null on an empty group", () => {
    expect(sessionIdOf([row(7, 1), row(8, 2)])).toBe(7);
    expect(sessionIdOf([])).toBeNull();
  });
});

describe("all three routes share the grouping, so they cannot drift again", () => {
  const files = [
    "src/app/api/deals/route.ts",
    "src/app/api/deals/restore/route.ts",
    "src/app/api/deals/recheck/route.ts",
  ];

  it("none of them carries a private copy of the loop", () => {
    for (const f of files) {
      const code = readCode(f);
      expect(code, `${f} must use the shared grouper`).toMatch(/groupSearchSessions\(/);
      // The tell-tale of an inline copy: its own gap constant plus a hand-rolled
      // accumulate loop.
      expect(code, `${f} still groups by hand`).not.toMatch(
        /const groups: [^=]+= \[\];[\s\S]{0,400}?groups\.push\(\[row\]\)/
      );
    }
  });

  it("the two that address a specific hunt accept its row id", () => {
    for (const f of ["src/app/api/deals/restore/route.ts", "src/app/api/deals/recheck/route.ts"]) {
      expect(readCode(f), `${f} must match on sid`).toMatch(/sessionIdOf\(g\) === sid/);
    }
  });

  it("recheck now reads `source`, which it never even selected before", () => {
    // Without it, recheck could not tell a hunt from a request-build and
    // grouped analytics rows as sessions - a third, independent way its
    // boundaries diverged from the list's.
    expect(readCode("src/app/api/deals/recheck/route.ts")).toMatch(/select=id,source,created_at,rfq/);
  });

  it("the list hands the id to the client so it can send it back", () => {
    expect(readCode("src/app/api/deals/route.ts")).toMatch(/sid: group\[0\]\.id \?\? null/);
    expect(readCode("src/app/deals/page.tsx")).toMatch(/sid\?: number \| null/);
  });

  it("nobody reverses the grouper's output a second time", () => {
    // groupSearchSessions already ends with its own reverse ("newest session
    // first" - session-life.ts). The deals route reversed AGAIN, so Trips
    // rendered the OLDEST five hunts, pinned `isLatest` and the free-plan
    // unlock to the oldest one, and disagreed with restore/recheck - which do
    // not reverse - about which hunt `gi === 0` means. `oldestStart` was then
    // taken from the wrong end, so the activity reads only covered the newest
    // hunt and every older card rendered empty.
    for (const f of files) {
      const code = readCode(f);
      // `[...group].reverse()` copies for a within-group newest-value pick and
      // is fine; a bare `groups.reverse()` on the grouper's output is the bug.
      expect(code, `${f} re-reverses the group list`).not.toMatch(/\bgroups\.reverse\(\)/);
    }
  });
});

describe("a cleared hunt is recognisable everywhere, not just at the restore gate", () => {
  it("the list computes a per-group closed flag with the restore route's bounds", () => {
    const code = readCode("src/app/api/deals/route.ts");
    // After this group's newest row, before the next group begins - comparing
    // against the group's FIRST row would mark the search-clear-search-again
    // sequence (one 30-minute group with the clear in the middle) as closed.
    // The bounds are unchanged; audit F146 turned the boolean into a WHO, so
    // the marker's own reason is picked up with it.
    expect(code).toMatch(/closedStamps\.find\(\(m\) => m\.at > groupEnd && m\.at < end\)/);
    expect(code).toMatch(/raw->>kind=eq\.session-closed/);
    expect(code).toMatch(/reason:raw->>reason/);
    expect(code).toMatch(/closedByOf\(m\.reason\)/);
  });

  it("recheck refuses a cleared hunt instead of reporting phantom sends", () => {
    // Without the gate, every send it queued died at the guard's tombstones
    // while the response reported "Asking N shops".
    const code = readCode("src/app/api/deals/recheck/route.ts");
    expect(code).toMatch(/raw->>kind=eq\.session-closed/);
    expect(code).toMatch(/You cleared this hunt/);
    // STRICT read: unknown must refuse to message, never default to sending.
    // (Audit F146 widened the projection with the marker's reason so the
    // refusal can name WHICH close it was - it still refuses every one.)
    expect(code).toMatch(/sbSelectStrict<\{ received_at: string; reason: string \| null \}>/);
    expect(code).toMatch(/closedByOf\(closedRead\.rows\[0\]\?\.reason\)/);
  });

  it("the client offers no live button on a cleared hunt", () => {
    const page = readCode("src/app/deals/page.tsx");
    expect(page).toMatch(/s\.closed \?/);
    // W6.1 replaced `contacted > 0` with `recheckable > 0` (the owner's
    // price + deposit + pick-up rule); the `!s.closed` half is the fact this
    // test is about and it still guards the button.
    expect(page).toMatch(/\(s\.recheckable \?\? 0\) > 0 && !s\.closed \?/);
    // And the restore 404 is no longer collapsed into a retryable error.
    expect(page).toMatch(/d\?\.error === "session-closed"/);
  });

  it("the list's pause read uses the canonical marker family", () => {
    // Unfiltered, the newest session row of ANY kind answered - a pause
    // followed by a clear read as "not paused" while sessionPauseState (which
    // filters the family) still said paused. Two surfaces, one fact.
    expect(readCode("src/app/api/deals/route.ts")).toMatch(
      /raw->>kind=in\.\(session-paused,session-resumed\)/
    );
  });
});
