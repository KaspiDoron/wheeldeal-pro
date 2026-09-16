import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// THE GOVERNANCE CONSOLE - the parts that are promises rather than pixels.
//
// A management console over personal data is a security surface with a
// compliance label on it, so what gets pinned here is the SHAPE of the
// authority, not the layout:
//
//   - the subject file is counted from the ERASURE REGISTRY, so "what we hold"
//     and "what we delete" cannot diverge;
//   - it returns counts, never rows;
//   - reads are management, destruction and content are owner-only;
//   - every privileged action is audited INCLUDING the refusals;
//   - an unreadable table is a dash, never a zero.

vi.mock("server-only", () => ({}));

const db: {
  counts: Record<string, number | null>;
  defaultCount: number | null;
  inserts: { table: string; rows: Record<string, unknown>[] }[];
  auditRows: Record<string, unknown>[] | null;
  ledgerRows: Record<string, unknown>[];
  insertFails: boolean;
  countCalls: { table: string; filter: string; column?: string }[];
} = {
  counts: {},
  defaultCount: 0,
  inserts: [],
  auditRows: [],
  ledgerRows: [],
  insertFails: false,
  countCalls: [],
};

vi.mock("../runtime-config", () => ({
  sbCountDark: async (table: string, filter: string, column?: string) => {
    db.countCalls.push({ table, filter, column });
    return table in db.counts ? db.counts[table] : db.defaultCount;
  },
  sbSelectDark: async (table: string) => {
    if (table === "admin_audit") return db.auditRows;
    if (table === "consent_events") return db.ledgerRows;
    return [];
  },
  sbSelect: async (table: string) => (table === "consent_events" ? db.ledgerRows : []),
  sbInsert: async (table: string, rows: Record<string, unknown>[]) => {
    db.inserts.push({ table, rows });
    return !db.insertFails;
  },
  sbUpdate: async () => true,
  supabaseConfigured: () => true,
  getConfig: async () => undefined,
  getConfigFresh: async () => ({ value: "" }),
}));

import { recordAdminAction, readAdminAudit, ADMIN_ACTIONS, describeAction } from "./audit";
import { buildSubjectFile, splitConsentKinds } from "./subject";
import { USER_TABLES } from "../privacy/user-tables";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

beforeEach(() => {
  db.counts = {};
  db.defaultCount = 0;
  db.inserts = [];
  db.auditRows = [];
  db.ledgerRows = [];
  db.insertFails = false;
  db.countCalls = [];
});

// ---- the audit trail --------------------------------------------------------

describe("the audit trail records, and says so when it cannot", () => {
  it("writes an append-only row with actor, subject and outcome", async () => {
    const ok = await recordAdminAction({
      actorEmail: "  Owner@Test.CO ",
      actorRole: "owner",
      action: "subject.lookup",
      subjectEmail: "Person@Test.CO",
      detail: { knownRows: 12 },
    });
    expect(ok).toBe(true);
    const row = db.inserts[0].rows[0];
    expect(db.inserts[0].table).toBe("admin_audit");
    expect(row.actor_email).toBe("owner@test.co");
    expect(row.subject_email).toBe("person@test.co");
    expect(row.action).toBe("subject.lookup");
    expect(row.outcome).toBe("ok");
  });

  it("a failed write returns false rather than pretending", async () => {
    // An operator acting on someone's data deserves to know their action went
    // unrecorded - every caller surfaces this boolean.
    db.insertFails = true;
    expect(await recordAdminAction({ actorEmail: "a@b.co", actorRole: "owner", action: "subject.lookup" })).toBe(false);
  });

  it("refusals are recorded, not only successes", async () => {
    await recordAdminAction({
      actorEmail: "admin@test.co",
      actorRole: "admin",
      action: "subject.erase",
      outcome: "refused",
      detail: { reason: "owner-only" },
    });
    expect(db.inserts[0].rows[0].outcome).toBe("refused");
  });

  it("detail is bounded, so one caller cannot write a document per lookup", async () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) wide[`k${i}`] = "v";
    wide.long = "x".repeat(5000);
    wide.nested = { deep: true };
    await recordAdminAction({
      actorEmail: "a@b.co",
      actorRole: "owner",
      action: "data.browse",
      detail: wide,
    });
    const detail = db.inserts[0].rows[0].detail as Record<string, unknown>;
    expect(Object.keys(detail).length).toBeLessThanOrEqual(12);
    expect(detail.nested).toBeUndefined();
    for (const v of Object.values(detail)) {
      if (typeof v === "string") expect(v.length).toBeLessThanOrEqual(200);
    }
  });

  it("an UNREADABLE trail is named, never rendered as an empty log", async () => {
    // The whole point. "No admin has touched this data" and "we cannot see who
    // touched this data" are opposite findings, and only one is reassuring.
    db.auditRows = null;
    const page = await readAdminAudit();
    expect(page.entries).toEqual([]);
    expect(page.degraded).toEqual(["admin_audit"]);
  });

  it("an empty trail is NOT degraded", async () => {
    db.auditRows = [];
    const page = await readAdminAudit();
    expect(page.degraded).toEqual([]);
  });

  it("every action in the vocabulary has a human label", () => {
    for (const [name, label] of Object.entries(ADMIN_ACTIONS)) {
      expect(label.length).toBeGreaterThan(8);
      expect(describeAction(name)).toBe(label);
    }
    // A row written by a newer deploy renders its raw name rather than blank.
    expect(describeAction("something.new")).toBe("something.new");
  });
});

// ---- the subject file -------------------------------------------------------

describe("the subject file is counted from the erasure registry", () => {
  it("asks about every registered table - not a hand-kept list", () => {
    // If this ever drifts, the console tells a regulator we do not hold data we
    // would in fact delete.
    return buildSubjectFile("a@b.co").then(() => {
      const asked = new Set(db.countCalls.map((c) => c.table));
      for (const entry of USER_TABLES) {
        expect(asked.has(entry.table), `${entry.table} was never counted`).toBe(true);
      }
    });
  });

  it("counts on the key column, so a table without `id` is not read as broken", async () => {
    await buildSubjectFile("a@b.co");
    const consent = db.countCalls.find((c) => c.table === "consent_events");
    expect(consent?.column).toBe("email");
    // A jsonb path is a valid filter but not a portable projection, so it falls
    // back to `id` rather than 400ing and painting the table as unreadable.
    const messages = db.countCalls.filter((c) => c.table === "whatsapp_messages");
    expect(messages.length).toBeGreaterThan(0);
    for (const m of messages) expect(m.column).toBe("id");
  });

  it("an unreadable table is null and NAMED, and is left out of the total", async () => {
    db.defaultCount = 3;
    db.counts.offers = null;
    const file = await buildSubjectFile("a@b.co");
    const offers = file.tables.find((t) => t.table === "offers");
    expect(offers?.rows).toBeNull();
    expect(file.degraded).toContain("offers");
    // The sum excludes it rather than treating null as zero, so the number is
    // never quietly short while looking complete.
    expect(file.knownRows).toBeGreaterThan(0);
    expect(file.tables.filter((t) => t.rows === null).length).toBeGreaterThan(0);
  });

  it("one unreadable key on a multi-key table makes the whole table unknown", async () => {
    // whatsapp_messages is registered twice (sender AND receiver). A partial
    // count presented as a total is exactly the lie this file avoids.
    db.counts.whatsapp_messages = null;
    const file = await buildSubjectFile("a@b.co");
    expect(file.tables.find((t) => t.table === "whatsapp_messages")?.rows).toBeNull();
  });

  it("reports whether an account row exists, and can say it does not know", async () => {
    db.counts.app_users = 1;
    expect((await buildSubjectFile("a@b.co")).accountExists).toBe(true);
    db.counts.app_users = 0;
    expect((await buildSubjectFile("a@b.co")).accountExists).toBe(false);
    db.counts.app_users = null;
    const unknown = await buildSubjectFile("a@b.co");
    expect(unknown.accountExists).toBeNull();
    expect(unknown.degraded).toContain("app_users");
  });

  it("derives cookie consent from the NEWEST ledger row per kind", async () => {
    db.ledgerRows = [
      { kind: "analytics", version: "2026-09-16", granted: false, accepted_at: "2026-09-10T00:00:00Z" },
      { kind: "analytics", version: "2026-09-16", granted: true, accepted_at: "2026-09-01T00:00:00Z" },
      { kind: "cookies_marketing", version: "2026-09-16", granted: true, accepted_at: "2026-09-05T00:00:00Z" },
    ];
    const file = await buildSubjectFile("a@b.co");
    const analytics = file.cookieConsent.find((c) => c.category === "analytics");
    const marketing = file.cookieConsent.find((c) => c.category === "marketing");
    const preferences = file.cookieConsent.find((c) => c.category === "preferences");
    expect(analytics?.granted).toBe(false); // the withdrawal is newer
    expect(marketing?.granted).toBe(true);
    // NEVER ANSWERED is null, not false. A person who was never asked has not
    // refused, and a console that renders those the same way cannot be used to
    // answer "did we ask them".
    expect(preferences?.granted).toBeNull();
    expect(preferences?.at).toBeNull();
  });

  it("separates mandatory acceptances from opt-in purposes", () => {
    const { mandatory, optIn } = splitConsentKinds();
    expect(mandatory).toContain("terms");
    expect(mandatory).toContain("wa_risk");
    expect(optIn).toContain("analytics");
    expect(optIn).toContain("cookies_marketing");
    expect(optIn).toContain("commercial_insights");
    // A console that mixes them invites an operator to try to toggle a contract.
    for (const k of optIn) expect(mandatory).not.toContain(k);
  });
});

// ---- the authority model ----------------------------------------------------

describe("who is allowed to do what", () => {
  const subject = stripComments(read("src/app/api/admin/governance/subject/route.ts"));
  const register = stripComments(read("src/app/api/admin/governance/register/route.ts"));
  const csv = stripComments(read("src/app/api/admin/governance/export/route.ts"));
  const subjectExport = stripComments(
    read("src/app/api/admin/governance/subject-export/route.ts")
  );

  it("reading a subject file is management; destroying one is OWNER", () => {
    expect(subject).toMatch(/export async function GET[\s\S]{0,200}requireManagement\(\)/);
    expect(subject).toMatch(/export async function DELETE[\s\S]{0,200}requireOwner\(\)/);
  });

  it("the overview is management - it is counts, not content", () => {
    expect(register).toMatch(/requireManagement\(\)/);
  });

  it("both file downloads are OWNER only", () => {
    // Handing over a person's whole message history, or the entire consent
    // register, is categorically different from reading a count.
    expect(csv).toMatch(/requireOwner\(\)/);
    expect(subjectExport).toMatch(/requireOwner\(\)/);
  });

  it("every refused attempt is audited, not silently 403'd", () => {
    for (const [name, route] of [
      ["subject", subject],
      ["csv", csv],
      ["subject-export", subjectExport],
    ] as const) {
      expect(route, `${name} must audit its refusals`).toMatch(/outcome: "refused"/);
    }
  });

  it("erasure is typed, not clicked, and refuses the owner account", () => {
    expect(subject).toMatch(/if \(confirm !== email\)/);
    expect(subject).toMatch(/isOwner\(email\)/);
  });

  it("the subject lookup returns COUNTS, never rows", () => {
    // The content path is a separate, separately-audited, owner-only endpoint.
    // A console that renders somebody's transcripts as a side effect of typing
    // their address is a surveillance tool with a compliance label on it.
    expect(subject).toMatch(/buildSubjectFile\(email\)/);
    expect(subject).not.toMatch(/buildDsarExport/);
    expect(subjectExport).toMatch(/buildDsarExport/);
  });

  it("the lookup is rate-limited per actor, so enumeration hits a wall", () => {
    expect(subject).toMatch(/rateLimit\(`gov-subject:\$\{session\.email\}`/);
  });
});

describe("the CSV is an artefact somebody can safely open", () => {
  const csv = read("src/app/api/admin/governance/export/route.ts");

  it("quotes properly and neutralises spreadsheet formula injection", () => {
    // An address crafted as `=cmd|...` is a real attack on whoever opens the
    // register in Excel.
    expect(csv).toMatch(/\/\^\[=\+\\-@\\t\\r\]\//);
    expect(csv).toMatch(/replace\(\/"\/g, '""'\)/);
  });

  it("an unreadable ledger produces NO FILE rather than an empty one", () => {
    // A CSV with a header and nothing under it is a signed statement that
    // nobody ever consented.
    expect(stripComments(csv)).toMatch(/if \(rows === null\)/);
    expect(stripComments(csv)).toMatch(/status: 502/);
  });

  it("a truncated register says so inside the file", () => {
    expect(csv).toMatch(/TRUNCATED at \$\{MAX_ROWS\} rows/);
  });
});

describe("the DSAR document has ONE implementation", () => {
  it("the person's own download and the operator's both call buildDsarExport", () => {
    // Two implementations would drift, and the operator's copy is the one
    // nobody checks and the one that ends up in front of a regulator.
    const own = stripComments(read("src/app/api/profile/export/route.ts"));
    const ops = stripComments(read("src/app/api/admin/governance/subject-export/route.ts"));
    expect(own).toMatch(/buildDsarExport\(session\.email\)/);
    expect(ops).toMatch(/buildDsarExport\(email\)/);
    // ...and the assembly is not duplicated in either route.
    expect(own).not.toMatch(/USER_TABLES/);
    expect(ops).not.toMatch(/USER_TABLES/);
  });

  it("the shared assembly still names what it could not read", () => {
    const dsar = stripComments(read("src/lib/privacy/dsar.ts"));
    expect(dsar).toMatch(/sbSelectStrict/);
    expect(dsar).toMatch(/nameUnreadable/);
    expect(dsar).toMatch(/delete data\[key\]/);
  });
});

describe("management actions on accounts are audited", () => {
  const users = stripComments(read("src/app/api/admin/users/route.ts"));

  it("a role change is recorded either way", () => {
    expect(users).toMatch(/action: "user\.role"/);
    expect(users).toMatch(/outcome: roleWrote \? "ok" : "failed"/);
  });

  it("a status change records the READ-BACK, not the intent", () => {
    // A trail that logs what was attempted rather than what persisted is a
    // trail that disagrees with the database it exists to explain.
    expect(users).toMatch(/action: "user\.status"/);
    expect(users).toMatch(/outcome: persisted \? "ok" : "failed"/);
  });
});

describe("the console renders unknown as a dash, never zero", () => {
  const ui = read("src/components/admin/GovernanceConsole.tsx");

  it("uses the shared fail-dark primitives", () => {
    expect(ui).toMatch(/import \{ DegradedBanner, Num \} from "\.\/primitives"/);
    expect(ui).toMatch(/<DegradedBanner degraded=/);
  });

  it("a null consent rate renders as an em dash, not 0%", () => {
    expect(ui).toMatch(/c\.rate === null \?/);
    expect(ui).toMatch(/&mdash;/);
  });

  it("says out loud when a lookup could not be audited", () => {
    expect(ui).toMatch(/audited === false/);
  });

  it("the erase button stays disabled until the address is typed back", () => {
    expect(ui).toMatch(/eraseConfirm\.trim\(\)\.toLowerCase\(\) !== file\.email/);
  });
});
