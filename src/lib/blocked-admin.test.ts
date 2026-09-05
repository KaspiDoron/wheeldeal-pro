import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// BLOCKING AN ADMIN WAS A SILENT NO-OP.
//
// The panel rendered Block on every non-owner row, including admins. The route
// wrote status=blocked. And getSession consulted `status` only for sessions
// whose role was `user`, so the one account whose revocation is urgent - a
// rogue admin holding the Key Vault - was the one account the block never
// reached. The owner saw a success toast and nothing happened.
//
// Executed, both halves: the session gate (does the blocked admin still get in?)
// and the route (does it tell the truth about who may block whom, and about
// whether the write landed?).

vi.mock("server-only", () => ({}));

const state = {
  extraAdmins: "",
  user: null as null | { email: string; status: "active" | "blocked"; plan?: string },
};

vi.mock("./runtime-config", () => ({
  getConfig: async () => undefined,
  getConfigFresh: async () => ({ value: state.extraAdmins }),
  setConfig: async () => ({ ok: true, persistent: true }),
  sbCountDark: async () => 0,
}));
vi.mock("./access", () => ({
  getUser: async () => state.user,
  normalizePlan: (p: string | undefined) => (p === "pro" ? "pro" : p ? "ultra" : "free"),
}));
vi.mock("./allowlist", () => ({ isTestUser: async () => false }));

const jar: { value?: string } = {};
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: () => (jar.value ? { value: jar.value } : undefined),
    set: () => {},
    delete: () => {},
  }),
}));

import { createHmac } from "crypto";
import { getSession } from "./session";

function signIn(email: string) {
  const b64 = Buffer.from(JSON.stringify({ email, issuedAt: Date.now() })).toString("base64url");
  jar.value = `${b64}.${createHmac("sha256", "dev-insecure-secret-change-me")
    .update(b64)
    .digest("hex")}`;
}

describe("a blocked session is refused at every role below owner", () => {
  beforeEach(() => {
    state.extraAdmins = "rogue@example.com";
    process.env.OWNER_EMAIL = "boss@example.com";
    process.env.ADMIN_EMAILS = "boss@example.com";
  });

  it("REGRESSION: a blocked ADMIN no longer keeps full access", async () => {
    state.user = { email: "rogue@example.com", status: "blocked" };
    signIn("rogue@example.com");
    expect(await getSession()).toBe(null);
  });

  it("an active admin is unaffected and still holds Ultra", async () => {
    state.user = { email: "rogue@example.com", status: "active" };
    signIn("rogue@example.com");
    const s = await getSession();
    expect(s?.role).toBe("admin");
    expect(s?.plan).toBe("ultra");
  });

  it("a blocked user is still refused (the Wave 0 behaviour, unchanged)", async () => {
    state.user = { email: "traveller@example.com", status: "blocked" };
    signIn("traveller@example.com");
    expect(await getSession()).toBe(null);
  });

  it("the OWNER can never be locked out by a row in a table admins can reach", async () => {
    // OWNER_EMAIL is env-derived and the route refuses to block it; honouring a
    // blocked row here would hand an admin the one escalation left.
    state.user = { email: "boss@example.com", status: "blocked" };
    signIn("boss@example.com");
    const s = await getSession();
    expect(s?.role).toBe("owner");
  });
});

// ---------------------------------------------------------------------------

interface RouteOpts {
  role: "owner" | "admin";
  admins?: string[];
  /** What the durable list reports AFTER the write (honesty check). */
  persists?: boolean;
}

async function loadUsersRoute(opts: RouteOpts) {
  vi.resetModules();
  const statusWrites: Array<{ email: string; status: string }> = [];
  const admins = opts.admins ?? ["boss@example.com", "rogue@example.com"];
  let stored: "active" | "blocked" = "active";

  vi.doMock("@/lib/session", () => ({
    requireManagement: async () => ({ email: `${opts.role}@example.com`, role: opts.role }),
    setAdmin: async () => {},
    adminEmails: async () => admins,
    isOwner: (e: string) => e.trim().toLowerCase() === "boss@example.com",
  }));
  vi.doMock("@/lib/access", () => ({
    listUsers: async () => [
      {
        email: "rogue@example.com",
        provider: "email",
        status: stored,
        plan: "free",
        addedAt: 0,
        lastSeen: 0,
      },
    ],
    setUserStatus: async (email: string, status: string) => {
      statusWrites.push({ email, status });
      if (opts.persists ?? true) stored = status as "active" | "blocked";
    },
    deleteUser: async () => true,
  }));
  vi.doMock("@/lib/evolution", () => ({
    disconnectInstance: async () => ({ severed: true, hostsTried: 1, hadLink: true }),
  }));
  vi.doMock("@/lib/runtime-config", () => ({
    sbDelete: async () => true,
    sbSelect: async () => [],
    sbCountDark: async () => 1,
  }));

  const mod = await import("@/app/api/admin/users/route");
  return { POST: mod.POST, statusWrites };
}

const blockRogue = () =>
  new Request("http://localhost/api/admin/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "rogue@example.com", status: "blocked" }),
  });

describe("POST /api/admin/users - blocking an admin is an owner action, and an honest one", () => {
  afterEach(() => vi.restoreAllMocks());

  it("the owner CAN stop a rogue admin, and the row comes back blocked", async () => {
    const { POST, statusWrites } = await loadUsersRoute({ role: "owner" });
    const res = await POST(blockRogue());
    expect(res.status).toBe(200);
    expect(statusWrites).toEqual([{ email: "rogue@example.com", status: "blocked" }]);
    const body = await res.json();
    expect(body.users[0].status).toBe("blocked");
  });

  it("a PEER ADMIN cannot, and is told so instead of being lied to", async () => {
    const { POST, statusWrites } = await loadUsersRoute({ role: "admin" });
    const res = await POST(blockRogue());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/Only the owner can block or unblock an admin/);
    expect(statusWrites).toEqual([]);
  });

  it("a peer admin can still block an ordinary user", async () => {
    const { POST, statusWrites } = await loadUsersRoute({
      role: "admin",
      admins: ["boss@example.com"], // rogue@ is now just a user
    });
    const res = await POST(blockRogue());
    expect(res.status).toBe(200);
    expect(statusWrites).toHaveLength(1);
  });

  it("a block that did not persist is reported as a failure, not as success", async () => {
    const { POST } = await loadUsersRoute({ role: "owner", persists: false });
    const res = await POST(blockRogue());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/did not persist/);
    // The truthful list still travels with the error, so the panel can redraw.
    expect(body.users[0].status).toBe("active");
  });

  it("the owner still cannot be blocked at all", async () => {
    const { POST, statusWrites } = await loadUsersRoute({ role: "owner" });
    const res = await POST(
      new Request("http://localhost/api/admin/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "boss@example.com", status: "blocked" }),
      })
    );
    expect(res.status).toBe(400);
    expect(statusWrites).toEqual([]);
  });
});

describe("the admin panel only offers the block it can actually deliver", () => {
  it("the Block button on an ADMIN row is owner-only", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const page = readFileSync(join(process.cwd(), "src/app/admin/page.tsx"), "utf8");
    expect(page).toMatch(/\{\(u\.role !== "admin" \|\| isOwner\) && \(/);
  });
});
