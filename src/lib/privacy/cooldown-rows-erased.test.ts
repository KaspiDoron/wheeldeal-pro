import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT F187: THE LOGIN THROTTLE'S `email|ip:<addr>` COOLDOWN ROWS NEVER
// MATCHED THE ERASURE REGISTRY.
//
// /api/auth/login keys its brute-force lock on `${email}|ip:${clientIp}` and
// setCooldown stores that composite string verbatim in user_cooldowns.email.
// The registry matched user_cooldowns EXACT on the address, so erase issued
// `email=eq.alice%40example.com`, matched nothing, sbDelete answered true, and
// a row pairing the person's address with the IP they signed in from outlived
// their erasure (until retention's 30-days-past-`until` prune) - and never
// appeared in their DSAR export.
//
// Executed: the REAL noteAuthFailure trips the REAL setCooldown into a
// Map-backed store, then the REAL walker must leave zero rows for the address
// - while another person's rows, and a look-alike address, survive.

vi.mock("../runtime-config", async () => {
  const h = await import("./postgrest-store.test-helper");
  return h.runtimeConfigMock();
});
vi.mock("../evolution", () => ({
  disconnectInstance: async () => ({ severed: true, hostsTried: 0, hadLink: false }),
}));

import { store } from "./postgrest-store.test-helper";
import { noteAuthFailure } from "../cooldown";
import { eraseUserData } from "./erase";
import { USER_TABLES, filterFor } from "./user-tables";

const EMAIL = "alice_b@example.com";
const IP = "203.0.113.7";

beforeEach(() => {
  store.reset();
  (globalThis as { __wd_attempts__?: Map<string, unknown> }).__wd_attempts__ = new Map();
  (globalThis as { __wd_cooldowns__?: Map<string, number> }).__wd_cooldowns__ = new Map();
  store.seed("app_users", [{ email: EMAIL, status: "active", plan: "free", provider: "email" }]);
});

async function tripLoginLock(lockKey: string) {
  let locked = false;
  for (let i = 0; i < 6 && !locked; i++) locked = (await noteAuthFailure(lockKey, "login")).locked;
  return locked;
}

describe("EXECUTED (F187): the login lock rows leave with the person", () => {
  it("six wrong passwords write a composite-keyed row, and the erase deletes it", async () => {
    expect(await tripLoginLock(`${EMAIL}|ip:${IP}`)).toBe(true);
    const before = store.rows("user_cooldowns");
    expect(before).toHaveLength(1);
    expect(before[0].email).toBe(`${EMAIL}|ip:${IP}`);
    expect(before[0].kind).toBe("lock:login");

    const result = await eraseUserData(EMAIL);
    expect(result.failed).toEqual([]);
    // THE ASSERTION THAT FAILED BEFORE: the row paired the address with the IP
    // after a 200 "erased".
    const left = store.rows("user_cooldowns").filter((r) => String(r.email).startsWith(EMAIL));
    expect(left).toEqual([]);
  });

  it("another person's lock, a look-alike address and the IP-only Google lane survive", async () => {
    await tripLoginLock(`${EMAIL}|ip:${IP}`);
    await tripLoginLock(`bob@example.com|ip:${IP}`);
    await tripLoginLock(`alice_b@example.com.evil|ip:${IP}`);
    (globalThis as { __wd_attempts__?: Map<string, unknown> }).__wd_attempts__ = new Map();
    await tripLoginLock(`alicexb@example.com|ip:${IP}`); // `_` must not act as a wildcard
    store.seed("user_cooldowns", [
      { email: `ip:${IP}`, kind: "lock:google", until: new Date(Date.now() + 60_000).toISOString() },
    ]);
    expect(store.rows("user_cooldowns")).toHaveLength(5);

    await eraseUserData(EMAIL);
    const emails = store.rows("user_cooldowns").map((r) => String(r.email)).sort();
    expect(emails).toEqual(
      [
        `alice_b@example.com.evil|ip:${IP}`,
        `alicexb@example.com|ip:${IP}`,
        `bob@example.com|ip:${IP}`,
        `ip:${IP}`,
      ].sort()
    );
  });

  it("a bare-address cooldown row (the integrity ladder's blocks) is still erased too", async () => {
    store.seed("user_cooldowns", [
      { email: EMAIL, kind: "future-pickup", until: new Date(Date.now() + 60_000).toISOString() },
    ]);
    await eraseUserData(EMAIL);
    expect(store.rows("user_cooldowns")).toEqual([]);
  });
});

describe("the registry renders the composite key as a terminated prefix", () => {
  it("user_cooldowns carries an exact entry AND a `|`-terminated prefix entry", () => {
    const entries = USER_TABLES.filter((t) => t.table === "user_cooldowns" && t.column === "email");
    expect(entries.some((e) => e.match === "exact")).toBe(true);
    const prefix = entries.find((e) => e.match === "prefix");
    expect(prefix?.separator).toBe("|");
    expect(filterFor(prefix as (typeof USER_TABLES)[number], "Alice_B@Example.com")).toBe(
      "email=like.alice%5C_b%40example.com%7C*"
    );
  });
});
