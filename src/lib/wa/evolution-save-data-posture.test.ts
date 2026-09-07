import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// AUDIT F221 (+ the RUNBOOK half of its fixConcern).
//
// The missed-reply recovery sweep reads a 10-row tail per chat via Evolution's
// `/chat/findMessages`, and THAT ENDPOINT SERVES FROM THE SAVE-DATA STORE. So
// `DATABASE_SAVE_DATA_NEW_MESSAGE` and `..._CHATS` must be TRUE on every host,
// exactly as render.yaml and deploy/fleet/docker-compose.yml already ship them
// and as CLAUDE.md declares. A host built with them false answers an empty
// /chat/findMessages, the sweep recovers nothing, and a traveller placed on it
// by host-region keeps a thread parked at `contacted` with a reply that exists
// only on their phone.
//
// The Oracle copy-paste cloud-config in GUIDE.md carried the exact INVERSE of
// that posture, and the single existing guard
// (beta30-readiness.test.ts: `toMatch(/DATABASE_SAVE_DATA_NEW_MESSAGE\s*=\s*true/)`)
// was satisfied by the CORRECT block 80 lines above it and never inspected the
// `-e` flags. So the drifted copy hid behind the good one.
//
// The docs are the subject here, so this test parses them rather than mocking a
// store: it collects EVERY assignment of the five save-data keys across all
// three dialects (render.yaml `- key:/value:`, GUIDE's `KEY = value` table and
// its `-e KEY="value"` docker one-liner, compose's `KEY: "value"`) and pins both
// halves - that every occurrence carries the required posture, AND that the
// unguarded shape (`NEW_MESSAGE`/`CHATS` set false) appears nowhere at all.

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** The posture CLAUDE.md declares and render.yaml + docker-compose.yml ship. */
const REQUIRED: Record<string, string> = {
  INSTANCE: "true", // the Baileys auth state - the link itself
  NEW_MESSAGE: "true", // the missed-reply sweep reads this store
  CHATS: "true", // ditto - /chat/findMessages needs the chat rows
  MESSAGE_UPDATE: "false", // nothing reads it; receipts arrive as events
  CONTACTS: "false", // the full contact book is heavy and unread
};

/** Files that configure or instruct how to configure an Evolution host. */
const CONFIG_SOURCES = ["render.yaml", "GUIDE.md", "deploy/fleet/docker-compose.yml"];

interface Assignment {
  file: string;
  key: string;
  value: string;
}

/**
 * Every assignment of a DATABASE_SAVE_DATA_* key, in any of the dialects these
 * files use. Kept deliberately dialect-blind: a new copy in a new format is
 * still an assignment, and the point of the sweep is that no copy hides.
 */
function saveDataAssignments(file: string): Assignment[] {
  const text = read(file);
  const out: Assignment[] = [];
  const inline = /DATABASE_SAVE_DATA_([A-Z_]+)\s*[:=]\s*"?([A-Za-z]+)"?/g;
  const yamlKeyed = /DATABASE_SAVE_DATA_([A-Z_]+)\s*\n\s*value:\s*"?([A-Za-z]+)"?/g;
  for (const re of [inline, yamlKeyed]) {
    for (const m of text.matchAll(re)) {
      out.push({ file, key: m[1], value: m[2].toLowerCase() });
    }
  }
  return out;
}

describe("F221: every documented Evolution host carries the save-data posture the sweep needs", () => {
  it("finds the save-data block in each of the three config dialects", () => {
    for (const file of CONFIG_SOURCES) {
      const found = saveDataAssignments(file);
      // A parser that silently matches nothing would make every assertion below
      // vacuously true, which is how the original single-toMatch guard failed.
      expect(
        found.filter((a) => a.key in REQUIRED).length,
        `no DATABASE_SAVE_DATA_* assignment parsed out of ${file}`
      ).toBeGreaterThanOrEqual(4);
    }
  });

  it("EVERY assignment in EVERY dialect matches the required posture", () => {
    for (const file of CONFIG_SOURCES) {
      for (const a of saveDataAssignments(file)) {
        const want = REQUIRED[a.key];
        if (!want) continue; // an unknown save-data key is not this test's call
        expect(
          a.value,
          `${file}: DATABASE_SAVE_DATA_${a.key} is "${a.value}", must be "${want}"`
        ).toBe(want);
      }
    }
  });

  it("REGRESSION: the store the sweep reads is never turned off anywhere", () => {
    for (const file of CONFIG_SOURCES) {
      const text = read(file);
      expect(text).not.toMatch(/DATABASE_SAVE_DATA_NEW_MESSAGE\s*[:=]\s*"?false/);
      expect(text).not.toMatch(/DATABASE_SAVE_DATA_CHATS\s*[:=]\s*"?false/);
    }
  });

  it("the Oracle copy-paste one-liner carries the posture AND the no-Redis half of the crash fix", () => {
    const guide = read("GUIDE.md");
    const dockerRun = guide
      .split("\n")
      .filter((l) => l.includes("docker run") && l.includes("evolution-api"));
    expect(dockerRun.length, "GUIDE.md no longer has an Oracle docker run line").toBeGreaterThan(0);
    for (const line of dockerRun) {
      expect(line).toContain('-e DATABASE_SAVE_DATA_NEW_MESSAGE="true"');
      expect(line).toContain('-e DATABASE_SAVE_DATA_CHATS="true"');
      expect(line).toContain('-e DATABASE_SAVE_DATA_CONTACTS="false"');
      expect(line).toContain('-e DATABASE_SAVE_DATA_MESSAGE_UPDATE="false"');
      // The half of the documented Evolution crash fix that needs no second
      // container: stop persisting the "is on WhatsApp" lookups via Prisma.
      // (The Redis half is deliberately NOT pulled into this single-container
      // path - CACHE_LOCAL_ENABLED stays true there.)
      expect(line).toContain('-e DATABASE_SAVE_IS_ON_WHATSAPP="false"');
      expect(line).toContain('-e CACHE_LOCAL_ENABLED="true"');
    }
  });

  it("turning the store ON comes with the 7-day prune the Privacy Policy promises", () => {
    const guide = read("GUIDE.md");
    // The same prune the fleet lane runs (deploy/fleet/docker-compose.yml) and
    // that legal.ts discloses - a hand-built host needs it too, because the
    // store now holds a transient copy of every message on the linked number.
    expect(guide).toMatch(/DELETE FROM\s+\\?"Message/);
    expect(guide).toMatch(/604800/); // the 7-day window, in seconds
    expect(guide).toMatch(/7[- ]day/i);
    expect(read("src/lib/legal.ts")).toMatch(/7 days/);
  });

  it("the launch-gate checklist states the posture the code needs, not its inverse", () => {
    const runbook = read("RUNBOOK.md");
    // The gate used to read "SAVE_DATA_NEW_MESSAGE/CONTACTS/CHATS false on
    // every host", which would have an owner tick a box for the configuration
    // that breaks reply recovery.
    expect(runbook).not.toMatch(/SAVE_DATA_NEW_MESSAGE[^\n]*\n?[^\n]*false on every host/);
    expect(runbook).toMatch(/SAVE_DATA_NEW_MESSAGE/);
    expect(runbook).toMatch(/SAVE_DATA_CHATS/);
    // and it names the store as TRUE, with the prune as its price.
    const line = runbook
      .split("\n")
      .findIndex((l) => l.includes("SAVE_DATA_NEW_MESSAGE"));
    const gate = runbook.split("\n").slice(line, line + 6).join("\n");
    expect(gate).toMatch(/true/i);
    expect(gate).toMatch(/prune/i);
  });
});
