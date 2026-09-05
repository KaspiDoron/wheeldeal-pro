import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT F168.
//
// Every inbound photo, PDF, video and voice note is copied to the `wa-media`
// Storage bucket at `wa-media/<wa_message_id>.<ext>` (lib/media/audit.ts) and
// nothing in the tree ever issued a Storage DELETE. eraseUserData walked
// TABLES only, so it deleted the whatsapp_messages rows - the only index from
// the person to the object paths - and answered {ok:true} while the shop's
// price board and the voice note stayed in the bucket, unreachable forever.
//
// Every test here RUNS eraseUserData against a Map-backed store and a mocked
// Storage endpoint, and asserts the objects are deleted BEFORE the index rows,
// that a failed purge is NAMED, and that the transcripts survive for a retry.

const calls: {
  deletes: { table: string; filter: string }[];
  fetches: { url: string; method: string; body: { prefixes?: string[] } | null }[];
  seq: string[];
  storageStatus: number;
  ids: string[];
} = { deletes: [], fetches: [], seq: [], storageStatus: 200, ids: [] };

vi.mock("../runtime-config", () => ({
  supabaseConfigured: () => true,
  sbDelete: async (table: string, filter: string) => {
    calls.deletes.push({ table, filter });
    calls.seq.push(`delete:${table}`);
    return true;
  },
  sbSelect: async () => [],
  sbSelectStrict: async (table: string, query: string) => {
    if (table === "whatsapp_messages" && /select=wa_message_id/.test(query) && /receiver/.test(query)) {
      const offset = Number(/offset=(\d+)/.exec(query)?.[1] ?? 0);
      return { rows: offset === 0 ? calls.ids.map((id) => ({ wa_message_id: id })) : [] };
    }
    return { rows: [] };
  },
  sbInsert: async () => true,
  sbUpdate: async () => true,
  getConfig: async () => undefined,
}));

vi.mock("../evolution", () => ({
  disconnectInstance: async () => ({ severed: true, hostsTried: 1, hadLink: true }),
}));

import { eraseUserData } from "./erase";

const realFetch = globalThis.fetch;

beforeEach(() => {
  calls.deletes = [];
  calls.fetches = [];
  calls.seq = [];
  calls.storageStatus = 200;
  calls.ids = ["3EB0A1", "3EB0B2"];
  process.env.SUPABASE_URL = "https://proj.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    let body: { prefixes?: string[] } | null = null;
    try {
      body = init?.body ? (JSON.parse(String(init.body)) as { prefixes?: string[] }) : null;
    } catch {
      body = null;
    }
    calls.fetches.push({ url: String(url), method, body });
    calls.seq.push(`storage:${method.toLowerCase()}`);
    const status = calls.storageStatus;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => [],
      text: async () => "[]",
    } as unknown as Response;
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

const storageDeletes = () =>
  calls.fetches.filter(
    (f) => f.method === "DELETE" && f.url === "https://proj.supabase.co/storage/v1/object/wa-media"
  );
const allPrefixes = () => storageDeletes().flatMap((f) => f.body?.prefixes ?? []);

describe("EXECUTED: the audit copies leave with the person", () => {
  it("issues a Storage DELETE for every stored id, in every audited extension, BEFORE the index rows go", async () => {
    const r = await eraseUserData("someone@example.com");
    // THE ASSERTION THAT FAILED BEFORE: no code path ever deleted an object.
    expect(storageDeletes().length).toBeGreaterThan(0);
    const prefixes = allPrefixes();
    for (const p of ["3EB0A1.jpg", "3EB0A1.png", "3EB0A1.webp", "3EB0A1.pdf", "3EB0A1.mp4", "3EB0A1.ogg", "3EB0B2.jpg"]) {
      expect(prefixes, p).toContain(p);
    }
    // The frame-indexed spelling the reader also tries.
    expect(prefixes).toContain("3EB0A1-0.jpg");
    expect(r.purged["storage:wa-media"]).toBe(true);
    // The objects go first: once whatsapp_messages is gone nothing can find them.
    const firstStorage = calls.seq.indexOf("storage:delete");
    const firstIndexDelete = calls.seq.indexOf("delete:whatsapp_messages");
    expect(firstStorage).toBeGreaterThan(-1);
    expect(firstIndexDelete).toBeGreaterThan(firstStorage);
    expect(r.failed).toEqual([]);
  });

  it("a failed Storage purge is NAMED, and the transcripts (the only index) survive for the retry", async () => {
    calls.storageStatus = 500;
    const r = await eraseUserData("someone@example.com");
    expect(r.failed).toContain("storage:wa-media");
    expect(calls.deletes.filter((d) => d.table === "whatsapp_messages")).toEqual([]);
    expect(r.failed).toContain("whatsapp_messages");
    expect(r.userDeleted).toBe(false);
  });

  it("no stored ids is a successful no-op - no Storage call at all", async () => {
    calls.ids = [];
    const r = await eraseUserData("someone@example.com");
    expect(storageDeletes()).toEqual([]);
    expect(r.purged["storage:wa-media"]).toBe(true);
    expect(r.userDeleted).toBe(true);
  });

  it("a bucket that was never created (404) holds nothing - vacuously purged", async () => {
    calls.storageStatus = 404;
    const r = await eraseUserData("someone@example.com");
    expect(r.purged["storage:wa-media"]).toBe(true);
  });

  it("the registry DECLARES the store, and the walker reports every declared store by its key", async () => {
    const { USER_OBJECT_STORES } = await import("./user-tables");
    expect(USER_OBJECT_STORES.length).toBeGreaterThan(0);
    const r = await eraseUserData("someone@example.com");
    for (const store of USER_OBJECT_STORES) {
      expect(typeof r.purged[store.purgedKey], store.purgedKey).toBe("boolean");
    }
  });
});
