// AUDIT M38 - the claim-less writers of `negotiation_threads.fields` must not
// blind-write a whole blob they read earlier.
//
// `fields` is one JSONB object. The engine's own saveThreadState writes it
// under `version=eq.<read>`, but the traveller's substitution decision
// (/api/negotiate/alternative -> resolveAlternativeOffer) runs OUTSIDE the
// per-thread turn claim and used a bare `thread_key=eq.<key>` PATCH: an inbound
// turn that finished between the route's read and its write had its whole SPTE
// digest erased, and because the bare PATCH also left `version` alone,
// saveThreadState's own lost-race merge never even noticed.
//
// These tests EXECUTE the store against a Map-backed ../runtime-config, with a
// concurrent turn landing between the read and the write.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

interface StoreRow {
  thread_key: string;
  user_email: string;
  vendor_id: string;
  fields: Record<string, unknown>;
  version: number;
  updated_at: string;
}

const store = new Map<string, StoreRow>();
const hooks: { afterRead: null | (() => void) } = { afterRead: null };

function keyOf(query: string): string {
  return decodeURIComponent(/thread_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
}
function versionOf(query: string): number | null {
  const m = /version=eq\.(\d+)/.exec(query);
  return m ? Number(m[1]) : null;
}
function applyUpdate(filter: string, values: Record<string, unknown>): StoreRow | null {
  const row = store.get(keyOf(filter));
  if (!row) return null;
  const want = versionOf(filter);
  if (want !== null && row.version !== want) return null;
  const clean = JSON.parse(JSON.stringify(values)) as Record<string, unknown>;
  const next = { ...row, ...clean } as StoreRow;
  store.set(next.thread_key, next);
  return next;
}
function fireAfterRead(): void {
  const h = hooks.afterRead;
  hooks.afterRead = null;
  h?.();
}

vi.mock("../runtime-config", () => ({
  sbSelectStrict: async (_t: string, query: string) => {
    const vendor = decodeURIComponent(/vendor_id=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    const rows = [...store.values()]
      .filter((r) => r.vendor_id === vendor)
      .map((r) => JSON.parse(JSON.stringify(r)) as StoreRow);
    fireAfterRead();
    return { rows };
  },
  sbSelect: async (_t: string, query: string) => {
    const row = store.get(keyOf(query));
    return row ? [JSON.parse(JSON.stringify(row))] : [];
  },
  sbUpdate: async (_t: string, filter: string, values: Record<string, unknown>) =>
    applyUpdate(filter, values) !== null,
  sbUpdateReturning: async (_t: string, filter: string, values: Record<string, unknown>) => {
    const row = applyUpdate(filter, values);
    return row ? [JSON.parse(JSON.stringify(row))] : [];
  },
}));

import { persistAlternativeOffer, resolveAlternativeOffer } from "./substitution-store";

const KEY = "traveller@example.com:66812345678";
const OFFER = {
  vehicle: "Honda PCX",
  engineSizeCc: 150,
  reason: "same class",
  at: "2026-01-01T00:00:00.000Z",
} as unknown as Parameters<typeof persistAlternativeOffer>[0]["offer"];

function seed(fields: Record<string, unknown>, version = 5): void {
  store.set(KEY, {
    thread_key: KEY,
    user_email: "traveller@example.com",
    vendor_id: "v1",
    fields,
    version,
    updated_at: new Date(1_700_000_000_000).toISOString(),
  });
}

/** A turn finishing between the route's read and its write. */
function concurrentTurn(): void {
  const row = store.get(KEY)!;
  store.set(KEY, {
    ...row,
    version: row.version + 1,
    fields: {
      ...row.fields,
      digest: { facts: ["deposit is passport"], quotedPricePerDay: 280 },
      language: { mode: "english", reason: "shop-asked", at: "2026-01-01T00:00:00.000Z" },
    },
  });
}

beforeEach(() => {
  store.clear();
  hooks.afterRead = null;
});

describe("substitution store writes are versioned (M38)", () => {
  it("resolve keeps a turn's digest that landed between the read and the write", async () => {
    seed({ firmCount: 0, toneDegraded: false, rounds: 1, alternativeOffer: OFFER });
    hooks.afterRead = concurrentTurn;

    const out = await resolveAlternativeOffer({
      email: "traveller@example.com",
      vendorId: "v1",
      accept: false,
    });

    expect(out.ok).toBe(true);
    const row = store.get(KEY)!;
    // The traveller's decision landed...
    expect(row.fields.alternativeOffer).toBeNull();
    expect(row.fields.declined).toBe(true);
    // ...without erasing what the concurrent turn had just learned.
    expect((row.fields.digest as { quotedPricePerDay?: number } | undefined)?.quotedPricePerDay).toBe(
      280
    );
    expect((row.fields.language as { mode?: string } | undefined)?.mode).toBe("english");
    // And the version moved, so the engine's own cas can see the write.
    expect(row.version).toBe(7);
  });

  it("park keeps a turn's digest that landed between the read and the write", async () => {
    seed({ firmCount: 0, toneDegraded: false, rounds: 1 });
    hooks.afterRead = concurrentTurn;

    const parked = await persistAlternativeOffer({
      email: "traveller@example.com",
      vendorId: "v1",
      offer: OFFER,
    });

    expect(parked).toBe(true);
    const row = store.get(KEY)!;
    expect((row.fields.alternativeOffer as { vehicle?: string } | undefined)?.vehicle).toBe(
      "Honda PCX"
    );
    expect((row.fields.digest as { quotedPricePerDay?: number } | undefined)?.quotedPricePerDay).toBe(
      280
    );
    expect(row.version).toBe(7);
  });

  it("reports a write it could not land rather than clearing the choice", async () => {
    seed({ firmCount: 0, toneDegraded: false, rounds: 1, alternativeOffer: OFFER });
    // The row is gone by the time the decision is written - no retry can land
    // it, and the honest answer is "still open", not "already answered".
    hooks.afterRead = () => store.delete(KEY);

    const out = await resolveAlternativeOffer({
      email: "traveller@example.com",
      vendorId: "v1",
      accept: true,
    });

    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toBe("unavailable");
  });
});
