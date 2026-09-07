import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT F164: THE FIVE OWNER-ONLY TRANSPORT SWITCHES WERE WRITABLE BY ANY
// ADMIN THROUGH THE KEY VAULT DOOR.
//
// /api/admin/waba refuses a non-owner with 403 under a docblock that says the
// architecture toggles "start and stop live senders, which is above the
// management tier". /api/admin/config accepted the byte-identical intent from
// any management session, because setKey authorised on `meta.editable` alone
// and every one of TRANSPORT_MODE, WABA_ENABLED, WABA_DRY_RUN, WABA_KILL and
// CLOUD_API_ENABLED is editable. So a runtime admin could clear the owner's
// emergency stop, or turn the dry run off and put the company number on the
// wire for real.
//
// The tier is a property of the KEY now, not of the door: the five entries
// carry `owner: true`, setKey takes the caller's role and refuses them for a
// non-owner, and the vault route answers 403 the way admin/waba does. Every
// test here RUNS the route against a Map-backed vault.

const session: { role: "admin" | "owner" } = { role: "admin" };

vi.mock("@/lib/session", () => ({
  requireManagement: async () => ({
    email: "someone@example.com",
    role: session.role,
    plan: "ultra",
    issuedAt: 0,
  }),
  getSession: async () => ({
    email: "someone@example.com",
    role: session.role,
    plan: "ultra",
    issuedAt: 0,
  }),
}));

vi.mock("@/lib/runtime-config", async () => {
  const h = await import("@/lib/privacy/postgrest-store.test-helper");
  const base = h.runtimeConfigMock();
  return {
    ...base,
    // The vault write lands in the same Map getConfig reads back from, so the
    // route's read-back echo is a real read-back.
    setConfig: async (name: string, value: string) => {
      h.store.config.set(name, value);
      return { ok: true, persistent: true };
    },
  };
});

import { store } from "@/lib/privacy/postgrest-store.test-helper";
import { GET, POST } from "./route";

const OWNER_ONLY = ["TRANSPORT_MODE", "WABA_ENABLED", "WABA_DRY_RUN", "WABA_KILL", "CLOUD_API_ENABLED"];

const valueFor = (name: string) => (name === "TRANSPORT_MODE" ? "waba-first" : "off");

const post = (name: string, value: string) =>
  POST(
    new Request("http://local/api/admin/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, value }),
    })
  );

beforeEach(() => {
  store.reset();
  session.role = "admin";
});

describe("EXECUTED (F164): the vault door enforces the owner tier on the transport switches", () => {
  for (const name of OWNER_ONLY) {
    it(`a non-owner admin is refused ${name} with 403 and the vault is unchanged`, async () => {
      const res = await post(name, valueFor(name));
      // THE ASSERTION THAT FAILED BEFORE: the write answered 200 with a
      // read-back of the admin's value.
      expect(res.status).toBe(403);
      expect(store.config.get(name)).toBeUndefined();
    });
  }

  it("the same admin can still write an ordinary management setting", async () => {
    const res = await post("HUMAN_TAKEOVER", "off");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { key: { name: string; masked: string } };
    expect(body.key.name).toBe("HUMAN_TAKEOVER");
    expect(body.key.masked).toBe("off");
    expect(store.config.get("HUMAN_TAKEOVER")).toBe("off");
  });

  it("the owner writes every one of the five, and the response is the vault's read-back", async () => {
    session.role = "owner";
    for (const name of OWNER_ONLY) {
      const res = await post(name, valueFor(name));
      expect(res.status, name).toBe(200);
      const body = (await res.json()) as { key: { name: string; masked: string } };
      expect(body.key.masked, name).toBe(valueFor(name));
      expect(store.config.get(name), name).toBe(valueFor(name));
    }
  });

  it("the listing marks the five rows owner-only, so the Keys tab can withhold the control", async () => {
    const res = await GET(new Request("http://local/api/admin/config"));
    const body = (await res.json()) as { keys: { name: string; ownerOnly?: boolean }[] };
    for (const name of OWNER_ONLY) {
      expect(body.keys.find((k) => k.name === name)?.ownerOnly, name).toBe(true);
    }
    expect(body.keys.find((k) => k.name === "HUMAN_TAKEOVER")?.ownerOnly).toBeFalsy();
  });
});
