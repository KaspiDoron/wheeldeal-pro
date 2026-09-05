import { describe, it, expect, vi, afterEach } from "vitest";

// AUDIT F184 - every login throttle was keyed on the source IP, so an attacker
// who rotates addresses got unlimited password guesses against one account.
//
// The per-IP window (30/hour) and the per-(email, ip) brute-force lock both
// reset the moment the address changes; a routed /64 or a botnet turned that
// into 60,000 guesses an hour against a known tester with no 429 ever
// answered. /api/auth/forgot already carried the missing dimension (its
// IP-independent "forgot-target" bucket); login is given the same shape here:
// an account-keyed "login-fail" ceiling that is COUNTED only on a verified
// wrong password (never before getUser, so it is neither an enumeration oracle
// nor a lockout weapon a stranger can spend with garbage) and CHECKED before
// the password is verified, so a spent ceiling refuses the correct guess too.
//
// Executed against the real route with the REAL rate limiter (per-instance
// window - no REDIS_URL in the unit suite) and a rotating appended hop, the
// exact shape Cloud Run delivers.

vi.mock("server-only", () => ({}));

const VICTIM = "victim@example.com";
const OTHER = "other@example.com";

interface UserRow {
  email: string;
  passwordHash?: string;
}

async function loadLoginRoute() {
  vi.resetModules();
  const users = new Map<string, UserRow>([
    [VICTIM, { email: VICTIM, passwordHash: "hash:correct-horse" }],
    [OTHER, { email: OTHER, passwordHash: "hash:other-secret" }],
  ]);
  const calls = { cookies: [] as string[], getUser: 0 };

  vi.doMock("@/lib/session", () => ({
    sessionSecretReady: () => true,
    isOwner: () => false,
    setSessionCookie: (email: string) => {
      calls.cookies.push(email);
    },
    getSession: async () => ({ email: VICTIM, role: "user" }),
  }));
  vi.doMock("@/lib/access", () => ({
    getUser: async (email: string) => {
      calls.getUser += 1;
      return users.get(email) ?? null;
    },
    isBlocked: async () => false,
    touchUser: async () => {},
    setPlan: async () => {},
    verifyPassword: (pw: string, hash?: string) => Boolean(hash) && hash === `hash:${pw}`,
    registerUser: async () => null,
    setPassword: async () => true,
    revokeSessions: async () => true,
  }));
  vi.doMock("@/lib/runtime-config", () => ({ sbInsert: async () => true }));
  vi.doMock("@/lib/cooldown", () => ({
    authLockLeft: async () => 0,
    noteAuthFailure: async () => ({ locked: false, lockedMinutes: 0 }),
    clearAuthFailures: () => {},
  }));
  vi.doMock("@/lib/allowlist", () => ({
    allowedPlanFor: async () => "free",
    BETA_BLOCK_MESSAGE: "private beta",
  }));
  vi.doMock("@/lib/verify", () => ({
    emailVerificationAvailable: async () => false,
    startEmailVerification: async () => ({ ok: true }),
  }));

  const rl = await import("@/lib/rate-limit");
  rl._resetRateLimit();
  const mod = await import("@/app/api/auth/login/route");
  return { POST: mod.POST, calls };
}

/** A login POST whose APPENDED hop (the one the platform writes) rotates. */
const attempt = (email: string, password: string, ipIndex: number) =>
  new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `198.51.${Math.floor(ipIndex / 256)}.${ipIndex % 256}`,
    },
    body: JSON.stringify({ mode: "login", email, password }),
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a rotating-IP attacker runs into an account-keyed guess ceiling", () => {
  it("REGRESSION: wrong guesses from fresh addresses are refused after the per-account ceiling", async () => {
    const { POST, calls } = await loadLoginRoute();
    const statuses: number[] = [];
    for (let i = 0; i < 70; i++) {
      const res = await POST(attempt(VICTIM, `guess-${i}`, i));
      statuses.push(res.status);
    }
    // The first sixty are honest 401s (a real person typing wrong passwords is
    // never close to this); from the 61st on the account is closed to guessing
    // for the rest of the hour, whatever address the guess arrives from.
    expect(statuses.slice(0, 60).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(60), "guesses 61-70 must be refused").toEqual(Array(10).fill(429));
    expect(calls.cookies).toEqual([]);
  });

  it("a spent ceiling refuses even the CORRECT password, from any new address", async () => {
    const { POST, calls } = await loadLoginRoute();
    for (let i = 0; i < 60; i++) await POST(attempt(VICTIM, `guess-${i}`, i));
    const res = await POST(attempt(VICTIM, "correct-horse", 999));
    expect(res.status).toBe(429);
    // Generic wording - the same family the existing locks use; no new signal.
    expect((await res.json()).error).toMatch(/Too many attempts/);
    expect(calls.cookies).toEqual([]);
  });

  it("the ceiling is per ACCOUNT - another tester signs in normally", async () => {
    const { POST, calls } = await loadLoginRoute();
    for (let i = 0; i < 60; i++) await POST(attempt(VICTIM, `guess-${i}`, i));
    const res = await POST(attempt(OTHER, "other-secret", 500));
    expect(res.status).toBe(200);
    expect(calls.cookies).toEqual([OTHER]);
  });

  it("a real person who mistypes a few times still gets in", async () => {
    const { POST, calls } = await loadLoginRoute();
    for (let i = 0; i < 5; i++) expect((await POST(attempt(VICTIM, "typo", 1))).status).toBe(401);
    const res = await POST(attempt(VICTIM, "correct-horse", 1));
    expect(res.status).toBe(200);
    expect(calls.cookies).toEqual([VICTIM]);
  });

  it("an UNKNOWN account never counts, so the ceiling is not an enumeration oracle", async () => {
    const { POST } = await loadLoginRoute();
    const statuses = new Set<number>();
    for (let i = 0; i < 70; i++) {
      statuses.add((await POST(attempt("nobody@example.com", `guess-${i}`, i))).status);
    }
    // The existing answer for an invited-but-unregistered address, every time -
    // never a 429 that would only appear for addresses that exist.
    expect([...statuses]).toEqual([400]);
  });
});
