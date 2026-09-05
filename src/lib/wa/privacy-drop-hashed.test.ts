import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("server-only", () => ({}));

// AUDIT F173: THE PRIVACY GATE RECORDED THE PHONE NUMBER OF EVERY PERSONAL CHAT
// IT REFUSED.
//
// When isVendorThread says "not a shop thread this traveller opened", ingest
// calls noteInboundDropped(email, from, "vendor-gate"), and that wrote the
// third party's bare digits into agent_events.to_number, vendor_name and
// detail.digits - a durable row per personal contact, kept for the 90-day
// agent_events window, while the ingest comment says "never stored, never
// read" and the Privacy Policy promises those messages never enter the app's
// own store. The gate's own breadcrumb was the leak.
//
// Executed against the real writer with a Map-backed store: a privacy-gate
// drop carries NO number anywhere in the row - only a short, stable hash the
// WA doctor can still match a number against - while a drop on a shop thread
// the traveller opened keeps its address, because the message-path panel
// joins on it.

vi.mock("../runtime-config", async () => {
  const h = await import("../privacy/postgrest-store.test-helper");
  return h.runtimeConfigMock();
});

import { store } from "../privacy/postgrest-store.test-helper";
import { noteInboundDropped } from "./webhook-trace";
import { PRIVACY_DROP_REASONS, dropDigitsHash } from "./drop-privacy";

const EMAIL = "tester@example.com";

beforeEach(() => {
  store.reset();
});

const lastRow = () => store.rows("agent_events").at(-1) as Record<string, unknown>;
const lastDetail = () => JSON.parse(String(lastRow().detail)) as Record<string, unknown>;

describe("EXECUTED (F173): a refused personal chat leaves no phone number behind", () => {
  it("vendor-gate: to_number absent, vendor_name empty, digits null, nothing in the row spells the number", async () => {
    const partner = "66812345678";
    await noteInboundDropped(EMAIL, partner, "vendor-gate", { via: "webhook" });
    const row = lastRow();
    // THE ASSERTIONS THAT FAILED BEFORE: the row carried the number three times.
    expect(row).not.toHaveProperty("to_number");
    expect(row.vendor_name).toBe("");
    expect(lastDetail().digits).toBeNull();
    expect(JSON.stringify(row)).not.toContain(partner);
    // The traveller's own attribution stays, so the row is still theirs to erase.
    expect(row.user_email).toBe(EMAIL);
    expect(row.kind).toBe("inbound-dropped");
  });

  it("...but the doctor can still match a number to the drop through the hash", async () => {
    const partner = "66899990001";
    await noteInboundDropped(EMAIL, partner, "non-chat-jid", { via: "webhook" });
    const det = lastDetail();
    expect(det.digitsHash).toBe(dropDigitsHash(partner));
    expect(String(det.digitsHash)).toMatch(/^[0-9a-f]{8}$/);
  });

  it("every gate reason that fires before a thread is known is a privacy reason", () => {
    for (const r of [
      "vendor-gate",
      "vendor-gate-unavailable",
      "non-chat-jid",
      "receiver-unresolvable",
      "identity-unavailable",
      "unresolved-identity",
    ]) {
      expect(PRIVACY_DROP_REASONS.has(r), r).toBe(true);
    }
  });
});

describe("a drop on a shop thread the traveller opened stays addressed", () => {
  it("no-rfq-thread keeps to_number and digits (the message-path panel joins on them)", async () => {
    const shop = "66877770002";
    await noteInboundDropped(EMAIL, shop, "no-rfq-thread", { anchors: 0 });
    const row = lastRow();
    expect(row.to_number).toBe(shop);
    expect(row.vendor_name).toBe(shop);
    expect(lastDetail().digits).toBe(shop);
  });
});

describe("the hash is stable across spellings and instances", () => {
  it("a national and an international spelling of one number hash the same", () => {
    expect(dropDigitsHash("081236954642")).toBe(dropDigitsHash("6281236954642"));
  });
  it("two different numbers do not", () => {
    expect(dropDigitsHash("66812345678")).not.toBe(dropDigitsHash("66812345679"));
  });
  it("the hash never contains the digits it stands for", () => {
    const n = "66812345678";
    expect(dropDigitsHash(n)).not.toContain(n.slice(-6));
  });
});

describe("the WA doctor matches privacy drops by hash, not by digits", () => {
  it("the thread report compares detail.digitsHash against the asked-for number", () => {
    const doctor = readFileSync(join(process.cwd(), "src/app/api/admin/wa-doctor/route.ts"), "utf8");
    expect(doctor).toMatch(/digitsHash/);
    expect(doctor).toMatch(/dropDigitsHash\(number\)/);
  });
});
