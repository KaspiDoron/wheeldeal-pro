import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("server-only", () => ({}));

// AUDIT F025: THE 180-DAY DE-IDENTIFY STRIPPED THE ONLY KEYS ERASURE FINDS
// whatsapp_messages BY - AND WAS NOT ACTUALLY DE-IDENTIFYING.
//
// retention.sql's mid-window UPDATE removed raw.sender and raw.receiver from
// priced rows: the two columns the registry matches the table on. From that
// moment eraseUserData's `raw->>receiver=eq.<email>` matched nothing, sbDelete
// answered true on the 204, and the route reported a clean erasure over rows
// that no window ever deletes (the delete skips anything with a reading). The
// rows were not anonymous either: the shop's JID stayed nested at
// raw.media.key.remoteJid, and raw.lid / raw.instance / raw.quoted survived.
//
// The fix keeps an ERASABLE key that carries no address: the de-identify
// rewrites sender/receiver to the same pseudonym the golden-case provenance
// and the WhatsApp instance name already use (`wd-` + sha256(email)[0:16]),
// the registry matches that pseudonym, and the nested provider key goes.
// Executed: the REAL walker against a Map-backed store holding a live row and
// a de-identified row must delete BOTH - the assertion that failed before.

vi.mock("../runtime-config", async () => {
  const h = await import("./postgrest-store.test-helper");
  return h.runtimeConfigMock();
});
vi.mock("../evolution", () => ({
  disconnectInstance: async () => ({ severed: true, hostsTried: 0, hadLink: false }),
}));

import { store } from "./postgrest-store.test-helper";
import { eraseUserData } from "./erase";
import { USER_TABLES, filterFor } from "./user-tables";
import { pseudonymForEmail } from "./pseudonym";

const EMAIL = "traveller@example.com";
const OTHER = "someone-else@example.com";

beforeEach(() => {
  store.reset();
  store.seed("app_users", [{ email: EMAIL, status: "active", plan: "free", provider: "email" }]);
});

/** The row shape retention.sql leaves behind after the mid-window UPDATE. */
function deidentifiedInbound(email: string, id: number) {
  return {
    id,
    wa_message_id: `MSG-${id}`,
    direction: "inbound",
    from_number: "deidentified",
    to_number: pseudonymForEmail(email),
    body: null,
    received_at: "2026-02-01T10:00:00.000Z",
    raw: {
      receiver: pseudonymForEmail(email),
      reading: { vehicle: "scooter", price: 250 },
      ok: "priced",
      deidentified_at: "2026-08-01T00:00:00.000Z",
    },
  };
}

describe("EXECUTED (F025): de-identified transcript rows still leave with the person", () => {
  it("the walker deletes the live row AND the pseudonymised row, and nobody else's", async () => {
    store.seed("whatsapp_messages", [
      {
        id: 1,
        wa_message_id: "MSG-1",
        direction: "inbound",
        from_number: "66812345678",
        to_number: pseudonymForEmail(EMAIL),
        received_at: "2026-09-01T10:00:00.000Z",
        raw: { receiver: EMAIL, pushName: "Shop" },
      },
      deidentifiedInbound(EMAIL, 2),
      {
        id: 3,
        wa_message_id: "MSG-3",
        direction: "outbound",
        from_number: pseudonymForEmail(EMAIL),
        to_number: "deidentified",
        received_at: "2026-02-01T10:01:00.000Z",
        raw: { sender: pseudonymForEmail(EMAIL), ok: "priced", deidentified_at: "2026-08-01T00:00:00.000Z" },
      },
      deidentifiedInbound(OTHER, 4),
    ]);

    const result = await eraseUserData(EMAIL);
    expect(result.failed).toEqual([]);
    const left = store.rows("whatsapp_messages").map((r) => r.id);
    // THE ASSERTION THAT FAILED BEFORE: rows 2 and 3 survived the erase.
    expect(left).toEqual([4]);
  });

  it("the registry matches the pseudonym on both key columns", () => {
    const entries = USER_TABLES.filter((t) => t.table === "whatsapp_messages" && t.match === "pseudonym");
    expect(entries.map((e) => e.column).sort()).toEqual(["raw->>receiver", "raw->>sender"]);
    expect(filterFor(entries[0], EMAIL)).toBe(`${entries[0].column}=eq.${pseudonymForEmail(EMAIL)}`);
  });
});

describe("retention.sql de-identifies to an erasable pseudonym and strips the nested JID", () => {
  const sql = readFileSync(join(process.cwd(), "supabase/retention.sql"), "utf8");
  const update = sql.slice(sql.indexOf("update public.whatsapp_messages"));
  const stmt = update.slice(0, update.indexOf("get diagnostics deident"));

  it("sender and receiver are REWRITTEN to the wd- pseudonym, not removed", () => {
    // The same expression the golden-case one-off uses, so SQL and
    // pseudonymForEmail agree byte for byte.
    expect(stmt).toMatch(
      /'sender',\s*case when raw \? 'sender'\s*then 'wd-' \|\| left\(encode\(sha256\(convert_to\(lower\(btrim\(raw ->> 'sender'\)\), 'UTF8'\)\), 'hex'\), 16\)/
    );
    expect(stmt).toMatch(
      /'receiver',\s*case when raw \? 'receiver'\s*then 'wd-' \|\| left\(encode\(sha256\(convert_to\(lower\(btrim\(raw ->> 'receiver'\)\), 'UTF8'\)\), 'hex'\), 16\)/
    );
    // The old strip - the shape that made the rows unfindable - is gone.
    expect(stmt).not.toMatch(/raw - 'sender' - 'receiver'/);
  });

  it("the nested provider key and the other identifiers the writers actually set are stripped", () => {
    expect(stmt).toMatch(/#- '\{media,key\}'/);
    for (const k of ["'lid'", "'instance'", "'quoted'", "'contact'", "'englishGloss'", "'pushName'"]) {
      expect(stmt, k).toContain(`- ${k}`);
    }
  });

  it("the guards that made the statement idempotent and evidence-preserving still stand", () => {
    expect(stmt).toMatch(/'deidentified_at', now\(\)/);
    expect(stmt).toMatch(/\(raw ->> 'deidentified_at'\) is null/);
    expect(stmt).toMatch(/\(raw ->> 'reading'\) is not null\s*\n\s*or coalesce/);
  });
});
