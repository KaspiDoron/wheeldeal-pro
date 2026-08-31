import { describe, it, expect, vi, beforeEach } from "vitest";

// WAVE 9: THE REVOCATION HORIZON, AND THE TWO CLOCKS A COOKIE CARRIES.
//
// A password change used to change only the hash: every cookie minted under
// the OLD password - the stolen one being the whole reason people change
// passwords - stayed valid for its full 30-day life. app_users gains
// `sessions_valid_from`; getSession refuses any cookie whose issuedAt
// predates it. And slide-renewal used to run BEFORE the validity gates, which
// would have handed a revoked session a fresh issuedAt that walks straight
// past the horizon - the renewal now happens only after every gate passes.

vi.mock("server-only", () => ({}));

const state: {
  rec: { status: string; plan?: string; sessionsValidFrom?: number } | null;
  /** What the strict app_users probe answers when getUser has no record. */
  db: "unconfigured" | "present" | "gone" | "unavailable";
} = { rec: null, db: "unconfigured" };

vi.mock("./runtime-config", () => ({
  getConfig: async () => undefined,
  getConfigFresh: async () => ({ value: undefined }),
  setConfig: async () => {},
  supabaseConfigured: () => state.db !== "unconfigured",
  sbSelectStrict: async () =>
    state.db === "gone"
      ? { rows: [] }
      : state.db === "present"
        ? { rows: [{ email: "a@x.com" }] }
        : { error: "unavailable" as const },
}));

vi.mock("./access", () => ({
  getUser: async () => state.rec,
  normalizePlan: (p: unknown) => (p === "pro" ? "pro" : "free"),
}));
vi.mock("./allowlist", () => ({ isTestUser: async () => false }));

const jar: { value?: string; setCalls: number; lastSet?: string } = { setCalls: 0 };
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: () => (jar.value ? { value: jar.value } : undefined),
    set: (_name: string, value: string) => {
      jar.setCalls++;
      jar.lastSet = value;
    },
    delete: () => {
      jar.value = undefined;
    },
  }),
}));

import { createHmac } from "crypto";
import { getSession } from "./session";

function forgeCookie(email: string, issuedAt: number, firstIssuedAt?: number): string {
  const payload: Record<string, unknown> = { email, issuedAt };
  if (firstIssuedAt !== undefined) payload.firstIssuedAt = firstIssuedAt;
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", "dev-insecure-secret-change-me").update(b64).digest("hex");
  return `${b64}.${sig}`;
}

function decodeSetCookie(): { email: string; issuedAt: number; firstIssuedAt?: number } {
  return JSON.parse(Buffer.from(jar.lastSet!.split(".")[0], "base64url").toString());
}

const DAY = 24 * 3600_000;

beforeEach(() => {
  jar.value = undefined;
  jar.setCalls = 0;
  jar.lastSet = undefined;
  state.rec = { status: "active", plan: "free" };
  state.db = "unconfigured";
});

describe("the revocation horizon", () => {
  it("REPRODUCTION: a cookie issued before sessions_valid_from is dead", async () => {
    state.rec = { status: "active", sessionsValidFrom: Date.now() - 60_000 };
    jar.value = forgeCookie("a@x.com", Date.now() - 3600_000); // predates the horizon
    expect(await getSession()).toBe(null);
  });

  it("a cookie issued AFTER the horizon is untouched (the re-issued one)", async () => {
    state.rec = { status: "active", sessionsValidFrom: Date.now() - 3600_000 };
    jar.value = forgeCookie("a@x.com", Date.now() - 60_000);
    const s = await getSession();
    expect(s?.email).toBe("a@x.com");
  });

  it("the OWNER is not exempt - their cookie is the one whose theft matters most", async () => {
    // Unlike the blocked gate (which stays owner-exempt because a blocked row
    // would lock the owner out of login itself), a horizon can only ever ask
    // the owner to sign in again - a fresh login always postdates it.
    state.rec = { status: "active", sessionsValidFrom: Date.now() - 60_000 };
    jar.value = forgeCookie("kaspidoron@gmail.com", Date.now() - 3600_000);
    expect(await getSession()).toBe(null);
  });

  it("a FUTURE-dated horizon is ignored - it would refuse fresh logins too", async () => {
    // No code path writes one (revokeSessions writes now()), so it can only be
    // corruption; honoring it would be a permanent lockout for the account.
    state.rec = { status: "active", sessionsValidFrom: Date.now() + 3600_000 };
    jar.value = forgeCookie("a@x.com", Date.now() - 60_000);
    const s = await getSession();
    expect(s?.email).toBe("a@x.com");
  });

  it("THE ORDERING BUG: a revoked cookie past halfway must NOT be slide-renewed", async () => {
    // Renewal-before-gates would mint a fresh issuedAt for the revoked session
    // and defeat the horizon on the very next request.
    state.rec = { status: "active", sessionsValidFrom: Date.now() - 60_000 };
    jar.value = forgeCookie("a@x.com", Date.now() - 16 * DAY);
    expect(await getSession()).toBe(null);
    expect(jar.setCalls).toBe(0);
  });

  it("...and neither is a blocked one", async () => {
    state.rec = { status: "blocked" };
    jar.value = forgeCookie("a@x.com", Date.now() - 16 * DAY);
    expect(await getSession()).toBe(null);
    expect(jar.setCalls).toBe(0);
  });
});

describe("the absolute lifetime (firstIssuedAt)", () => {
  it("a session first issued 91 days ago is dead however fresh its renewal", async () => {
    jar.value = forgeCookie("a@x.com", Date.now() - DAY, Date.now() - 91 * DAY);
    expect(await getSession()).toBe(null);
  });

  it("slide-renewal CARRIES firstIssuedAt instead of resetting the clock", async () => {
    const first = Date.now() - 40 * DAY;
    jar.value = forgeCookie("a@x.com", Date.now() - 16 * DAY, first);
    const s = await getSession();
    expect(s?.email).toBe("a@x.com");
    expect(jar.setCalls).toBe(1);
    expect(decodeSetCookie().firstIssuedAt).toBe(first);
  });

  it("a legacy cookie (no firstIssuedAt) starts its absolute clock at issuedAt", async () => {
    // Honest limitation: legacy clocks err LONGER by at most one 30-day
    // window; every cookie minted from now on carries the real first issue.
    jar.value = forgeCookie("a@x.com", Date.now() - 16 * DAY);
    const s = await getSession();
    expect(s?.email).toBe("a@x.com");
    const renewed = decodeSetCookie();
    expect(renewed.firstIssuedAt).toBeLessThanOrEqual(Date.now() - 15 * DAY);
  });

  it("a fresh login mints both clocks at now", async () => {
    const { setSessionCookie } = await import("./session");
    setSessionCookie("a@x.com");
    const c = decodeSetCookie();
    expect(c.firstIssuedAt).toBe(c.issuedAt);
    expect(Date.now() - c.issuedAt).toBeLessThan(5_000);
  });
});

describe("an erased account does not keep a session", () => {
  // Erasure deletes the app_users row LAST - and the revocation horizon goes
  // with it, so this gate is what refuses the cookie afterwards. Only a
  // POSITIVE "the row is gone" answer refuses; the fail directions are pinned
  // below because they are the whole design.
  beforeEach(() => {
    state.rec = null; // getUser finds nothing (cache empty, row gone or DB down)
  });

  it("REPRODUCTION: the erased account's cookie is refused on a confirmed-gone row", async () => {
    state.db = "gone";
    jar.value = forgeCookie("a@x.com", Date.now() - 60_000);
    expect(await getSession()).toBe(null);
  });

  it("a DB outage FAILS OPEN - a blip must never sign the whole fleet out", async () => {
    state.db = "unavailable";
    jar.value = forgeCookie("a@x.com", Date.now() - 60_000);
    expect((await getSession())?.email).toBe("a@x.com");
  });

  it("no Supabase (dev) keeps working sessions without rows", async () => {
    state.db = "unconfigured";
    jar.value = forgeCookie("a@x.com", Date.now() - 60_000);
    expect((await getSession())?.email).toBe("a@x.com");
  });

  it("the OWNER is exempt - env-derived, no row required", async () => {
    state.db = "gone";
    jar.value = forgeCookie("kaspidoron@gmail.com", Date.now() - 60_000);
    expect((await getSession())?.email).toBe("kaspidoron@gmail.com");
  });
});
