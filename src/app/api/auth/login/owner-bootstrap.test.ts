import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// AUDIT F258 - an anonymous caller could install a hardcoded password on a
// password-less OWNER account, and the same request revoked every owner session.
//
// The owner signs in with Google on a fresh deployment; that registers the
// owner row with NO password hash. /api/auth/login then, for that row and
// BEFORE any credential check, called setPassword(owner, <literal in this
// file>) - which also revokes every live session - and verified the caller's
// submitted password against the hash it had just written. Both halves of the
// secret were in the repo (the owner address in the docs, the literal in the
// route), so one unauthenticated POST minted an owner cookie. The cold-start
// bootstrap minted the same well-known credential from the same literal.
//
// Executed against the real route with its collaborators mocked: the
// password-less row gets the same 401 every other password-less account gets;
// the bootstrap reads OWNER_BOOTSTRAP_PASSWORD (env only, no default), refuses
// with 503 when it is unset, forces a change, and mints the cookie AFTER the
// revocation setPassword performs.

vi.mock("server-only", () => ({}));

interface UserRow {
  email: string;
  passwordHash?: string;
  mustChangePassword?: boolean;
  plan?: string;
}

interface Harness {
  user: UserRow | null;
  bootstrapEnv?: string;
}

const OWNER = "boss@example.com";

async function loadLoginRoute(h: Harness) {
  vi.resetModules();
  if (h.bootstrapEnv === undefined) delete process.env.OWNER_BOOTSTRAP_PASSWORD;
  else process.env.OWNER_BOOTSTRAP_PASSWORD = h.bootstrapEnv;
  let user: UserRow | null = h.user;
  const calls = {
    setPassword: [] as Array<{ email: string; mustChange: boolean | undefined }>,
    registerUser: [] as Array<{ email: string; password?: string }>,
    revokeSessions: 0,
    // The order in which the revocation and the cookie mint happened.
    sequence: [] as string[],
  };

  vi.doMock("@/lib/session", () => ({
    sessionSecretReady: () => true,
    isOwner: (e: string) => e.trim().toLowerCase() === OWNER,
    setSessionCookie: () => {
      calls.sequence.push("cookie");
    },
    getSession: async () => ({ email: OWNER, role: "owner" }),
  }));
  vi.doMock("@/lib/access", () => ({
    getUser: async () => user,
    isBlocked: async () => false,
    touchUser: async () => {},
    setPlan: async () => {},
    verifyPassword: (pw: string, hash?: string) => Boolean(hash) && hash === `hash:${pw}`,
    registerUser: async (u: { email: string; password?: string }) => {
      calls.registerUser.push({ email: u.email, password: u.password });
      user = { email: u.email, passwordHash: u.password ? `hash:${u.password}` : undefined };
      return user;
    },
    setPassword: async (email: string, pw: string, mustChange?: boolean) => {
      calls.setPassword.push({ email, mustChange });
      // The real setPassword revokes every session on every path.
      calls.revokeSessions += 1;
      calls.sequence.push("revoke");
      if (user) user = { ...user, passwordHash: `hash:${pw}`, mustChangePassword: Boolean(mustChange) };
      return true;
    },
    revokeSessions: async () => {
      calls.revokeSessions += 1;
      calls.sequence.push("revoke");
      return true;
    },
  }));
  vi.doMock("@/lib/runtime-config", () => ({ sbInsert: async () => true }));
  vi.doMock("@/lib/rate-limit", () => ({
    rateLimit: async () => ({ ok: true, retryAfter: 0 }),
    // The per-account guess ceiling (audit F184) is out of scope here - the
    // real limiter is exercised in account-guess-ceiling.test.ts.
    rateLimitPeek: async () => ({ ok: true, retryAfter: 0 }),
    clientIp: () => "203.0.113.9",
  }));
  vi.doMock("@/lib/cooldown", () => ({
    authLockLeft: async () => 0,
    noteAuthFailure: async () => ({ locked: false, lockedMinutes: 0 }),
    clearAuthFailures: () => {},
  }));
  vi.doMock("@/lib/allowlist", () => ({
    allowedPlanFor: async () => "ultra",
    BETA_BLOCK_MESSAGE: "private beta",
  }));
  vi.doMock("@/lib/verify", () => ({
    emailVerificationAvailable: async () => false,
    startEmailVerification: async () => ({ ok: true }),
  }));

  const mod = await import("@/app/api/auth/login/route");
  return { POST: mod.POST, calls, user: () => user };
}

const post = (body: Record<string, unknown>) =>
  new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.OWNER_BOOTSTRAP_PASSWORD;
});

describe("a password-less OWNER row is a Google account, not an open door", () => {
  it("REGRESSION: any submitted password gets 401 - no password is installed, no session is revoked, no cookie", async () => {
    const { POST, calls, user } = await loadLoginRoute({
      user: { email: OWNER, passwordHash: undefined },
      bootstrapEnv: "test-bootstrap-secret",
    });
    const res = await POST(post({ mode: "login", email: OWNER, password: "whatever-the-attacker-guesses" }));
    expect(res.status).toBe(401);
    expect(calls.setPassword).toEqual([]);
    expect(calls.revokeSessions).toBe(0);
    expect(calls.sequence).not.toContain("cookie");
    // The row is untouched: still no password hash.
    expect(user()?.passwordHash).toBeUndefined();
  });

  it("the route carries no hardcoded owner password at all", () => {
    const src = readFileSync(join(process.cwd(), "src/app/api/auth/login/route.ts"), "utf8");
    expect(src).not.toMatch(/OWNER_DEFAULT_PASSWORD\s*=\s*"/);
    expect(src).toMatch(/OWNER_BOOTSTRAP_PASSWORD/);
  });
});

describe("the cold-start bootstrap reads its secret from the environment, with NO default", () => {
  it("no owner row and no OWNER_BOOTSTRAP_PASSWORD: 503, nothing registered, no cookie", async () => {
    const { POST, calls } = await loadLoginRoute({ user: null });
    const res = await POST(post({ mode: "login", email: OWNER, password: "anything" }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/OWNER_BOOTSTRAP_PASSWORD/);
    expect(calls.registerUser).toEqual([]);
    expect(calls.setPassword).toEqual([]);
    expect(calls.sequence).not.toContain("cookie");
  });

  it("owner SIGNUP with no row and no bootstrap secret is refused the same way - the address alone creates nothing", async () => {
    const { POST, calls } = await loadLoginRoute({ user: null });
    const res = await POST(post({ mode: "signup", email: OWNER, password: "attacker-chosen" }));
    expect(res.status).toBe(503);
    expect(calls.registerUser).toEqual([]);
    expect(calls.sequence).not.toContain("cookie");
  });

  it("with the secret set, the bootstrap is a ONE-TIME credential: forced change, cookie minted AFTER the revocation", async () => {
    const { POST, calls, user } = await loadLoginRoute({ user: null, bootstrapEnv: "test-bootstrap-secret" });
    const res = await POST(post({ mode: "login", email: OWNER, password: "test-bootstrap-secret" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.mustChangePassword).toBe(true);
    expect(calls.setPassword).toEqual([{ email: OWNER, mustChange: true }]);
    expect(user()?.mustChangePassword).toBe(true);
    // setPassword revokes every session; the caller's own cookie must be
    // minted after that, or the owner is signed out by their own bootstrap.
    expect(calls.sequence.indexOf("revoke")).toBeGreaterThan(-1);
    expect(calls.sequence.lastIndexOf("cookie")).toBeGreaterThan(calls.sequence.lastIndexOf("revoke"));
  });

  it("with the secret set, a WRONG password is still 401 and mints nothing", async () => {
    const { POST, calls } = await loadLoginRoute({ user: null, bootstrapEnv: "test-bootstrap-secret" });
    const res = await POST(post({ mode: "login", email: OWNER, password: "not-the-secret" }));
    expect(res.status).toBe(401);
    expect(calls.sequence).not.toContain("cookie");
  });

  it("owner SIGNUP with the secret set installs the SECRET, not the caller's choice, and verifies it", async () => {
    const { POST, calls } = await loadLoginRoute({ user: null, bootstrapEnv: "test-bootstrap-secret" });
    const attacker = await POST(post({ mode: "signup", email: OWNER, password: "attacker-chosen" }));
    expect(attacker.status).toBe(401);
    expect(calls.sequence).not.toContain("cookie");
    // Whatever was registered, it was never the caller's password.
    for (const r of calls.registerUser) expect(r.password).not.toBe("attacker-chosen");
  });

  it("a bootstrap secret that is too short to be a credential is refused as unset", async () => {
    const { POST, calls } = await loadLoginRoute({ user: null, bootstrapEnv: "short" });
    const res = await POST(post({ mode: "login", email: OWNER, password: "short" }));
    expect(res.status).toBe(503);
    expect(calls.registerUser).toEqual([]);
  });
});

describe("an ordinary account is unaffected", () => {
  it("a password-less non-owner account gets the same 401", async () => {
    const { POST, calls } = await loadLoginRoute({
      user: { email: "traveller@example.com", passwordHash: undefined },
      bootstrapEnv: "test-bootstrap-secret",
    });
    const res = await POST(post({ mode: "login", email: "traveller@example.com", password: "x" }));
    expect(res.status).toBe(401);
    expect(calls.setPassword).toEqual([]);
  });

  it("a normal login still works", async () => {
    const { POST } = await loadLoginRoute({
      user: { email: "traveller@example.com", passwordHash: "hash:correct-horse" },
    });
    const res = await POST(post({ mode: "login", email: "traveller@example.com", password: "correct-horse" }));
    expect(res.status).toBe(200);
  });
});
