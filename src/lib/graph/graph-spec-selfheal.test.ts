import { describe, it, expect, vi, beforeEach } from "vitest";

// AUDIT F194 - an unreadable graph_spec must never be written back as the
// shipped DEFAULT.
//
// getGraphSpec() self-heals: when the spec reads as absent it persists the
// migrated/default spec so the Studio opens on the owner's real graph. But the
// vault read cannot tell "never saved" from "could not be read": a Supabase
// brownout returns the empty negative cache, and a rotated SESSION_SECRET
// without SESSION_SECRET_PREVIOUS leaves the row PRESENT but undecryptable
// while the read still reports "ok". Both used to reach the self-heal write,
// which upserted defaultGraphSpec() over the owner's edited edges, priorities
// and round cap - encrypted under the new secret, so nothing could recover it,
// with no policy_versions row and no golden replay.
//
// Every test here EXECUTES getGraphSpec against a Map-backed vault.

vi.mock("server-only", () => ({}));
vi.mock("../ai", () => ({
  chat: async () => null,
  chatVision: async () => null,
  extractJson: () => null,
}));
vi.mock("../wa-guard", () => ({
  guardOutbound: async ({ text }: { text: string }) => ({ allow: true, text }),
  afterSend: async () => {},
}));
vi.mock("../market", () => ({
  floorPriceFor: async () => ({ floor: 150, typical: 240, currency: "THB" }),
  vehicleKeyFor: () => "motorbike-125",
  regionKeysFor: () => ["chiang-mai"],
}));

type VaultState = "ok" | "unconfigured" | "unavailable";

const vault: {
  /** What the bulk vault read can DECRYPT - the value getConfig returns. */
  plain: Map<string, string>;
  /** Which app_config rows EXIST (ciphertext present, readable or not). */
  rows: Set<string>;
  state: VaultState;
  decrypt: { count: number; of: number; at: number } | null;
  probeFails: boolean;
  writes: Array<{ name: string; value: string }>;
} = {
  plain: new Map(),
  rows: new Set(),
  state: "ok",
  decrypt: null,
  probeFails: false,
  writes: [],
};

vi.mock("../runtime-config", () => ({
  getConfig: async (name: string) => vault.plain.get(name),
  setConfig: async (name: string, value: string) => {
    vault.writes.push({ name, value });
    vault.plain.set(name, value);
    vault.rows.add(name);
    return { ok: true, persistent: true };
  },
  vaultReadState: () => vault.state,
  vaultDecryptHealth: () => vault.decrypt,
  sbSelectStrict: async (_table: string, query: string) => {
    if (vault.probeFails) return { error: "unavailable" as const };
    const key = decodeURIComponent(/key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    return { rows: vault.rows.has(key) ? [{ key }] : [] };
  },
  sbInsert: async () => true,
  sbSelect: async () => [],
  sbUpdate: async () => true,
}));

import { getGraphSpec } from "./engine";

/** The self-heal write is fire-and-forget; let its microtasks and one timer run. */
const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
};

const specWrites = () => vault.writes.filter((w) => w.name === "graph_spec");

beforeEach(() => {
  vault.plain = new Map();
  vault.rows = new Set();
  vault.state = "ok";
  vault.decrypt = null;
  vault.probeFails = false;
  vault.writes = [];
  globalThis.__wd_graph_spec__ = undefined;
});

describe("F194: the self-heal only writes over a TRUSTWORTHY absence", () => {
  it("REPRODUCTION: a rotated SESSION_SECRET (row present, undecryptable) is not overwritten with the default", async () => {
    // The row is there; the bulk read decrypted nothing and said "ok".
    vault.rows.add("graph_spec");
    vault.decrypt = { count: 1, of: 1, at: Date.now() };
    const spec = await getGraphSpec();
    // Defaults SERVE for this call - the reply path must not stall...
    expect(spec.version).toBe(2);
    await settle();
    // ...but nothing is written: the ciphertext stays recoverable once
    // SESSION_SECRET_PREVIOUS is set.
    expect(specWrites()).toEqual([]);
  });

  it("REPRODUCTION: a vault brownout serves defaults and writes nothing", async () => {
    vault.state = "unavailable";
    const spec = await getGraphSpec();
    expect(spec.version).toBe(2);
    await settle();
    expect(specWrites()).toEqual([]);
  });

  it("a genuinely fresh install still self-heals (the write this exists for)", async () => {
    vault.state = "ok";
    vault.decrypt = { count: 0, of: 4, at: Date.now() };
    await getGraphSpec();
    await settle();
    expect(specWrites()).toHaveLength(1);
    expect(JSON.parse(specWrites()[0].value).version).toBe(2);
  });

  it("one unrelated stale row does not disable the self-heal forever (refuter's concern)", async () => {
    // A deployment carrying one pre-rotation row it never used: the global
    // decrypt counter is non-zero, but graph_spec's OWN row is absent.
    vault.rows.add("OLD_UNUSED_KEY");
    vault.decrypt = { count: 1, of: 3, at: Date.now() };
    await getGraphSpec();
    await settle();
    expect(specWrites()).toHaveLength(1);
  });

  it("under decrypt trouble, a probe that cannot answer refuses to write", async () => {
    vault.decrypt = { count: 1, of: 3, at: Date.now() };
    vault.probeFails = true;
    await getGraphSpec();
    await settle();
    expect(specWrites()).toEqual([]);
  });

  it("a readable spec is served as-is and never rewritten", async () => {
    const stored = { version: 2, nodes: [], edges: [] };
    vault.plain.set("graph_spec", JSON.stringify(stored));
    const spec = await getGraphSpec();
    expect(spec.version).toBe(2);
    await settle();
    expect(specWrites()).toEqual([]);
  });
});
