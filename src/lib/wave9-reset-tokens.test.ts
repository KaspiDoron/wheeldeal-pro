import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// WAVE 9: A PASSWORD-RESET REQUEST MUST NOT CHANGE ANYTHING.
//
// The old /api/auth/forgot overwrote the real password with a temporary one at
// REQUEST time - so anyone who knew an email address held a lockout button for
// it, and (once password changes started revoking sessions) a sign-out-
// everywhere button too. The token flow stores a hash and emails a link; the
// password changes only when the token is redeemed, which proves the inbox.

vi.mock("server-only", () => ({}));

const db: {
  sendResults: { sent: boolean; reason?: string; error?: string }[];
  sent: { to: string[]; subject: string; html: string }[];
  updates: { table: string; filter: string; values: Record<string, unknown> }[];
  updateResult: boolean | "throw";
} = { sendResults: [], sent: [], updates: [], updateResult: true };

vi.mock("./runtime-config", () => ({
  supabaseConfigured: () => false,
  encryptString: (s: string) => s,
  decryptString: (s: string) => s,
  getConfig: async () => undefined,
  sbSelect: async () => [],
  sbSelectStrict: async () => ({ rows: [] }),
  sbInsert: async () => true,
  sbDelete: async () => true,
  sbUpdate: async (table: string, filter: string, values: Record<string, unknown>) => {
    if (db.updateResult === "throw") throw new Error("db down");
    db.updates.push({ table, filter, values });
    return db.updateResult;
  },
}));

vi.mock("./email", () => ({
  sendEmail: async (msg: { to: string[]; subject: string; html: string }) => {
    db.sent.push(msg);
    return db.sendResults.shift() ?? { sent: true };
  },
}));

vi.mock("./site", () => ({
  resolveSiteOrigin: async () => "https://wheeldeal.example",
}));

import { startPasswordReset, redeemPasswordReset } from "./verify";
import { revokeSessions } from "./access";

const mem = () => globalThis.__wd_email_verify__!;

beforeEach(() => {
  db.sendResults = [];
  db.sent = [];
  db.updates = [];
  db.updateResult = true;
  globalThis.__wd_email_verify__?.clear();
});

function tokenFromEmail(): string {
  const html = db.sent.at(-1)!.html;
  const m = /\/login\?reset=([A-Za-z0-9_-]+)/.exec(html);
  expect(m).toBeTruthy();
  return m![1];
}

describe("the reset token round trip", () => {
  it("a request stores ONLY a hash and emails a link - nothing else changes", async () => {
    const r = await startPasswordReset("traveller@example.com");
    expect(r.ok).toBe(true);
    const token = tokenFromEmail();
    // 256 bits of randomness in the link...
    expect(token.length).toBeGreaterThanOrEqual(40);
    // ...and the stored row cannot mint it back: sha256 only.
    const row = mem().get("reset:traveller@example.com")!;
    expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.codeHash).not.toContain(token);
  });

  it("redeeming the token yields the account email EXACTLY once", async () => {
    await startPasswordReset("traveller@example.com");
    const token = tokenFromEmail();
    const first = await redeemPasswordReset(token);
    expect(first).toMatchObject({ ok: true, email: "traveller@example.com" });
    // Single use: the row went with the redemption.
    const second = await redeemPasswordReset(token);
    expect(second.ok).toBe(false);
  });

  it("a wrong or empty token redeems nothing", async () => {
    await startPasswordReset("traveller@example.com");
    expect((await redeemPasswordReset("not-the-token")).ok).toBe(false);
    expect((await redeemPasswordReset("")).ok).toBe(false);
    // The real row is still there - a guessing attacker cannot burn it.
    expect(mem().has("reset:traveller@example.com")).toBe(true);
  });

  it("an expired link is refused AND cleared", async () => {
    await startPasswordReset("traveller@example.com");
    const token = tokenFromEmail();
    mem().get("reset:traveller@example.com")!.exp = Date.now() - 1;
    const r = await redeemPasswordReset(token);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/expired/);
    expect(mem().has("reset:traveller@example.com")).toBe(false);
  });

  it("a failed email leaves NO live token behind", async () => {
    // The hash alone is harmless, but a token nobody can ever receive has no
    // business staying redeemable for 30 minutes.
    db.sendResults = [{ sent: false, error: "smtp down" }];
    const r = await startPasswordReset("traveller@example.com");
    expect(r.ok).toBe(false);
    expect(mem().has("reset:traveller@example.com")).toBe(false);
  });

  it("requests are cooled down per email (30s), like signup codes", async () => {
    await startPasswordReset("traveller@example.com");
    const again = await startPasswordReset("traveller@example.com");
    expect(again).toMatchObject({ ok: false, cooldown: true });
  });
});

describe("revokeSessions writes the horizon honestly", () => {
  it("stamps sessions_valid_from = now on the user's row", async () => {
    const ok = await revokeSessions("Someone@Example.com");
    expect(ok).toBe(true);
    const w = db.updates.at(-1)!;
    expect(w.table).toBe("app_users");
    expect(w.filter).toBe("email=eq.someone%40example.com");
    const stamped = Date.parse(String(w.values.sessions_valid_from));
    expect(Math.abs(stamped - Date.now())).toBeLessThan(5_000);
  });

  it("reports a failed write as false - 'signed out everywhere' must not be claimed on one", async () => {
    db.updateResult = false;
    expect(await revokeSessions("someone@example.com")).toBe(false);
    db.updateResult = "throw";
    expect(await revokeSessions("someone@example.com")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Wiring pins: the flows that must move the horizon, and the ones that must
// not touch passwords any more.
// ---------------------------------------------------------------------------

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("who moves the horizon", () => {
  const access = readCode("src/lib/access.ts");

  it("a persisted password change revokes every other session", () => {
    expect(access).toMatch(/if \(persisted\) await revokeSessions\(email\)\.catch/);
  });

  it("blocking an account revokes its sessions", () => {
    expect(access).toMatch(
      /if \(status === "blocked"\) await revokeSessions\(key\)\.catch/
    );
  });

  it("the schema carries the column", () => {
    expect(read("supabase/schema.sql")).toMatch(
      /alter table public\.app_users add column if not exists sessions_valid_from timestamptz;/
    );
  });
});

describe("the request/redeem split in the routes", () => {
  it("forgot no longer touches the password - it only starts a reset", () => {
    const forgot = readCode("src/app/api/auth/forgot/route.ts");
    expect(forgot).toMatch(/startPasswordReset/);
    expect(forgot).not.toMatch(/setPassword/);
    // The three-window throttle survives the rewrite.
    expect(forgot).toMatch(/rateLimit\("forgot",/);
    expect(forgot).toMatch(/rateLimit\("forgot-ip",/);
    expect(forgot).toMatch(/rateLimit\("forgot-target",/);
  });

  it("reset redeems FIRST, sets the password second, then signs the redeemer in", () => {
    const reset = readCode("src/app/api/auth/reset/route.ts");
    const redeemAt = reset.indexOf("redeemPasswordReset(");
    const setAt = reset.indexOf("setPassword(redeemed.email");
    const cookieAt = reset.indexOf("setSessionCookie(redeemed.email)");
    expect(redeemAt).toBeGreaterThan(0);
    expect(setAt).toBeGreaterThan(redeemAt);
    expect(cookieAt).toBeGreaterThan(setAt);
    expect(reset).toMatch(/rateLimit\("reset-redeem",/);
  });

  it("a signed-in password change re-issues the caller's own cookie", () => {
    const pw = readCode("src/app/api/auth/password/route.ts");
    const saveAt = pw.indexOf("await setPassword(session.email");
    const cookieAt = pw.indexOf("setSessionCookie(session.email)");
    expect(saveAt).toBeGreaterThan(0);
    expect(cookieAt).toBeGreaterThan(saveAt);
  });

  it("'Sign out everywhere' exists, is honest about failure, and keeps THIS device", () => {
    const all = readCode("src/app/api/auth/logout-all/route.ts");
    expect(all).toMatch(/revokeSessions\(session\.email\)/);
    expect(all).toMatch(/status: 500/); // failed revoke is not "ok"
    expect(all).toMatch(/setSessionCookie\(session\.email\)/);
    // ...and the Profile page offers it.
    expect(read("src/app/profile/page.tsx")).toMatch(/\/api\/auth\/logout-all/);
  });

  it("the login link carries the token to the login page's redeem form", () => {
    const login = readCode("src/app/login/page.tsx");
    expect(login).toMatch(/get\("reset"\)/);
    expect(login).toMatch(/\/api\/auth\/reset/);
  });
});

describe("brute-force keys", () => {
  it("the login lock is keyed (email, ip) - a stranger cannot lock YOU out", () => {
    const login = readCode("src/app/api/auth/login/route.ts");
    expect(login).toMatch(/const lockKey = `\$\{email\}\|ip:\$\{clientIp\(req\)\}`/);
    expect(login).toMatch(/authLockLeft\(lockKey, "login"\)/);
    expect(login).toMatch(/noteAuthFailure\(lockKey, "login"\)/);
    expect(login).toMatch(/clearAuthFailures\(lockKey, "login"\)/);
  });

  it("the signup code hash is keyed by the server secret (no offline brute of 10^6)", () => {
    const verify = readCode("src/lib/verify.ts");
    expect(verify).toMatch(
      /createHmac\("sha256", key\)\.update\(`\$\{email\.toLowerCase\(\)\}:\$\{code\}`\)/
    );
  });
});
