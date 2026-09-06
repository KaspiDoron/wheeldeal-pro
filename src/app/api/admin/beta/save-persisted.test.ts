import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT F197: THE TESTER-LIST SAVE PROVED ITSELF WITH THE FAILED WRITE'S OWN PIN.
//
// G3 (F159) already made saveBetaAllowlist return `persisted` and the PUT answer
// 502 when the list did not reach Supabase. What survived: that 502 body still
// carried `entries: await betaAllowlist()`, and betaAllowlist reads through
// getConfig, which serves `s.mem` - the copy setConfig pins on a FAILED write so
// the instance "at least works right now". So the error response echoed the
// exact 30 testers that were never stored, and the panel, which keyed "Saved -
// N account(s) can log in" off `d.entries` alone, painted a green save over a
// 502. On the next instance the row does not exist and every invited tester is
// refused at login.
//
// The mock below reproduces runtime-config's pin faithfully: a failed setConfig
// keeps the value in `mem`, and getConfig merges `mem` over the durable store.

const durable = new Map<string, string>();
const mem = new Map<string, string>();
const vault = { writesFail: false };

vi.mock("@/lib/runtime-config", () => ({
  getConfig: async (name: string) => mem.get(name) ?? durable.get(name) ?? undefined,
  setConfig: async (name: string, value: string) => {
    if (vault.writesFail) {
      // runtime-config.ts: "Keep an in-memory copy so it at least works right now."
      if (value) mem.set(name, value);
      return {
        ok: false,
        persistent: false,
        error: "Could not save to Supabase (401). Invalid Supabase key.",
      };
    }
    durable.set(name, value);
    mem.delete(name);
    return { ok: true, persistent: true };
  },
}));
vi.mock("@/lib/session", () => ({
  getSession: async () => ({ email: "owner@example.com", role: "owner", plan: "ultra" }),
}));
vi.mock("@/lib/access", () => ({ revokeSessions: async () => true }));

import { PUT, GET } from "./route";

const TESTERS = [
  { email: "a@example.com", plan: "free" },
  { email: "b@example.com", plan: "pro" },
  { email: "c@example.com", plan: "ultra" },
];

const put = (entries: unknown) =>
  PUT(
    new Request("http://local/api/admin/beta", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries }),
    })
  );

beforeEach(() => {
  durable.clear();
  mem.clear();
  vault.writesFail = false;
  process.env.OWNER_EMAIL = "owner@example.com";
  delete process.env.BETA_ALLOWLIST;
});

describe("EXECUTED (F197): a save that did not persist is not proven by the pin", () => {
  it("a failed durable write answers 502 with no optimistic read-back of the unsaved testers", async () => {
    vault.writesFail = true;
    const res = await put(TESTERS);
    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      ok?: boolean;
      persisted?: boolean;
      error?: string;
      entries?: { email: string }[];
    };
    // The panel keys its "Saved" message off `entries`. A list served from the
    // failed write's own in-memory pin is the lie this finding is about.
    const echoed = (body.entries ?? []).map((e) => e.email);
    for (const t of TESTERS) expect(echoed).not.toContain(t.email);
    expect(body.ok).not.toBe(true);
    expect(body.persisted).toBe(false);
    expect(body.error).toMatch(/Could not save to Supabase/);
  });

  it("a persisted save answers 200, ok:true and echoes the durable list", async () => {
    const res = await put(TESTERS);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; entries: { email: string }[] };
    expect(body.ok).toBe(true);
    const echoed = body.entries.map((e) => e.email);
    for (const t of TESTERS) expect(echoed).toContain(t.email);
    expect(JSON.parse(durable.get("beta_allowlist") ?? "[]")).toHaveLength(3);
    // And GET reads the same durable list back.
    const got = (await (await GET()).json()) as { entries: { email: string }[] };
    expect(got.entries.map((e) => e.email)).toContain("b@example.com");
  });
});
