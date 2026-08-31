// READER/WRITER RECONCILIATION for agent_events - the meta-test that makes the
// flattering-zero class unreintroducible.
//
// The audit found five surfaces counting a kind nothing ever wrote
// (push-failed, push-skipped, human-takeover, turn-latency on the live path,
// judge scores) - each a reader with no writer, rendering as a confident 0 on
// an owner panel. This test holds three properties against the SOURCE TREE, so
// the drift cannot come back silently:
//   1. every kind a query reads from agent_events is in the registry;
//   2. every kind read has writer evidence somewhere in src;
//   3. every registered kind has writer evidence (a registry row is a claim).
//
// "Writer evidence" is a literal in VALUE position (`kind: "k"`, a ternary
// arm, a mapping value) on a line that is not itself a query filter - the
// three real writer shapes in this codebase (direct insert, conditional kind,
// READING_EVENT-style map). A literal used as a map KEY (`"k": ...`), a bare
// list element, or inside `kind=eq./in.` is reader-shaped and does not count.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { AGENT_EVENT_KINDS } from "./events";

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const files = sourceFiles(join(process.cwd(), "src")).map((p) => ({
  path: p.replace(process.cwd() + "/", ""),
  code: stripComments(readFileSync(p, "utf8")),
}));

// ---- READ kinds: the query literal of every call on "agent_events" ---------
const readKinds = new Map<string, string[]>(); // kind -> reading files
for (const f of files) {
  // The second argument's string/template literal of any call whose first
  // argument is "agent_events" - scoping to THAT literal is what stops a
  // neighbouring whatsapp_messages query in the same Promise.all from being
  // misattributed.
  for (const call of f.code.matchAll(
    /\w+(?:<[^>()]*>)?\(\s*\n?\s*"agent_events",\s*\n?\s*(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*")/g
  )) {
    const q = call[1];
    for (const m of q.matchAll(/kind=eq\.([a-z][a-z0-9_-]*)(?![a-z0-9_-])/g)) {
      readKinds.set(m[1], [...(readKinds.get(m[1]) ?? []), f.path]);
    }
    for (const m of q.matchAll(/kind=in\.\(([^)]*)\)/g)) {
      for (const piece of m[1].split(",")) {
        const t = piece.trim().replace(/^"|"$/g, "");
        if (/^[a-z][a-z0-9_-]*$/.test(t)) {
          readKinds.set(t, [...(readKinds.get(t) ?? []), f.path]);
        }
      }
    }
  }
}

// ---- WRITER evidence: value-position literals off the query path -----------
const writerEvidence = new Map<string, string[]>(); // kind -> writing files
for (const f of files) {
  for (const line of f.code.split("\n")) {
    if (/kind=eq\.|kind=in\./.test(line)) continue; // a filter, not a write
    for (const m of line.matchAll(/[?:]\s*"([a-z][a-z0-9_-]*)"(?!\s*:)/g)) {
      writerEvidence.set(m[1], [...(writerEvidence.get(m[1]) ?? []), f.path]);
    }
  }
}
// SQL writers count too: retention.sql's 'retention-ran' heartbeat is a real
// writer that lives outside src/ (the prune function inserts it per run). The
// scan is shaped like the TS one - an insert into agent_events with a literal
// kind - so a future SQL-side event registers the same way.
for (const sqlPath of ["supabase/retention.sql", "supabase/schema.sql"]) {
  const sql = readFileSync(join(process.cwd(), sqlPath), "utf8");
  for (const m of sql.matchAll(
    /insert into public\.agent_events[\s\S]{0,200}?values \('([a-z][a-z0-9_-]*)'/g
  )) {
    writerEvidence.set(m[1], [...(writerEvidence.get(m[1]) ?? []), sqlPath]);
  }
}

describe("agent_events reader/writer reconciliation", () => {
  it("sanity: both extractions found the known population", () => {
    // If either scan silently broke, these anchors fail before the properties
    // below start vacuously passing.
    expect(readKinds.has("engine-v3-turn")).toBe(true);
    expect(readKinds.has("push-skipped")).toBe(true);
    expect(writerEvidence.has("funnel-stage")).toBe(true);
    expect(writerEvidence.has("vision-empty")).toBe(true); // the mapping-value shape
    expect(writerEvidence.has("human-takeover")).toBe(true); // the ternary shape
  });

  it("every kind a query reads is in the registry", () => {
    const registry = new Set<string>(AGENT_EVENT_KINDS);
    const unregistered = [...readKinds.keys()].filter((k) => !registry.has(k));
    expect(
      unregistered.map((k) => `${k} (read in ${readKinds.get(k)![0]})`),
      "readers of unregistered kinds - register the kind or delete the dead reader"
    ).toEqual([]);
  });

  it("every kind read has writer evidence - no reader counts what nothing writes", () => {
    const orphans = [...readKinds.keys()].filter((k) => !writerEvidence.has(k));
    expect(
      orphans.map((k) => `${k} (read in ${readKinds.get(k)![0]})`),
      "reader-only kinds - the flattering-zero class this test exists to block"
    ).toEqual([]);
  });

  it("every registered kind has writer evidence - a registry row is a claim", () => {
    const dead = AGENT_EVENT_KINDS.filter((k) => !writerEvidence.has(k));
    expect(
      dead,
      "registered kinds with no writer in src - remove the row or restore the writer"
    ).toEqual([]);
  });

  it("the registry has no duplicates", () => {
    expect(new Set(AGENT_EVENT_KINDS).size).toBe(AGENT_EVENT_KINDS.length);
  });
});
