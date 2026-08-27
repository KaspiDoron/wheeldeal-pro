import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { shouldRedact, redactRow, REDACTED_EXACT } from "./redact-data";

// OWNER REPORT 11, S1 - THE ADMIN DATA EXPLORER SHIPPED CREDENTIALS TO A BROWSER.
//
// `/api/admin/data?table=app_users` ran `select=*` and returned rows verbatim,
// so one click handed the caller every account's scrypt `password_hash`, precise
// `stay_lat`/`stay_lng`, and - from wa_sessions - the live `proxy_session_id`
// proxy token. The sibling route admin/users was rewritten to withhold exactly
// these and the fix never reached here.
//
// Two layers, both pinned: an explicit column projection per secret-bearing
// table (so the credential never crosses the wire), and this redactor over every
// row (so a NEW secret column is withheld by default). Revert either and a test
// below goes red.

describe("the redactor withholds every credential and coordinate", () => {
  const LEAKS = [
    "password_hash",
    "stay_lat",
    "stay_lng",
    "proxy_session_id",
    "session_secret",
    "api_key",
    "apikey",
    "evolution_key",
    "auth_token",
    "refresh_token",
    "some_hash",
    "webhook_secret",
  ];
  const KEEPS = [
    "email",
    "phone",
    "name",
    "status",
    "plan",
    "host_url",
    "proxy_verified_at",
    "last_seen",
    "stay_label",
    "stay_share_consent_at",
    "received_at",
    "body",
    "raw",
    "instance_name",
    "created_at",
  ];

  it.each(LEAKS)("redacts %s", (key) => {
    expect(shouldRedact(key)).toBe(true);
  });

  it.each(KEEPS)("keeps %s", (key) => {
    expect(shouldRedact(key)).toBe(false);
  });

  it("strips the three named secrets from an app_users-shaped row", () => {
    const row = redactRow({
      email: "a@b.co",
      phone: "+66812345678",
      password_hash: "$scrypt$...",
      stay_lat: 8.05,
      stay_lng: 98.9,
      stay_label: "Ibis Krabi",
      last_seen: "2026-08-26",
    });
    expect(Object.keys(row).sort()).toEqual(["email", "last_seen", "phone", "stay_label"].sort());
    expect(row).not.toHaveProperty("password_hash");
    expect(row).not.toHaveProperty("stay_lat");
    expect(row).not.toHaveProperty("stay_lng");
  });

  it("strips the proxy token from a wa_sessions-shaped row", () => {
    const row = redactRow({
      email: "a@b.co",
      host_url: "https://h",
      proxy_session_id: "live-token-abc",
      proxy_verified_at: "2026-08-26",
    });
    expect(row).not.toHaveProperty("proxy_session_id");
    expect(row).toHaveProperty("proxy_verified_at"); // a timestamp is safe to see
  });
});

describe("the route can never issue select=* against a secret table", () => {
  const src = () => readFileSync("src/app/api/admin/data/route.ts", "utf8");

  it("every row read runs through redactRow", () => {
    expect(src()).toMatch(/rows:\s*rows\.map\(redactRow\)/);
  });

  it("app_users and wa_sessions carry an explicit projection, not select=*", () => {
    const s = src();
    // Pull the actual select STRING (a run of column,names joined across the
    // concatenation), not the surrounding entry - a comment naming an excluded
    // column would otherwise trip a substring check.
    const selectValue = (entry: string): string =>
      (entry.match(/select:\s*((?:"[^"]*"\s*\+?\s*)+)/)?.[1] ?? "")
        .replace(/["+\s]/g, "");
    const appUsers = selectValue(
      s.slice(s.indexOf('name: "app_users"'), s.indexOf('name: "bookings"'))
    );
    expect(appUsers.length).toBeGreaterThan(0);
    // A real projection, not a degraded "*" - the credential must not even
    // cross the wire, which the redactor alone would still allow.
    expect(appUsers, "app_users must not fall back to select=*").not.toBe("*");
    expect(appUsers).toContain("email");
    for (const c of ["password_hash", "stay_lat", "stay_lng"]) {
      expect(appUsers.split(","), `app_users projection names ${c}`).not.toContain(c);
    }
    const waSessions = selectValue(
      s.slice(s.indexOf('name: "wa_sessions"'), s.indexOf('name: "agent_training"'))
    );
    expect(waSessions.length).toBeGreaterThan(0);
    expect(waSessions, "wa_sessions must not fall back to select=*").not.toBe("*");
    expect(waSessions.split(",")).not.toContain("proxy_session_id");
  });

  it("the exact-name secret set is the one the schema actually calls sensitive", () => {
    // A guard against the set drifting away from the columns it protects.
    for (const c of ["password_hash", "stay_lat", "stay_lng", "proxy_session_id"]) {
      expect(REDACTED_EXACT.has(c)).toBe(true);
    }
  });
});
