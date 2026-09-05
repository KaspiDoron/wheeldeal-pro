import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT F048: AN ERASED ACCOUNT KEPT A LIVE SESSION ON EVERY INSTANCE THAT DID
// NOT RUN THE DELETE.
//
// getUser's non-fresh branch read app_users with sbSelect, which answers `[]`
// for "the row is gone" and for "the read failed" alike, and then fell through
// to the per-instance cache. So on a second warm container the erased
// traveller's cached record (status active, pre-revocation horizon) kept being
// served, getSession's "row is gone" probe (gated on `!rec`) never ran, and
// the cookie kept working - re-creating rows under the deleted email.
//
// Executed against a Map-backed store: prime the cache, delete the row the way
// another container's erase would, move past CACHE_TTL_MS, and the record
// must be GONE - while an outage or an un-migrated table still falls back to
// the cache, so a DB blip never signs the fleet out.

vi.mock("./runtime-config", async () => {
  const h = await import("./privacy/postgrest-store.test-helper");
  return h.runtimeConfigMock();
});
vi.mock("./allowlist", () => ({ isTestUser: async () => false }));

const jar: { value?: string } = {};
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: () => (jar.value ? { value: jar.value } : undefined),
    set: (_name: string, value: string) => {
      jar.value = value;
    },
    delete: () => {
      jar.value = undefined;
    },
  }),
}));

import { store } from "./privacy/postgrest-store.test-helper";
import { getUser } from "./access";
import { getSession, setSessionCookie } from "./session";

const EMAIL = "tester@example.com";
const T0 = Date.parse("2026-09-04T09:00:00.000Z");

function seedUser() {
  store.seed("app_users", [
    {
      email: EMAIL,
      status: "active",
      plan: "free",
      provider: "email",
      sessions_valid_from: null,
      added_at: new Date(T0 - 86_400_000).toISOString(),
      last_seen: new Date(T0 - 60_000).toISOString(),
    },
  ]);
}

beforeEach(() => {
  store.reset();
  jar.value = undefined;
  // A fresh cache per test: the module keeps it on globalThis.
  (globalThis as { __wheeldeal_users_v2__?: Map<string, unknown> }).__wheeldeal_users_v2__ = new Map();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("EXECUTED (F048): a confirmed-gone row is never served from the stale cache", () => {
  it("getUser resolves undefined once the durable row is deleted elsewhere and the cache TTL has passed", async () => {
    seedUser();
    const primed = await getUser(EMAIL);
    expect(primed?.email).toBe(EMAIL);

    // Another container ran the erase: the row is gone, THIS cache is not.
    store.tables.set("app_users", []);
    vi.setSystemTime(T0 + 15_000); // past CACHE_TTL_MS (10s)

    // THE ASSERTION THAT FAILED BEFORE: the stale record came back.
    expect(await getUser(EMAIL)).toBeUndefined();
  });

  it("getSession refuses the erased traveller's cookie on the warm instance", async () => {
    seedUser();
    setSessionCookie(EMAIL);
    expect((await getSession())?.email).toBe(EMAIL); // primes the cache

    store.tables.set("app_users", []);
    vi.setSystemTime(T0 + 15_000);

    expect(await getSession()).toBeNull();
  });
});

describe("the fallback the fleet depends on still holds", () => {
  it("an UNAVAILABLE read (outage) serves the cached record rather than signing the person out", async () => {
    seedUser();
    expect((await getUser(EMAIL))?.email).toBe(EMAIL);
    store.unavailable.add("app_users");
    vi.setSystemTime(T0 + 15_000);
    expect((await getUser(EMAIL))?.email).toBe(EMAIL);
  });

  it("a MISSING table (un-migrated database) serves the cached record too", async () => {
    seedUser();
    expect((await getUser(EMAIL))?.email).toBe(EMAIL);
    store.missing.add("app_users");
    vi.setSystemTime(T0 + 15_000);
    expect((await getUser(EMAIL))?.email).toBe(EMAIL);
  });

  it("inside the TTL the cache answers without a read, exactly as before", async () => {
    seedUser();
    expect((await getUser(EMAIL))?.email).toBe(EMAIL);
    store.tables.set("app_users", []);
    vi.setSystemTime(T0 + 2_000);
    expect((await getUser(EMAIL))?.email).toBe(EMAIL);
  });
});
