import { describe, it, expect, vi, beforeEach } from "vitest";

// AUDIT F195 - an unreadable VAPID pair must not trigger auto-provisioning.
//
// vapidPublicKey() mints and persists a keypair when BOTH keys read as absent,
// so a terminal-free owner gets push alerts with zero setup. But "both absent"
// is also what a vault brownout and a rotated SESSION_SECRET look like from
// getConfig - and setConfig is an UPSERT, so provisioning in that state wrote a
// brand-new pair over the still-present rows. Every push_subscriptions endpoint
// in the fleet was minted against the old applicationServerKey and died at the
// push service, while the doctor said "ok" because the new pair was internally
// consistent.
//
// Every test here EXECUTES vapidPublicKey against a Map-backed vault.

vi.mock("server-only", () => ({}));
vi.mock("./site", () => ({ resolveSiteHost: async () => "example.test" }));

type VaultState = "ok" | "unconfigured" | "unavailable";

const vault: {
  plain: Map<string, string>;
  rows: Set<string>;
  state: VaultState;
  probeFails: boolean;
  writes: string[];
} = { plain: new Map(), rows: new Set(), state: "ok", probeFails: false, writes: [] };

vi.mock("./runtime-config", () => ({
  getConfig: async (name: string) => vault.plain.get(name),
  setConfig: async (name: string, value: string) => {
    vault.writes.push(name);
    if (value) {
      vault.plain.set(name, value);
      vault.rows.add(name);
    } else {
      vault.plain.delete(name);
      vault.rows.delete(name);
    }
    return { ok: true, persistent: true };
  },
  sbInsert: async () => true,
  sbSelect: async () => [],
  sbDelete: async () => true,
  sbSelectStrict: async (_table: string, query: string) => {
    if (vault.probeFails) return { error: "unavailable" as const };
    const m = /key=in\.\(([^)]+)\)/.exec(query);
    const keys = m ? m[1].split(",") : [];
    return { rows: keys.filter((k) => vault.rows.has(k)).map((k) => ({ key: k })) };
  },
  vaultReadState: () => vault.state,
}));

import { vapidPublicKey } from "./push";
import { vapidPairMatches } from "./push-keys";

beforeEach(() => {
  vault.plain = new Map();
  vault.rows = new Set();
  vault.state = "ok";
  vault.probeFails = false;
  vault.writes = [];
});

describe("F195: provisioning happens only from a TRUSTWORTHY absence", () => {
  it("REPRODUCTION: rows present but undecryptable (rotated secret) -> null, and NOTHING is written", async () => {
    vault.rows.add("VAPID_PUBLIC_KEY");
    vault.rows.add("VAPID_PRIVATE_KEY");
    const pub = await vapidPublicKey();
    expect(pub).toBeNull();
    expect(vault.writes).toEqual([]);
  });

  it("REPRODUCTION: a vault brownout -> null, nothing written", async () => {
    vault.state = "unavailable";
    const pub = await vapidPublicKey();
    expect(pub).toBeNull();
    expect(vault.writes).toEqual([]);
  });

  it("a probe that cannot answer refuses too", async () => {
    vault.probeFails = true;
    expect(await vapidPublicKey()).toBeNull();
    expect(vault.writes).toEqual([]);
  });

  it("a genuinely empty vault still auto-provisions a matching pair", async () => {
    const pub = await vapidPublicKey();
    expect(typeof pub).toBe("string");
    expect(vault.writes).toContain("VAPID_PRIVATE_KEY");
    expect(vault.writes).toContain("VAPID_PUBLIC_KEY");
    expect(
      vapidPairMatches(vault.plain.get("VAPID_PUBLIC_KEY")!, vault.plain.get("VAPID_PRIVATE_KEY")!)
    ).toBe(true);
  });

  it("one unrelated stale row does not block first-time provisioning (refuter's concern)", async () => {
    vault.rows.add("OLD_UNUSED_KEY");
    const pub = await vapidPublicKey();
    expect(typeof pub).toBe("string");
    expect(vault.writes).toContain("VAPID_PUBLIC_KEY");
  });

  it("a half-configured pair is left alone (pinned: never clobber a manual paste)", async () => {
    vault.plain.set("VAPID_PUBLIC_KEY", "BPUBLICONLY");
    vault.rows.add("VAPID_PUBLIC_KEY");
    expect(await vapidPublicKey()).toBeNull();
    expect(vault.writes).toEqual([]);
  });

  it("a readable pair is returned without any write", async () => {
    vault.plain.set("VAPID_PUBLIC_KEY", "BPUB");
    vault.plain.set("VAPID_PRIVATE_KEY", "PRIV");
    expect(await vapidPublicKey()).toBe("BPUB");
    expect(vault.writes).toEqual([]);
  });
});
