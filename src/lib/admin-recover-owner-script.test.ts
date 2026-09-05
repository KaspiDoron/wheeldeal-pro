import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// AUDIT F258b - scripts/admin-recover-owner.mjs still defaulted --password to
// the well-known literal that F258 removed from the login route. Anyone who
// knew the script's default and could run it against the database installed a
// published credential on the owner row. The script now REQUIRES an explicit
// --password of 8+ characters, or OWNER_BOOTSTRAP_PASSWORD from the
// environment (the same one-time secret the login route's bootstrap reads),
// and refuses with a clear message otherwise - before it looks for a database.
//
// Executed by spawning the real script under a missing-argument condition; the
// source grep for the absence of the literal sits beside those assertions.

const SCRIPT = join(process.cwd(), "scripts/admin-recover-owner.mjs");

function run(args: string[], extraEnv: Record<string, string> = {}) {
  // The script's own inputs are stripped so the test controls them alone.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of [
    "SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "OWNER_BOOTSTRAP_PASSWORD",
  ]) {
    delete env[k];
  }
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...env, ...extraEnv },
    encoding: "utf8",
    timeout: 20_000,
  });
  return { status: res.status, stderr: res.stderr ?? "", stdout: res.stdout ?? "" };
}

describe("admin-recover-owner.mjs has no built-in password", () => {
  it("REGRESSION: with no --password and no OWNER_BOOTSTRAP_PASSWORD it refuses, naming both", () => {
    const r = run([]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--password/);
    expect(r.stderr).toMatch(/OWNER_BOOTSTRAP_PASSWORD/);
    // Refused BEFORE the database lookup - the password gate is not behind it.
    expect(r.stderr).not.toMatch(/SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set/);
  });

  it("a --password shorter than 8 characters is refused the same way", () => {
    const r = run(["--password", "short"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--password/);
    expect(r.stderr).not.toMatch(/SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set/);
  });

  it("an explicit strong --password passes the gate (and then wants the database)", () => {
    const r = run(["--password", "a-strong-unique-passphrase"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set/);
    expect(r.stderr).not.toMatch(/--password/);
  });

  it("OWNER_BOOTSTRAP_PASSWORD from the environment is accepted in place of --password", () => {
    const r = run([], { OWNER_BOOTSTRAP_PASSWORD: "env-bootstrap-secret" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set/);
    expect(r.stderr).not.toMatch(/--password/);
  });

  it("the literal is gone from the script, and arg(\"password\") carries no fallback", () => {
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).not.toMatch(/KASPI123/);
    expect(src).not.toMatch(/arg\("password",\s*"[^"]+"\)/);
  });
});
