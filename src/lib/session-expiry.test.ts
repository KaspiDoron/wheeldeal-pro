import { describe, it, expect, vi, beforeEach } from "vitest";

// Pins the server-side session lifetime: a signed cookie is REJECTED past 30
// days (maxAge alone only asks the browser nicely - a replayed stolen token
// ignores it), a fresh one passes, and an active session past the halfway
// mark is transparently renewed.

vi.mock("server-only", () => ({}));
vi.mock("./runtime-config", () => ({
  getConfig: async () => undefined,
  // W8 #27: the runtime admin list is read FRESH (single row, 3s) instead of
  // through the 30s whole-vault cache, so a demotion propagates to warm
  // instances in seconds rather than half a minute.
  getConfigFresh: async () => ({ value: undefined }),
  setConfig: async () => {},
}));
vi.mock("./access", () => ({
  getUser: async () => null,
  normalizePlan: () => "free",
}));
// isAllowed: the slide re-issue re-runs the invite door (audit F159); these
// tests pin the clock semantics, so every tester here is invited. The
// de-invited path is executed in deinvite-revocation.test.ts.
vi.mock("./allowlist", () => ({ isTestUser: async () => false, isAllowed: async () => true }));

const jar: { value?: string; setCalls: number } = { setCalls: 0 };
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: () => (jar.value ? { value: jar.value } : undefined),
    set: () => {
      jar.setCalls++;
    },
    delete: () => {
      jar.value = undefined;
    },
  }),
}));

import { createHmac } from "crypto";

function forgeCookie(email: string, issuedAt: number): string {
  const b64 = Buffer.from(JSON.stringify({ email, issuedAt })).toString("base64url");
  const sig = createHmac("sha256", "dev-insecure-secret-change-me").update(b64).digest("hex");
  return `${b64}.${sig}`;
}

import { getSession } from "./session";

beforeEach(() => {
  jar.value = undefined;
  jar.setCalls = 0;
});

describe("server-side session expiry", () => {
  it("accepts a fresh cookie", async () => {
    jar.value = forgeCookie("a@x.com", Date.now() - 60_000);
    const s = await getSession();
    expect(s?.email).toBe("a@x.com");
    expect(jar.setCalls).toBe(0); // young session - no renewal churn
  });

  it("REJECTS a 31-day-old token even with a valid signature", async () => {
    jar.value = forgeCookie("a@x.com", Date.now() - 31 * 24 * 3600_000);
    expect(await getSession()).toBe(null);
  });

  it("rejects a token issued in the future (clock tampering)", async () => {
    jar.value = forgeCookie("a@x.com", Date.now() + 3600_000);
    expect(await getSession()).toBe(null);
  });

  it("slide-renews an active session past the halfway mark", async () => {
    jar.value = forgeCookie("a@x.com", Date.now() - 16 * 24 * 3600_000);
    const s = await getSession();
    expect(s?.email).toBe("a@x.com");
    expect(jar.setCalls).toBe(1);
  });
});
