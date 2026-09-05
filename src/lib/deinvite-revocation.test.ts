import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// AUDIT F159 - de-invitation revoked nothing, and the silent slide re-issue
// never re-checked anything.
//
// The beta allowlist was enforced on exactly one authenticated surface (the
// /api/auth/me poll). getSession checked role, status, row existence and the
// revocation horizon - none of which removing a tester from the invite list
// moves - and then, past the halfway mark, re-minted the cookie for another
// 30 days at session.ts:285. A tester whose client never polled /me (curl, a
// page that does not poll) stayed signed in and self-renewing up to the 90-day
// ceiling. The same re-mint also ran when the account row could not be read
// this request (a blip, or a stale 10s cache with no horizon on it), minting
// an issuedAt that postdates any horizon written in between - a revoked
// session made valid again, permanently.
//
// Two halves, both executed:
//   1. saveBetaAllowlist diffs old against new and revokes every dropped
//      tester's sessions at the point the owner acts (zero request-path cost),
//      reporting by name any revocation that did not persist.
//   2. The slide re-issue re-runs the door checks first: the allowlist, and a
//      FRESH read of the row for status + horizon. A de-invited or blocked
//      account is refused; a row that cannot be positively read this request
//      keeps its session (fail open, like every other gate) but is NOT
//      re-minted. Demo mode (no durable store) renews as before.

vi.mock("server-only", () => ({}));

type Rec = { status: string; plan?: string; sessionsValidFrom?: number };
const state: {
  cfg: Record<string, string | undefined>;
  db: "unconfigured" | "configured";
  /** The per-instance cache getUser answers with. */
  cached: Rec | null;
  /** What the STRICT app_users read answers this request. */
  row: { status: string; sessions_valid_from: string | null } | "gone" | "unavailable";
  revoked: string[];
  revokeResult: boolean;
} = { cfg: {}, db: "unconfigured", cached: null, row: "unavailable", revoked: [], revokeResult: true };

vi.mock("./runtime-config", () => ({
  getConfig: async (k: string) => state.cfg[k],
  getConfigFresh: async () => ({ value: undefined }),
  setConfig: async (k: string, v: string) => {
    state.cfg[k] = v;
    return { ok: true, persistent: true };
  },
  supabaseConfigured: () => state.db === "configured",
  sbSelectStrict: async (_t: string, query: string) => {
    if (state.row === "unavailable") return { error: "unavailable" as const };
    if (state.row === "gone") return { rows: [] };
    return {
      rows: [
        query.includes("select=email")
          ? { email: "a@x.com" }
          : { status: state.row.status, sessions_valid_from: state.row.sessions_valid_from },
      ],
    };
  },
}));

vi.mock("./access", () => ({
  getUser: async () => state.cached,
  normalizePlan: (p: unknown) => (p === "pro" ? "pro" : "free"),
  revokeSessions: async (email: string) => {
    state.revoked.push(email);
    return state.revokeResult;
  },
}));

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
import { getSession } from "./session";
import { saveBetaAllowlist } from "./allowlist";

const DAY = 24 * 3600_000;
const OWNER = "boss@example.com";

function forgeCookie(email: string, issuedAt: number): string {
  const b64 = Buffer.from(JSON.stringify({ email, issuedAt, firstIssuedAt: issuedAt })).toString(
    "base64url"
  );
  const sig = createHmac("sha256", "dev-insecure-secret-change-me").update(b64).digest("hex");
  return `${b64}.${sig}`;
}

const list = (...emails: string[]) =>
  JSON.stringify(emails.map((email) => ({ email, plan: "free" })));

beforeEach(() => {
  for (const k of Object.keys(state.cfg)) delete state.cfg[k];
  state.db = "unconfigured";
  state.cached = { status: "active", plan: "free" };
  state.row = "unavailable";
  state.revoked = [];
  state.revokeResult = true;
  jar.value = undefined;
  jar.setCalls = 0;
  process.env.OWNER_EMAIL = OWNER;
  process.env.ADMIN_EMAILS = OWNER;
  delete process.env.BETA_LOCK;
  delete process.env.BETA_ALLOWLIST;
});

afterEach(() => vi.restoreAllMocks());

describe("the slide re-issue re-runs the door checks", () => {
  it("REGRESSION: a de-invited tester's 16-day cookie is refused, and NOT re-minted for 30 more days", async () => {
    state.cfg.beta_allowlist = list("someone-else@example.com"); // a@x.com was removed
    jar.value = forgeCookie("a@x.com", Date.now() - 16 * DAY);
    expect(await getSession()).toBe(null);
    expect(jar.setCalls).toBe(0);
  });

  it("an invited tester past halfway is renewed exactly as before", async () => {
    state.cfg.beta_allowlist = list("a@x.com");
    jar.value = forgeCookie("a@x.com", Date.now() - 16 * DAY);
    expect((await getSession())?.email).toBe("a@x.com");
    expect(jar.setCalls).toBe(1);
  });

  it("the owner is never on the list and is always renewed", async () => {
    state.cfg.beta_allowlist = list();
    jar.value = forgeCookie(OWNER, Date.now() - 16 * DAY);
    expect((await getSession())?.role).toBe("owner");
    expect(jar.setCalls).toBe(1);
  });

  it("REGRESSION: an UNREADABLE row keeps the session for this request but is not re-minted", async () => {
    // The re-mint used to run on a null rec: a fresh issuedAt that postdates
    // any horizon written during the blip made a revoked session valid again
    // on every instance, permanently.
    state.cfg.beta_allowlist = list("a@x.com");
    state.db = "configured";
    state.cached = null;
    state.row = "unavailable";
    jar.value = forgeCookie("a@x.com", Date.now() - 16 * DAY);
    expect((await getSession())?.email).toBe("a@x.com"); // fail open, like every gate
    expect(jar.setCalls).toBe(0); // ...but no re-mint on a row we could not read
  });

  it("REGRESSION: a stale cached row with no horizon does not re-mint past a horizon the fresh read carries", async () => {
    state.cfg.beta_allowlist = list("a@x.com");
    state.db = "configured";
    state.cached = { status: "active", plan: "free" }; // 10s cache, filled before the revocation
    state.row = { status: "active", sessions_valid_from: new Date(Date.now() - 60_000).toISOString() };
    jar.value = forgeCookie("a@x.com", Date.now() - 16 * DAY); // predates the horizon
    expect(await getSession()).toBe(null);
    expect(jar.setCalls).toBe(0);
  });

  it("a fresh read that says BLOCKED refuses the renewal pass", async () => {
    state.cfg.beta_allowlist = list("a@x.com");
    state.db = "configured";
    state.cached = { status: "active", plan: "free" };
    state.row = { status: "blocked", sessions_valid_from: null };
    jar.value = forgeCookie("a@x.com", Date.now() - 16 * DAY);
    expect(await getSession()).toBe(null);
    expect(jar.setCalls).toBe(0);
  });

  it("a positively read, clean row past halfway is renewed", async () => {
    state.cfg.beta_allowlist = list("a@x.com");
    state.db = "configured";
    state.row = { status: "active", sessions_valid_from: new Date(Date.now() - 20 * DAY).toISOString() };
    jar.value = forgeCookie("a@x.com", Date.now() - 16 * DAY); // issued AFTER that horizon
    expect((await getSession())?.email).toBe("a@x.com");
    expect(jar.setCalls).toBe(1);
  });

  it("demo mode (no durable store) still renews - there is no revocation store to consult", async () => {
    state.cfg.beta_allowlist = list("a@x.com");
    state.db = "unconfigured";
    state.cached = null;
    jar.value = forgeCookie("a@x.com", Date.now() - 16 * DAY);
    expect((await getSession())?.email).toBe("a@x.com");
    expect(jar.setCalls).toBe(1);
  });

  it("a YOUNG cookie is not re-checked per request - the de-invite revocation below is what ends it", async () => {
    // Deliberate: no vault read on every authenticated request. The owner's
    // save moves sessions_valid_from, which the horizon gate already honours.
    state.cfg.beta_allowlist = list("someone-else@example.com");
    jar.value = forgeCookie("a@x.com", Date.now() - 60_000);
    expect((await getSession())?.email).toBe("a@x.com");
    expect(jar.setCalls).toBe(0);
  });
});

describe("saveBetaAllowlist makes de-invitation a revocation", () => {
  it("REGRESSION: every tester dropped from the list has their sessions revoked", async () => {
    state.cfg.beta_allowlist = list("a@x.com", "b@x.com", "c@x.com");
    const res = await saveBetaAllowlist([{ email: "a@x.com", plan: "free" }]);
    expect(res.saved.map((e) => e.email)).toEqual(["a@x.com"]);
    expect(state.revoked.sort()).toEqual(["b@x.com", "c@x.com"]);
    expect(res.revoked.sort()).toEqual(["b@x.com", "c@x.com"]);
    expect(res.revokeFailed).toEqual([]);
    expect(res.persisted).toBe(true);
  });

  it("kept and newly added testers are left signed in", async () => {
    state.cfg.beta_allowlist = list("a@x.com");
    await saveBetaAllowlist([
      { email: "a@x.com", plan: "pro" },
      { email: "new@x.com", plan: "free" },
    ]);
    expect(state.revoked).toEqual([]);
  });

  it("an env-listed tester is still invited after a config save, so is not revoked", async () => {
    process.env.BETA_ALLOWLIST = "env@x.com:pro";
    state.cfg.beta_allowlist = list("a@x.com");
    await saveBetaAllowlist([]);
    expect(state.revoked).toEqual(["a@x.com"]);
  });

  it("a revocation that did not persist is reported BY NAME, not folded into ok:true", async () => {
    state.cfg.beta_allowlist = list("a@x.com", "b@x.com");
    state.revokeResult = false;
    const res = await saveBetaAllowlist([{ email: "a@x.com", plan: "free" }]);
    expect(res.revoked).toEqual([]);
    expect(res.revokeFailed).toEqual(["b@x.com"]);
  });
});

describe("PUT /api/admin/beta tells the owner what did not happen", () => {
  async function loadRoute(saveResult: {
    revoked: string[];
    revokeFailed: string[];
    persisted: boolean;
    error?: string;
  }) {
    vi.resetModules();
    vi.doMock("@/lib/session", () => ({
      getSession: async () => ({ email: OWNER, role: "owner" }),
    }));
    vi.doMock("@/lib/allowlist", () => ({
      betaAllowlist: async () => [{ email: OWNER, plan: "ultra" }],
      betaLockEnabled: () => true,
      BETA_ALLOWLIST_MAX: 100,
      saveBetaAllowlist: async () => ({ saved: [], dropped: 0, max: 100, ...saveResult }),
    }));
    const mod = await import("@/app/api/admin/beta/route");
    return mod.PUT;
  }
  const put = () =>
    new Request("http://localhost/api/admin/beta", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entries: [] }),
    });

  it("names the tester whose revocation did not persist", async () => {
    const PUT = await loadRoute({ revoked: ["a@x.com"], revokeFailed: ["b@x.com"], persisted: true });
    const res = await PUT(put());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.revoked).toEqual(["a@x.com"]);
    expect(body.revokeFailed).toEqual(["b@x.com"]);
    expect(body.note).toMatch(/b@x\.com/);
  });

  it("a list that did not persist is a 502, not ok:true", async () => {
    const PUT = await loadRoute({
      revoked: [],
      revokeFailed: [],
      persisted: false,
      error: "Could not save to Supabase (503).",
    });
    const res = await PUT(put());
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/Could not save/);
  });
});
