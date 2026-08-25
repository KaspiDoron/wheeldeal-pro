import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

import { recordConsent, consentLedger, UNRECORDED_KIND } from "./consent";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// THE ACCEPTANCE HAPPENED AND THE SYSTEM CANNOT PROVE IT.
//
// `consent_events` is a NEW table. The code that writes it can reach a database
// where supabase/schema.sql has not been re-run - the insert 400s, recordConsent
// returns false, and every caller discards the boolean. So the one module built
// to guarantee "a consent nobody recorded is a consent you cannot rely on" could
// itself fail to record a consent, silently, at the exact moment it mattered:
// the WhatsApp linking release, and the deal terms at booking.

type Call = { url: string; body: unknown };

function stubSupabase(opts: { consentEventsOk: boolean }) {
  const calls: Call[] = [];
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (u.includes("/consent_events") && !opts.consentEventsOk) {
      return {
        ok: false,
        status: 400,
        text: async () => '{"code":"42P01","message":"relation does not exist"}',
        json: async () => ({}),
      } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => [], text: async () => "" } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

describe("REPRODUCTION: a lost ledger row left no trace at all", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("when consent_events is missing, the acceptance lands in agent_events instead", async () => {
    const calls = stubSupabase({ consentEventsOk: false });
    const ok = await recordConsent({ email: "A@B.co", kind: "wa_link", version: "2026-07-15" });

    // Still false - the caller is not lied to about the ledger.
    expect(ok).toBe(false);

    const crumb = calls.find((c) => c.url.includes("/agent_events"));
    expect(crumb, "a failed ledger write must leave a breadcrumb").toBeTruthy();
    const row = (crumb!.body as Record<string, unknown>[])[0];
    expect(row.kind).toBe(UNRECORDED_KIND);
    const detail = JSON.parse(String(row.detail)) as Record<string, unknown>;
    expect(detail.email).toBe("a@b.co"); // normalized, so the read-back can match
    expect(detail.consentKind).toBe("wa_link");
    expect(detail.version).toBe("2026-07-15");
  });

  it("a successful ledger write does NOT write a breadcrumb", async () => {
    const calls = stubSupabase({ consentEventsOk: true });
    expect(await recordConsent({ email: "a@b.co", kind: "terms" })).toBe(true);
    expect(calls.some((c) => c.url.includes("/agent_events"))).toBe(false);
  });

  it("an empty email is not an acceptance and writes nothing", async () => {
    const calls = stubSupabase({ consentEventsOk: false });
    expect(await recordConsent({ email: "   ", kind: "terms" })).toBe(false);
    expect(calls.length).toBe(0);
  });
});

describe("the fallback is not write-only", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("consentLedger merges breadcrumbs in, flagged degraded, newest first", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/consent_events")) {
        return new Response(
          JSON.stringify([
            { kind: "terms", version: "v1", context: null, accepted_at: "2026-07-01T00:00:00.000Z" },
          ]),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify([
          {
            created_at: "2026-07-20T00:00:00.000Z",
            detail: JSON.stringify({
              email: "a@b.co",
              consentKind: "wa_link",
              version: "v1",
              at: "2026-07-20T00:00:00.000Z",
            }),
          },
          // Somebody else's breadcrumb must not appear in this user's proof view.
          {
            created_at: "2026-07-21T00:00:00.000Z",
            detail: JSON.stringify({ email: "other@x.co", consentKind: "terms", version: "v1" }),
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const rows = await consentLedger("A@B.co");
    expect(rows.map((r) => r.kind)).toEqual(["wa_link", "terms"]); // newest first
    expect(rows[0].degraded).toBe(true);
    expect(rows[1].degraded).toBeUndefined();
    expect(rows.some((r) => r.kind === "terms" && r.degraded)).toBe(false);
  });
});

describe("REPRODUCTION: /api/legal/accept said ok:true whatever happened", () => {
  const route = readCode("src/app/api/legal/accept/route.ts");

  it("both writes are captured, not discarded inside the closure", () => {
    expect(route).toMatch(/recorded = await recordConsent\(/);
    expect(route).toMatch(/stamped = await stampTermsVersion\(/);
  });

  it("a failed STAMP is a 503 - the gate cannot close, so do not tell the browser it did", () => {
    // FirstTouchTerms dismisses on res.ok. Returning 200 on an unwritten
    // terms_version tells it to close a modal that the next page load raises
    // again: an endless loop with no error anywhere.
    expect(route).toMatch(/if \(!stamped\) \{/);
    expect(route).toMatch(/\{ status: 503 \}/);
  });

  it("...but a failed LEDGER row still lets the user in", () => {
    // The acceptance is legally real once terms_version is stamped. Barring
    // someone from the product over a missing audit row helps nobody, and the
    // breadcrumb above means it is not actually lost.
    expect(route).toMatch(/return NextResponse\.json\(\{ ok: true, recorded, version: TERMS_VERSION \}\);/);
  });
});

describe("REPRODUCTION: the gate would have locked out every user", () => {
  const me = readCode("src/app/api/auth/me/route.ts");

  it("needsTerms is conditional on the column that closes it being writable", () => {
    expect(me).toMatch(/gateReady = \(await tableReady\("app_users", "terms_version"\)\) === "ready";/);
    expect(me).toMatch(/needsTerms: needsReacceptance\(profile\) && gateReady,/);
  });

  it("...and a suppressed gate is reported, not hidden", () => {
    expect(me).toMatch(/termsGateDegraded: needsReacceptance\(profile\) && !gateReady,/);
  });

  it("the probe is only paid for when the gate would actually fire", () => {
    // An extra Supabase round trip on every /me poll for every signed-in user
    // who has already accepted would be a real cost for no information.
    expect(me).toMatch(/if \(profile && needsReacceptance\(profile\)\) \{/);
  });

  it("needsReacceptance itself stays pure - the policy is testable without a database", () => {
    const consent = readCode("src/lib/consent.ts");
    const fn = consent.slice(
      consent.indexOf("export function needsReacceptance"),
      consent.indexOf("export function reacceptanceReason")
    );
    expect(fn).not.toMatch(/await|tableReady|sbSelect/);
  });
});
