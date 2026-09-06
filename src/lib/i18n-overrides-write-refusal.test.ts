import { describe, it, expect, vi, beforeEach } from "vitest";

// AUDIT F196 - setOverride must REFUSE, not rebuild, when the current
// corrections could not be read.
//
// setOverride is a read-modify-write over readOverrides, a reader that is
// documented total: an unreadable row returns {}. That is right on the
// translate path (degrade to the machine translation) and catastrophic on the
// write path: one PostgREST 500, one 8s abort, or a rotated SESSION_SECRET
// (the raw "v1:..." ciphertext fails JSON.parse) made `current` an empty
// object, and the save wrote a one-entry dictionary over every correction the
// owner had ever written - encrypted under the new secret, so
// SESSION_SECRET_PREVIOUS could no longer recover it - while answering
// { ok: true, count: 1 }.
//
// The store is one app_config row per language. Reads have three real
// outcomes (value / unavailable / undecryptable) and the fake models all three.

vi.mock("server-only", () => ({}));

type ReadState = "ok" | "unavailable" | "undecryptable";
const store = new Map<string, string>();
let readState: ReadState = "ok";

vi.mock("./runtime-config", () => ({
  // The total reader's REAL behaviour: every failure falls back to
  // process.env[name] (undefined), a rotated secret yields the raw ciphertext.
  getConfigExact: async (name: string) => {
    if (readState === "unavailable") return undefined;
    if (readState === "undecryptable") return "v1:aGVsbG8=:d29ybGQ=:c2VjcmV0";
    return store.get(name);
  },
  getConfigExactStrict: async (name: string) => {
    if (readState === "unavailable") return { error: "unavailable" as const };
    if (readState === "undecryptable") return { error: "undecryptable" as const };
    return { value: store.get(name) };
  },
  setConfig: async (name: string, value: string) => {
    if (value) store.set(name, value);
    else store.delete(name);
    return { ok: true, persistent: true };
  },
}));

import { setOverride, readOverrides } from "./i18n-overrides";

const seedTwo = () => {
  store.set("I18N_OVERRIDE_he", JSON.stringify({ Next: "kadima", Back: "achora" }));
};

beforeEach(() => {
  store.clear();
  readState = "ok";
  vi.resetModules();
});

describe("F196: a failed read during a write refuses rather than overwrites", () => {
  it("REPRODUCTION: PostgREST down while saving correction #3 keeps the first two", async () => {
    seedTwo();
    readState = "unavailable";
    const res = await setOverride("he", "Save", "shmor");
    expect(res.ok).toBe(false);
    readState = "ok";
    expect(await readOverrides("he")).toEqual({ Next: "kadima", Back: "achora" });
  });

  it("REPRODUCTION: a rotated SESSION_SECRET (ciphertext, unparseable) is not overwritten", async () => {
    seedTwo();
    readState = "undecryptable";
    const res = await setOverride("he", "Save", "shmor");
    expect(res.ok).toBe(false);
    readState = "ok";
    // The recoverable ciphertext (here: the seeded row) is untouched.
    expect(await readOverrides("he")).toEqual({ Next: "kadima", Back: "achora" });
  });

  it("clearing a correction is refused on an unreadable row too - a delete is also a rewrite", async () => {
    seedTwo();
    readState = "unavailable";
    const res = await setOverride("he", "Next", "");
    expect(res.ok).toBe(false);
    readState = "ok";
    expect(await readOverrides("he")).toEqual({ Next: "kadima", Back: "achora" });
  });

  it("a healthy read still writes, and read-modify-write keeps the siblings", async () => {
    seedTwo();
    const res = await setOverride("he", "Save", "shmor");
    expect(res).toEqual({ ok: true, count: 3 });
    expect(await readOverrides("he")).toEqual({ Next: "kadima", Back: "achora", Save: "shmor" });
  });

  it("the translate-path reader still degrades to {} (never fail closed on a blip)", async () => {
    seedTwo();
    readState = "unavailable";
    expect(await readOverrides("he")).toEqual({});
  });
});

describe("F196: the admin route answers 502 for a store failure, 400 for bad input", () => {
  async function loadRoute() {
    vi.doMock("@/lib/session", () => ({
      requireManagement: async () => ({ email: "owner@example.com" }),
    }));
    const mod = await import("../app/api/admin/i18n/route");
    return mod.POST;
  }
  const post = (body: unknown) =>
    new Request("http://localhost/api/admin/i18n", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("an unreadable store is a 502 - nothing changed, try again", async () => {
    seedTwo();
    readState = "unavailable";
    const POST = await loadRoute();
    const res = await POST(post({ lang: "he", source: "Save", text: "shmor" }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: string; ok?: boolean };
    expect(body.ok).toBeUndefined();
    expect(String(body.error)).toMatch(/nothing changed/i);
    readState = "ok";
    expect(await readOverrides("he")).toEqual({ Next: "kadima", Back: "achora" });
  });

  it("bad input stays a 400", async () => {
    const POST = await loadRoute();
    const res = await POST(post({ lang: "he", source: "  ", text: "x" }));
    expect(res.status).toBe(400);
  });

  it("a real save is a 200 with the new count", async () => {
    seedTwo();
    const POST = await loadRoute();
    const res = await POST(post({ lang: "he", source: "Save", text: "shmor" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, count: 3 });
  });
});
