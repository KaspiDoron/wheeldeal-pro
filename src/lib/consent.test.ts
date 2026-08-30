import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

import { needsReacceptance, reacceptanceReason, CONSENT_KINDS } from "./consent";
import {
  INDEMNITY_CLAUSES,
  OPERATOR_NAME,
  TERMS_SECTIONS,
  TERMS_VERSION,
  withOperator,
} from "./legal";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// A CONSENT NOBODY RECORDED.
//
// The legal text was complete and the checkboxes were mandatory. What did not
// exist was the PROOF: which version anyone agreed to, whether they saw the
// WhatsApp release the times they linked a number, and whether they confirmed
// the deal terms on the booking they actually made.

describe("REPRODUCTION: a version bump nobody was asked about", () => {
  it("a user who accepted THIS version is not asked again", () => {
    expect(
      needsReacceptance({ termsAcceptedAt: 1, termsVersion: TERMS_VERSION })
    ).toBe(false);
  });

  it("a user who accepted an OLDER version is asked again", () => {
    // TERMS_VERSION moved and app_users.terms_version was never written, so
    // this test would have been unwritable: there was no version on the record
    // to compare against, and the answer was always "no, carry on".
    expect(needsReacceptance({ termsAcceptedAt: 1, termsVersion: "2020-01-01" })).toBe(true);
    expect(reacceptanceReason({ termsAcceptedAt: 1, termsVersion: "2020-01-01" })).toBe(
      "version-bump"
    );
  });

  it("a user who never accepted is asked", () => {
    expect(needsReacceptance(null)).toBe(true);
    expect(needsReacceptance({})).toBe(true);
    expect(reacceptanceReason({})).toBe("first-time");
  });

  it("the PRE-LEDGER population is asked once, then recorded properly", () => {
    // They agreed to something; we cannot say what. Treating that as current
    // would carry the gap forward forever.
    expect(needsReacceptance({ termsAcceptedAt: 1 })).toBe(true);
  });

  it("the comparison is against the version PASSED, so a bump is testable", () => {
    expect(needsReacceptance({ termsAcceptedAt: 1, termsVersion: "v1" }, "v1")).toBe(false);
    expect(needsReacceptance({ termsAcceptedAt: 1, termsVersion: "v1" }, "v2")).toBe(true);
  });
});

describe("the operator's name is a key, not a constant with a TODO", () => {
  it("the placeholder is replaced everywhere it appears", () => {
    const out = withOperator(TERMS_SECTIONS, "WheelDeal Ltd.");
    const joined = out.map((s) => s.body).join(" ");
    expect(joined).toContain("WheelDeal Ltd.");
    expect(joined).not.toContain(OPERATOR_NAME);
  });

  it("the summaries the first-touch modal renders are substituted too", () => {
    const out = withOperator(INDEMNITY_CLAUSES, "WheelDeal Ltd.");
    expect(out.every((c) => !c.summary.includes(OPERATOR_NAME))).toBe(true);
    expect(out.map((c) => c.anchor)).toEqual(INDEMNITY_CLAUSES.map((c) => c.anchor));
  });

  it("an unset key renders the exact reviewed text, at no cost", () => {
    expect(withOperator(TERMS_SECTIONS, "")).toBe(TERMS_SECTIONS);
    expect(withOperator(TERMS_SECTIONS, undefined)).toBe(TERMS_SECTIONS);
    expect(withOperator(TERMS_SECTIONS, OPERATOR_NAME)).toBe(TERMS_SECTIONS);
  });

  it("a name with regex characters does not corrupt the document", () => {
    const out = withOperator(TERMS_SECTIONS, "A.B (C) $1 Ltd.");
    expect(out.map((s) => s.body).join(" ")).toContain("A.B (C) $1 Ltd.");
  });

  it("it is offered in the Key Vault, where the owner can actually set it", () => {
    const config = readCode("src/lib/config.ts");
    expect(config).toMatch(/name: "OPERATOR_NAME"/);
  });
});

describe("every acceptance surface now writes a record", () => {
  it("the vocabulary covers the six acceptances plus the two W9 opt-in purposes", () => {
    // `number_sharing` was added deliberately, not incidentally. Under the
    // business-number handoff (plan Part 12) WheelDeal's own official number
    // gives a rental agency the traveller's phone number and the agency then
    // messages them unprompted. That is new personal-data disclosure AND a
    // genuinely surprising experience, so it is recorded on its own rather than
    // folded into the general terms - a traveller startled by a message from a
    // rental shop is a trust failure, not a UX detail.
    //
    // W9 adds `analytics` and `commercial_insights` - the two kinds that are
    // NOT mandatory acceptances but opt-in processing purposes, default OFF,
    // toggled from Profile with withdrawals recorded as rows.
    expect([...CONSENT_KINDS].sort()).toEqual(
      [
        "ai_responsibility",
        "analytics",
        "commercial_insights",
        "deal_terms",
        "number_sharing",
        "terms",
        "wa_link",
        "wa_risk",
      ].sort()
    );
  });

  it("the number-sharing consent says what will actually happen", () => {
    // Constraint from the owner: the approach must be 100% clear to the user so
    // nothing is misunderstood. That means naming both halves - we hand over
    // the number, AND the shop messages them - not just the disclosure.
    const legal = readCode("src/lib/legal.ts");
    const c = legal.slice(legal.indexOf('id: "number_sharing"'), legal.indexOf('id: "ai_responsibility"'));
    expect(c).toMatch(/my WhatsApp number/i);
    expect(c).toMatch(/message me directly/i);
    expect(c).toMatch(/turn this off/i);
  });

  it("REPRODUCTION: the booking checkbox reaches the server", () => {
    // It gated its own submit button and was never sent anywhere - at the one
    // moment the traveller commits real money, the only record was a React
    // state variable that stopped existing when the sheet closed.
    const sheet = readCode("src/components/BookingSheet.tsx");
    expect(sheet).toMatch(/dealTermsAccepted: dealTerms,/);
    const close = readCode("src/app/api/negotiate/close-deal/route.ts");
    expect(close).toMatch(/if \(body\.dealTermsAccepted === true\) \{/);
    expect(close).toMatch(/kind: "deal_terms",/);
  });

  it("REPRODUCTION: linking WhatsApp records the release, per link", () => {
    const connect = readCode("src/app/api/wa/connect/route.ts");
    expect(connect).toMatch(/kind: "wa_link",/);
    // A "try again" re-issues a code on the same instance; it is not a new
    // acceptance and must not inflate the ledger.
    expect(connect).toMatch(/if \(body\.fresh !== true\) \{/);
  });

  it("...and only the last four digits of the number are kept", () => {
    const connect = readCode("src/app/api/wa/connect/route.ts");
    expect(connect).toMatch(/phoneTail: String\(phone \?\? ""\)\.slice\(-4\)/);
  });

  it("the version written is the SERVER's, never the client's", () => {
    // A browser telling us which version it agreed to is a browser we would
    // have to trust about the one fact the record exists to establish.
    const route = readCode("src/app/api/legal/accept/route.ts");
    expect(route).toMatch(/version: TERMS_VERSION,/);
    expect(route).not.toMatch(/body\.version/);
  });

  it("the best-effort writes survive the Cloud Run response boundary", () => {
    // Cloud Run throttles CPU to zero the instant the response flushes, so an
    // un-awaited write simply never happens.
    const route = readCode("src/app/api/legal/accept/route.ts");
    expect(route).toMatch(/await finishBeforeResponse\("consent-record"/);
    const close = readCode("src/app/api/negotiate/close-deal/route.ts");
    expect(close).toMatch(/finishBeforeResponse\("deal-terms-consent"/);
  });

  it("wa_link does something STRONGER than surviving the boundary - it gates", () => {
    // This used to be a `finishBeforeResponse` after `connectInstance`, which
    // meant a failed write happened once the QR had already been minted and
    // there was nothing left to withhold. The one consent whose subject matter
    // is the permanent loss of someone's phone number was the one we were least
    // able to prove.
    //
    // Now it is awaited inline BEFORE the code is issued, and a durable failure
    // refuses the link. Refusing to link is a bad afternoon; linking against an
    // acceptance nobody can produce is what the ledger exists to prevent.
    const connect = readCode("src/app/api/wa/connect/route.ts");
    expect(connect).toMatch(/const recorded = await recordConsentBlocking\(/);
    expect(connect).toMatch(/if \(!recorded\)/);
    expect(connect).toMatch(/status: 503/);
    // ...and it happens before the pairing code exists.
    expect(connect.indexOf("recordConsentBlocking")).toBeLessThan(
      connect.indexOf("await connectInstance(")
    );
  });

  it("only wa_link retries - the rest stay best-effort", () => {
    // A retry loop on every consent would turn a database blip into a slow
    // booking flow for no gain, because those acceptances are reconstructable
    // from the breadcrumb.
    const consent = readCode("src/lib/consent.ts");
    expect(consent).toMatch(/const attempts = input\.kind === "wa_link" \? 3 : 1;/);
  });
});

describe("the first touch is mandatory, and it is decided by the server", () => {
  const gate = readCode("src/components/FirstTouchTerms.tsx");
  const me = readCode("src/app/api/auth/me/route.ts");
  const layout = readCode("src/app/layout.tsx");

  it("the gate is mounted app-wide", () => {
    expect(layout).toMatch(/<FirstTouchTerms \/>/);
  });

  it("whether to show it is computed server-side", () => {
    // A client that computed it could simply not.
    expect(me).toMatch(/needsTerms: needsReacceptance\(profile\)/);
    expect(gate).toMatch(/if \(!alive \|\| !d\?\.session \|\| !d\.profile\?\.needsTerms\) return;/);
  });

  it("it cannot be dismissed - no backdrop close, no Escape, no Modal", () => {
    expect(gate).not.toMatch(/<Modal/);
    expect(gate).not.toMatch(/onClose=\{\(\) => setShow\(false\)\}/);
  });

  it("REPRODUCTION: the gate does NOT open on a failed write", () => {
    // Closing optimistically would put the user in the app with no record of
    // the thing the whole screen exists to record.
    expect(gate).toMatch(/if \(!res\.ok\) \{\s*setFailed\(true\);\s*return;\s*\}/);
  });

  it("it names the six risks from the same list the Terms render", () => {
    expect(gate).toMatch(/INDEMNITY_CLAUSES/);
    // Rendered from the shared clause objects, never a hand-copied paraphrase.
    // `op()` is translate-then-substitute-the-operator-name; the pin follows the
    // field rather than the exact wrapper so it survives that shape.
    expect(gate).toMatch(/\{op\(c\.summary\)\}/);
    expect(gate).toMatch(/\{op\(c\.title\)\}/);
  });

  it("the operator name is substituted AFTER translation, not before", () => {
    // withOperator() used to run over the clause list at module scope, so a
    // deployment with a custom operator name produced strings that were no
    // longer the canonical English - and t() refuses anything outside the
    // catalogue, so the whole consent gate silently fell back to English for
    // every non-English reader. Translate the canonical text, then substitute.
    expect(gate).toMatch(/const clauses = INDEMNITY_CLAUSES;/);
    expect(gate).toMatch(/withOperatorText\(t\(text\), operator\)/);
    expect(gate).not.toMatch(/withOperator\(INDEMNITY_CLAUSES/);
  });
});

describe("the admin self-check can see a missing consent column", () => {
  const info = readCode("src/app/api/admin/deploy-info/route.ts");

  it("probes the version column and the ledger table", () => {
    expect(info).toMatch(/probe\("app_users", "terms_version"\)/);
    expect(info).toMatch(/probe\("consent_events", "email,kind,version"\)/);
  });

  it("and the schema exists for them to probe", () => {
    const schema = readFileSync(join(process.cwd(), "supabase/schema.sql"), "utf8");
    expect(schema).toMatch(/create table if not exists public\.consent_events/);
    expect(schema).toMatch(/alter table public\.app_users add column if not exists terms_version text;/);
  });
});
