import { describe, it, expect, vi, afterEach } from "vitest";

// AUDIT F158 - the password-reset redemption minted a session with no
// beta-allowlist gate.
//
// Every other cookie-issuing path (email login, Google, verified signup) runs
// allowedPlanFor at the door; /api/auth/reset went redeem -> getUser ->
// setPassword -> setSessionCookie and never asked. Removing a tester from the
// invite list only rewrites the beta_allowlist config - the app_users row
// stays - so the de-invited tester could drive forgot -> reset, mint a fresh
// wd_session, and resume driving live WhatsApp outreach through routes that
// gate on getSession alone. allowlist.ts promised the opposite: "There is no
// other way to obtain a session".
//
// Executed against the real routes with their collaborators mocked. The reset
// route now runs the allowlist door and the blocked check on the row it has
// already read, BEFORE the password write, so a de-invited or restricted
// account can neither rewrite its credential nor obtain a cookie; the forgot
// route stops emailing a link to a de-invited address while keeping its
// generic, non-enumerating body.

vi.mock("server-only", () => ({}));

const TESTER = "bob@example.com";

interface Harness {
  /** What allowedPlanFor answers - null is "not invited". */
  plan: "free" | "pro" | "ultra" | null;
  status?: "active" | "blocked";
  /** getUser answers no row at all. */
  missing?: boolean;
}

async function loadRoutes(h: Harness) {
  vi.resetModules();
  const calls = {
    setPassword: [] as string[],
    cookies: [] as string[],
    resetsStarted: [] as string[],
    allowlistAsked: [] as string[],
  };
  vi.doMock("@/lib/verify", () => ({
    redeemPasswordReset: async (token: string) =>
      token === "good-token" ? { ok: true, email: TESTER } : { ok: false, error: "bad token" },
    startPasswordReset: async (email: string) => {
      calls.resetsStarted.push(email);
      return { ok: true };
    },
  }));
  vi.doMock("@/lib/access", () => ({
    getUser: async (email: string) =>
      h.missing || email !== TESTER
        ? undefined
        : { email: TESTER, provider: "email", status: h.status ?? "active", plan: "free" },
    setPassword: async (email: string) => {
      calls.setPassword.push(email);
      return true;
    },
  }));
  vi.doMock("@/lib/session", () => ({
    setSessionCookie: (email: string) => {
      calls.cookies.push(email);
    },
  }));
  vi.doMock("@/lib/rate-limit", () => ({
    rateLimit: async () => ({ ok: true, retryAfter: 0 }),
    clientIp: () => "203.0.113.9",
  }));
  vi.doMock("@/lib/allowlist", () => ({
    allowedPlanFor: async (email: string) => {
      calls.allowlistAsked.push(email);
      return h.plan;
    },
    isAllowed: async (email: string) => {
      calls.allowlistAsked.push(email);
      return h.plan !== null;
    },
    BETA_BLOCK_MESSAGE: "private beta - not on the tester list",
  }));
  const reset = await import("@/app/api/auth/reset/route");
  const forgot = await import("@/app/api/auth/forgot/route");
  return { reset: reset.POST, forgot: forgot.POST, calls };
}

const post = (path: string, body: Record<string, unknown>) =>
  new Request(`http://localhost/api/auth/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

afterEach(() => vi.restoreAllMocks());

describe("POST /api/auth/reset runs the same door as every other cookie-minting path", () => {
  it("REGRESSION: a de-invited tester redeeming a live link gets 403 - no password write, no cookie", async () => {
    const { reset, calls } = await loadRoutes({ plan: null });
    const res = await reset(post("reset", { token: "good-token", next: "newpass1" }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.betaBlocked).toBe(true);
    expect(body.error).toMatch(/private beta/);
    expect(calls.setPassword).toEqual([]);
    expect(calls.cookies).toEqual([]);
    expect(calls.allowlistAsked).toContain(TESTER);
  });

  it("a restricted (blocked) account can neither rewrite its credential nor sign in", async () => {
    const { reset, calls } = await loadRoutes({ plan: "free", status: "blocked" });
    const res = await reset(post("reset", { token: "good-token", next: "newpass1" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/restricted by an administrator/);
    expect(calls.setPassword).toEqual([]);
    expect(calls.cookies).toEqual([]);
  });

  it("an invited, active tester still redeems, sets the password and is signed in", async () => {
    const { reset, calls } = await loadRoutes({ plan: "pro" });
    const res = await reset(post("reset", { token: "good-token", next: "newpass1" }));
    expect(res.status).toBe(200);
    expect(calls.setPassword).toEqual([TESTER]);
    expect(calls.cookies).toEqual([TESTER]);
  });

  it("an erased account is still told so (the existing 400), before any door check", async () => {
    const { reset, calls } = await loadRoutes({ plan: null, missing: true });
    const res = await reset(post("reset", { token: "good-token", next: "newpass1" }));
    expect(res.status).toBe(400);
    expect(calls.setPassword).toEqual([]);
    expect(calls.cookies).toEqual([]);
  });
});

describe("POST /api/auth/forgot does not email a link to a de-invited address", () => {
  it("REGRESSION: no reset is started, and the body is the SAME generic one an unknown address gets", async () => {
    const deinvited = await loadRoutes({ plan: null });
    const r1 = await deinvited.forgot(post("forgot", { email: TESTER }));
    const unknown = await loadRoutes({ plan: "free", missing: true });
    const r2 = await unknown.forgot(post("forgot", { email: "nobody@example.com" }));
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual(await r2.json());
    expect(deinvited.calls.resetsStarted).toEqual([]);
  });

  it("an invited tester still gets their link", async () => {
    const { forgot, calls } = await loadRoutes({ plan: "free" });
    const res = await forgot(post("forgot", { email: TESTER }));
    expect(res.status).toBe(200);
    expect(calls.resetsStarted).toEqual([TESTER]);
  });
});
