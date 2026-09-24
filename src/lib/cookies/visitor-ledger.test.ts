import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeConsent, newReceiptId } from "./consent";

const inserted: { table: string; rows: Record<string, unknown>[] }[] = [];
let insertOk = true;

vi.mock("@/lib/runtime-config", () => ({
  sbInsert: vi.fn(async (table: string, rows: Record<string, unknown>[]) => {
    inserted.push({ table, rows });
    return insertOk;
  }),
}));

const { recordVisitorConsent, visitorKeyFor } = await import("./visitor-ledger");

beforeEach(() => {
  inserted.length = 0;
  insertOk = true;
});

describe("proof of a signed-out visitor's cookie choice", () => {
  const id = newReceiptId();
  const consent = makeConsent({ preferences: true, analytics: false, marketing: true }, "custom", Date.now(), id);

  it("files one row with the choice, the policy version and how it was made", async () => {
    const ok = await recordVisitorConsent(consent, { gpc: false, region: "other", lang: "en" });
    expect(ok).toBe(true);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].table).toBe("visitor_consent_events");
    expect(inserted[0].rows[0]).toMatchObject({
      policy_version: consent.version,
      source: "custom",
      preferences: true,
      analytics: false,
      marketing: true,
      gpc: false,
      region: "other",
      lang: "en",
    });
    expect(String(inserted[0].rows[0].copy_hash)).toMatch(/^[0-9a-f]{64}$/);
  });

  // The raw receipt id is a bearer token for "show me this visitor's history".
  // Only its hash is stored, so the database alone cannot mint a cookie.
  it("stores the HASH of the receipt id, never the id", async () => {
    await recordVisitorConsent(consent, { gpc: false, region: "other", lang: "en" });
    const row = inserted[0].rows[0];
    expect(row.visitor_key).toBe(visitorKeyFor(id));
    expect(String(row.visitor_key)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(id);
  });

  it("holds nothing that identifies a person or a device", async () => {
    await recordVisitorConsent(consent, { gpc: true, region: "tcf", lang: "de" });
    const keys = Object.keys(inserted[0].rows[0]).sort();
    expect(keys).toEqual(
      ["analytics", "copy_hash", "gpc", "lang", "marketing", "policy_version", "preferences", "region", "source", "visitor_key"].sort()
    );
  });

  it("refuses values outside the closed vocabularies instead of storing them", async () => {
    await recordVisitorConsent(consent, {
      gpc: false,
      region: "doron@example.com" as never,
      lang: "<script>alert(1)</script>",
    });
    expect(inserted[0].rows[0]).toMatchObject({ region: "unknown", lang: null });
  });

  it("files nothing without a receipt id - an unkeyed row proves nothing to anyone", async () => {
    const bare = makeConsent({ preferences: false, analytics: false, marketing: false }, "reject-all");
    expect(await recordVisitorConsent(bare, { gpc: false, region: "other", lang: "en" })).toBe(false);
    expect(inserted).toEqual([]);
  });

  it("reports honestly when the row did not land", async () => {
    insertOk = false;
    expect(await recordVisitorConsent(consent, { gpc: false, region: "other", lang: "en" })).toBe(false);
  });
});
