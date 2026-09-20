import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// ONE PURPOSE, TWO DOORS - AND THE TWO DOORS STAMPED DIFFERENT DOCUMENTS.
//
// A consent row's `version` says WHICH TEXT the person answered. The cookie
// banner stamps COOKIE_POLICY_VERSION (lib/cookies/server.ts); the Profile
// toggle passed no version at all, so recordConsent fell back to TERMS_VERSION.
// Both constants read "2026-09-16" on the day this was written, which is the
// only reason nobody saw it: the defect was latent behind a coincidence, and the
// first cookie-policy bump would have split one purpose's ledger across two
// version vocabularies - every Profile flip reading as an answer to a document
// it was never about.
//
// So the test forces the two versions APART. A test that ran against the real
// constants would pass today whatever the route did.

// vi.hoisted: vi.mock factories are lifted above every import, so a plain
// top-level const would not exist yet when the manifest factory runs.
const { COOKIE_V } = vi.hoisted(() => ({ COOKIE_V: "2099-01-01-cookie-policy" }));

vi.mock("@/lib/cookies/manifest", async (original) => ({
  ...(await original<typeof import("@/lib/cookies/manifest")>()),
  COOKIE_POLICY_VERSION: COOKIE_V,
}));
vi.mock("@/lib/session", () => ({
  getSession: async () => ({ email: "t@example.com", plan: "free", role: "user" }),
}));
vi.mock("@/lib/runtime-config", async () => {
  const h = await import("@/lib/privacy/postgrest-store.test-helper");
  return h.runtimeConfigMock();
});
// No consent cookie on this request: the cookie half of the route is a no-op,
// and what is under test is the ledger row alone.
vi.mock("next/headers", () => ({
  cookies: () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: () => new Headers(),
}));

import { store } from "@/lib/privacy/postgrest-store.test-helper";
import { TERMS_VERSION } from "@/lib/legal";
import { CATEGORY_CONSENT_KIND } from "@/lib/cookies/server";
import { POST } from "./route";

const flip = (kind: string, granted: boolean) =>
  POST(
    new Request("http://local/api/profile/consent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, granted }),
    })
  );

const ledgerRow = (kind: string) =>
  store.rows("consent_events").find((r) => r.kind === kind) as
    | { version?: string; granted?: boolean }
    | undefined;

beforeEach(() => store.reset());

describe("EXECUTED: a Profile toggle stamps the version of the document it answers", () => {
  it("the premise holds - the two versions really are apart in this test", () => {
    expect(COOKIE_V).not.toBe(TERMS_VERSION);
  });

  it("every cookie-category kind carries COOKIE_POLICY_VERSION, exactly like the banner", async () => {
    // Driven off CATEGORY_CONSENT_KIND, not a pasted list: a fourth category
    // added to the banner must not be able to reopen this from Profile.
    for (const kind of Object.values(CATEGORY_CONSENT_KIND)) {
      const res = await flip(kind, true);
      expect(res.status, kind).toBe(200);
      expect(ledgerRow(kind)?.version, kind).toBe(COOKIE_V);
      expect(ledgerRow(kind)?.version, kind).not.toBe(TERMS_VERSION);
    }
  });

  it("a WITHDRAWAL of a cookie kind carries it too", async () => {
    await flip("cookies_marketing", false);
    expect(ledgerRow("cookies_marketing")).toMatchObject({ version: COOKIE_V, granted: false });
  });

  it("commercial_insights is not a cookie category and keeps the Terms version", async () => {
    // The other direction matters as much: stamping the cookie policy on a
    // purpose the cookie policy never mentions is the same defect, mirrored.
    await flip("commercial_insights", true);
    expect(ledgerRow("commercial_insights")?.version).toBe(TERMS_VERSION);
  });
});
