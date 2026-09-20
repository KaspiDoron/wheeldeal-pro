import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// THE ONE ROW ABOUT A PERSON THAT THE ERASURE COULD NOT SEE.
//
// When the consent ledger refuses a write, recordConsent leaves a
// "consent-unrecorded" breadcrumb on agent_events so the acceptance is not
// lost. That breadcrumb carried the person's address INSIDE the free-text
// `detail` payload and left the `user_email` column NULL - while the erasure
// registry matches agent_events on `user_email`, exactly. So the walker's
// DELETE never reached it and the DSAR export never listed it: the person
// erased their account, the route answered "erased", and a row naming them and
// what they consented to stayed behind.
//
// Every other agent_events writer that is about a person stamps the column
// (bookings, replies, wa-guard, the inbound-risk feed). This one now does too,
// and the address stays out of `detail` - a key belongs in the keyed column,
// where the registry, the index and the export can all find it.
//
// Executed: the REAL recordConsent, the REAL walker and the REAL export over a
// Map-backed store.

vi.mock("../runtime-config", async () => {
  const h = await import("./postgrest-store.test-helper");
  return h.runtimeConfigMock();
});
vi.mock("../evolution", () => ({
  disconnectInstance: async () => ({ severed: true, hostsTried: 0, hadLink: false }),
}));

import { store } from "./postgrest-store.test-helper";
import { recordConsent, consentLedger, UNRECORDED_KIND } from "../consent";
import { eraseUserData } from "./erase";
import { buildDsarExport } from "./dsar";
import { USER_TABLES, filterFor } from "./user-tables";

const ALICE = "alice@example.com";
const BOB = "bob@example.com";

const crumbs = () => store.rows("agent_events").filter((r) => r.kind === UNRECORDED_KIND);

beforeEach(() => {
  store.reset();
  store.seed("app_users", [
    { email: ALICE, status: "active", plan: "free", provider: "email" },
    { email: BOB, status: "active", plan: "free", provider: "email" },
  ]);
  // The ledger refuses every write - the breadcrumb path is the one under test.
  store.failWrites.add("consent_events");
});

describe("EXECUTED: the consent breadcrumb is keyed to the person it is about", () => {
  it("the row carries user_email, normalized, and detail does not contain the address", async () => {
    expect(await recordConsent({ email: "  Alice@Example.com ", kind: "wa_link" })).toBe(false);
    expect(crumbs()).toHaveLength(1);
    const row = crumbs()[0];
    expect(row.user_email).toBe(ALICE);
    expect(String(row.detail).toLowerCase()).not.toContain(ALICE);
    expect(String(row.detail).toLowerCase()).not.toContain("alice");
    const detail = JSON.parse(String(row.detail)) as Record<string, unknown>;
    expect(detail.email).toBeUndefined();
    // What the proof view needs is all still there.
    expect(detail.consentKind).toBe("wa_link");
    expect(detail.granted).toBe(true);
  });

  it("the registry's own agent_events filter finds it", async () => {
    await recordConsent({ email: ALICE, kind: "deal_terms" });
    const entry = USER_TABLES.find((t) => t.table === "agent_events");
    expect(entry, "agent_events must stay registered").toBeTruthy();
    expect(store.select("agent_events", `select=*&${filterFor(entry!, ALICE)}`)).toHaveLength(1);
  });

  it("an erasure deletes Alice's breadcrumb and leaves Bob's", async () => {
    await recordConsent({ email: ALICE, kind: "wa_link" });
    await recordConsent({ email: BOB, kind: "wa_link" });
    expect(crumbs()).toHaveLength(2);

    // The ledger outage is over by the time she erases; failWrites would
    // otherwise fail the walker's own consent_events DELETE for a reason that
    // has nothing to do with the breadcrumb.
    store.failWrites.clear();
    const result = await eraseUserData(ALICE);
    expect(result.failed).toEqual([]);
    expect(crumbs().map((r) => r.user_email)).toEqual([BOB]);
    // Nothing anywhere on the table still names her.
    expect(JSON.stringify(store.rows("agent_events")).toLowerCase()).not.toContain(ALICE);
  });

  it("the DSAR export lists it under agent_events", async () => {
    await recordConsent({ email: ALICE, kind: "cookies_marketing", granted: false });
    const doc = await buildDsarExport(ALICE);
    const exported = (doc.data.agent_events ?? []) as { kind?: string }[];
    expect(exported.filter((r) => r.kind === UNRECORDED_KIND)).toHaveLength(1);
  });
});

describe("EXECUTED: the fallback is still not write-only", () => {
  it("consentLedger reads the breadcrumb back by the keyed column, flagged degraded", async () => {
    await recordConsent({ email: ALICE, kind: "cookies_marketing", granted: false, version: "v9" });
    await recordConsent({ email: BOB, kind: "terms" });

    const rows = await consentLedger(ALICE);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "cookies_marketing",
      version: "v9",
      granted: false,
      degraded: true,
    });
  });

  it("a LEGACY breadcrumb (address in detail, no user_email) is still read back", async () => {
    // Rows written before this fix exist on real databases. The proof view
    // must not lose them just because the writer moved on.
    store.seed("agent_events", [
      {
        id: 900,
        kind: UNRECORDED_KIND,
        user_email: null,
        created_at: "2026-08-01T00:00:00.000Z",
        detail: JSON.stringify({ email: ALICE, consentKind: "terms", version: "v1" }),
      },
      {
        id: 901,
        kind: UNRECORDED_KIND,
        user_email: null,
        created_at: "2026-08-02T00:00:00.000Z",
        detail: JSON.stringify({ email: BOB, consentKind: "terms", version: "v1" }),
      },
    ]);
    const rows = await consentLedger(ALICE);
    expect(rows.map((r) => r.kind)).toEqual(["terms"]);
    expect(rows[0].degraded).toBe(true);
  });

  it("a keyed row is attributed by its COLUMN - a detail payload cannot claim somebody else's", async () => {
    store.seed("agent_events", [
      {
        id: 902,
        kind: UNRECORDED_KIND,
        user_email: BOB,
        created_at: "2026-08-03T00:00:00.000Z",
        detail: JSON.stringify({ email: ALICE, consentKind: "wa_link", version: "v1" }),
      },
    ]);
    expect(await consentLedger(ALICE)).toEqual([]);
    expect((await consentLedger(BOB)).map((r) => r.kind)).toEqual(["wa_link"]);
  });
});
