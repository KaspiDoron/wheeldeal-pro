import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

import { outboxKey } from "./phone-key";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// A MIGRATION THAT LOOKS APPLIED IS THE LEAST DEBUGGABLE KIND OF DEAD CODE.
//
// `wa_outbox.to_key` was added with a unique index and a comment explaining the
// exact bug it fixes: one shop stored as both "639661952196" and "09661952196"
// held TWO live pending rows, and a single drain sent both inside the same
// second. The DDL ran clean. Nothing ever wrote the column.
//
// With to_key always NULL the index falls back to
// `coalesce(to_key, to_number) = to_number` - character-for-character the
// exact-string behaviour it was migrated to replace - and parkOutboxOnce
// repeated the same mistake in application code, scoping its delete-then-insert
// on `to_number=eq.`. So the duplicate-suppression everyone believed was live
// had been quietly inert since the day it shipped.

describe("one shop is one key, whatever the spelling", () => {
  it("REPRODUCTION: the two spellings of one Philippine number collapse", () => {
    expect(outboxKey("639661952196")).toBe(outboxKey("09661952196"));
  });

  it("...and formatting never changes the answer", () => {
    expect(outboxKey("+66 93 103 4552")).toBe(outboxKey("66931034552"));
    expect(outboxKey("+66-93-103-4552")).toBe(outboxKey("0931034552"));
  });

  it("different shops stay different", () => {
    expect(outboxKey("66931034552")).not.toBe(outboxKey("66812345678"));
  });

  it("a number too short for a national tail still yields a usable key", () => {
    expect(outboxKey("12345")).toBe("12345");
    expect(outboxKey("")).toBe("");
  });
});

describe("every write stamps it, and the scope reads it", () => {
  it("parkOutboxOnce scopes on the shop, not on the spelling", () => {
    const park = readCode("src/lib/wa/park.ts");
    expect(park).toMatch(/const key = outboxKey\(row\.toNumber\)/);
    expect(park).toMatch(/to_key=eq\.\$\{encodeURIComponent\(\s*key\s*\)\}/);
    expect(park).toMatch(/to_key: key/);
  });

  it("...and the to_number scope survives ONLY as the not-yet-migrated fallback", () => {
    // This pin used to say `to_number=eq.` must not appear at all, because an
    // exact-string scope is what made this function unable to do its job: a
    // shop stored under two spellings kept two live pending rows.
    //
    // It now appears once, deliberately, behind a schema probe - because
    // `to_key` is newer than some databases this code can reach, and against
    // those the to_key scope 400s and EVERY agent reply park fails. A possible
    // duplicate is a much better failure than a guaranteed silence.
    //
    // So the pin holds the shape rather than the absence: to_key is the branch
    // taken whenever the column exists, and to_number is reachable only when it
    // does not.
    const park = readCode("src/lib/wa/park.ts");
    expect(park).toMatch(/const hasToKey = \(await tableReady\("wa_outbox", "to_key"\)\) === "ready";/);
    const scope = park.slice(park.indexOf("const scope = "), park.indexOf("await sbDelete("));
    expect(scope).toMatch(/hasToKey\s*\?/);
    // to_key on the true branch, to_number on the false branch - in that order.
    expect(scope.indexOf("to_key=eq.")).toBeGreaterThan(-1);
    expect(scope.indexOf("to_number=eq.")).toBeGreaterThan(scope.indexOf("to_key=eq."));
    // And nowhere else in the file does an unguarded to_number scope appear.
    expect(park.split("to_number=eq.").length - 1).toBe(1);
  });

  it("every wa_outbox insert site stamps to_key", () => {
    // graph/engine.ts left this list in Wave 8: its lost-claim path parks
    // through parkOutboxOnce (which owns the to_key seatbelt) instead of a
    // raw insert the partial unique index could silently reject.
    const files = [
      "src/lib/wa-guard.ts",
      "src/app/api/outreach/route.ts",
      "src/app/api/outreach/mass/route.ts",
    ];
    for (const f of files) {
      const code = readCode(f);
      const inserts = code.split(`sbInsert("wa_outbox", [`).slice(1);
      expect(inserts.length).toBeGreaterThan(0);
      for (const chunk of inserts) {
        // The record literal ends well within 600 chars of the insert call.
        //
        // W8: it must be the SEATBELTED spelling. `to_key` arrives by
        // `alter table ... add column if not exists`, so a database that has
        // not re-run schema.sql does not have it - and PostgREST 400s a record
        // naming an unknown column, killing the whole insert. park.ts probed;
        // these four named it unconditionally, so on an un-migrated database
        // every non-drain guard caller got {allow:false} with no row and no
        // queuedUntil: told "queued" with nothing queued anywhere.
        expect(chunk.slice(0, 600)).toMatch(/\.\.\.\(await outboxToKeyPatch\(/);
        expect(chunk.slice(0, 600)).not.toMatch(/\bto_key: outboxKey\(/);
      }
    }
  });
});

describe("and the schema stops pretending", () => {
  it("the objects whose code never followed are marked as such", () => {
    const schema = read("supabase/schema.sql");
    expect(schema).toMatch(/SHIPPED AHEAD OF THEIR CODE, AND THE CODE/);
    expect(schema).toMatch(/wa_outbox\.to_key\s+- NOW WRITTEN/);
    expect(schema).toMatch(/dedupe_key - SUPERSEDED/);
    expect(schema).toMatch(/wa_turns\s+- SUPERSEDED/);
    expect(schema).toMatch(/wa_thread_locks\s+- SUPERSEDED/);
  });
});
