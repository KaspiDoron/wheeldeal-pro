import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

// WAVE 9 SLICE C: the edges of the app - response headers, the anon key's
// view of the database, the webhook token gates, the unauthenticated photo
// proxy, and which admin eyes may read transcripts.

import { deriveWebhookToken, tokenMatches } from "./wa/webhook-token";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// ---------------------------------------------------------------------------
// Security headers - nothing in the stack set ANY before this.
// ---------------------------------------------------------------------------

describe("security headers ship from next.config.mjs", () => {
  const cfg = read("next.config.mjs");

  it("carries the five enforced headers on every path", () => {
    expect(cfg).toMatch(/async headers\(\)/);
    expect(cfg).toMatch(/source: "\/\(\.\*\)"/);
    expect(cfg).toMatch(/Strict-Transport-Security/);
    expect(cfg).toMatch(/max-age=63072000; includeSubDomains; preload/);
    expect(cfg).toMatch(/X-Content-Type-Options[\s\S]{0,40}nosniff/);
    expect(cfg).toMatch(/Referrer-Policy[\s\S]{0,60}strict-origin-when-cross-origin/);
    expect(cfg).toMatch(/X-Frame-Options[\s\S]{0,30}DENY/);
    expect(cfg).toMatch(/Permissions-Policy/);
  });

  it("the CSP is REPORT-ONLY, with the reason recorded beside it", () => {
    // An enforced policy that guessed wrong about GSI/AdSense/PayPal would
    // break login for every traveller at once - so it observes first.
    expect(cfg).toMatch(/Content-Security-Policy-Report-Only/);
    expect(cfg).not.toMatch(/key: "Content-Security-Policy",/);
    expect(cfg).toMatch(/frame-ancestors 'none'/);
    expect(cfg).toMatch(/accounts\.google\.com/);
  });
});

// ---------------------------------------------------------------------------
// Webhook token: constant-time everywhere, rotatable without SESSION_SECRET.
// ---------------------------------------------------------------------------

describe("webhook token derivation + comparison", () => {
  const secret = "a-strong-secret-of-adequate-length";

  it("no salt derives the exact historical token (nothing re-arms by surprise)", () => {
    const legacy = deriveWebhookToken({ secret, nodeEnv: "production" });
    const unsalted = deriveWebhookToken({ secret, nodeEnv: "production", salt: undefined });
    expect(unsalted).toBe(legacy);
    expect(legacy).toHaveLength(32);
  });

  it("a salt rotates the token WITHOUT touching SESSION_SECRET", () => {
    const before = deriveWebhookToken({ secret, nodeEnv: "production" });
    const after = deriveWebhookToken({ secret, nodeEnv: "production", salt: "rotation-1" });
    const again = deriveWebhookToken({ secret, nodeEnv: "production", salt: "rotation-2" });
    expect(after).not.toBe(before);
    expect(again).not.toBe(after);
    expect(after).toHaveLength(32);
  });

  it("tokenMatches: equal matches, unequal/empty/length-mismatch do not, nothing throws", () => {
    expect(tokenMatches("abc123", "abc123")).toBe(true);
    expect(tokenMatches("abc123", "abc124")).toBe(false);
    expect(tokenMatches("short", "a-much-longer-token")).toBe(false);
    expect(tokenMatches(null, "abc")).toBe(false);
    expect(tokenMatches("abc", null)).toBe(false);
    expect(tokenMatches(undefined, undefined)).toBe(false);
  });

  it("every token gate compares in constant time - no bare !== is left", () => {
    for (const p of [
      "src/app/api/webhooks/evolution/route.ts",
      "src/app/api/wa/tick/route.ts",
      "src/app/api/wa/reply-tick/route.ts",
      "src/app/api/wa/ping/route.ts",
    ]) {
      const code = readCode(p);
      expect(code, p).toMatch(/tokenMatches\(/);
      expect(code, p).not.toMatch(/!== expected/);
    }
  });

  it("both derivation call sites thread WEBHOOK_TOKEN_SALT through", () => {
    const evo = readCode("src/lib/evolution.ts");
    expect((evo.match(/salt: process\.env\.WEBHOOK_TOKEN_SALT/g) ?? []).length).toBe(2);
    // ...and the salt is documented where bootstrap env lives.
    expect(read(".env.example")).toMatch(/WEBHOOK_TOKEN_SALT=/);
  });

  it("per-instance derivation stays deferred WITH the reason on record", () => {
    expect(read("src/lib/wa/webhook-token.ts")).toMatch(
      /DELIBERATELY STILL FLEET-WIDE[\s\S]*Recorded as deferred/
    );
  });
});

// ---------------------------------------------------------------------------
// The anon-capability probe: tables, not just the one RPC.
// ---------------------------------------------------------------------------

describe("the anon probe enumerates what the browser key can SEE", () => {
  const route = readCode("src/app/api/admin/rpc-exposure/route.ts");

  it("asks PostgREST's root document with the anon key and lists relations", () => {
    expect(route).toMatch(/\/rest\/v1\/`, \{ headers/);
    expect(route).toMatch(/startsWith\("\/rpc\/"\)/); // rpc paths are the other probe's job
    expect(route).toMatch(/state: "clean"/);
    expect(route).toMatch(/exposed: names/);
  });

  it("the combined verdict is worst-of - a clean RPC cannot paint over an exposed table", () => {
    expect(route).toMatch(
      /rpc\.state === "exposed" \|\| tables\.state === "exposed"\s*\n?\s*\? "exposed"/
    );
    expect(route).toMatch(/rpc\.state === "locked" && tables\.state === "clean"/);
  });
});

// ---------------------------------------------------------------------------
// Photo proxy: coarse codes to the anonymous internet, detail to the log.
// ---------------------------------------------------------------------------

describe("the photo proxy stops echoing Google's project-naming errors", () => {
  const route = read("src/app/api/photo/route.ts");

  it("upstream failures map to coarse codes before reaching X-Photo-Error", () => {
    expect(route).toMatch(/coarseUpstreamCode/);
    expect(route).toMatch(/places-api-not-enabled/);
    expect(route).toMatch(/quota-exceeded/);
    expect(route).toMatch(/api-key-refused/);
    // The raw Google message reaches only the server log.
    expect(route).toMatch(/fail\(502, lastError, logDetail\)/);
    expect(route).not.toMatch(/X-Photo-Error": `Google/);
  });
});

// ---------------------------------------------------------------------------
// Admin Data tab: transcripts are the owner's to read, like every ops surface.
// ---------------------------------------------------------------------------

describe("conversation tables in /api/admin/data are owner-only", () => {
  const route = read("src/app/api/admin/data/route.ts");

  it("the four transcript-bearing tables carry the flag", () => {
    for (const t of ["vendor_replies", "bargain_drafts", "whatsapp_messages", "wa_outbox"]) {
      expect(route).toMatch(new RegExp(`name: "${t}"[^\\n]*ownerOnly: true`));
    }
  });

  it("the row path refuses a non-owner admin; counts stay visible", () => {
    expect(route).toMatch(/meta\.ownerOnly && session\.role !== "owner"/);
    expect(route).toMatch(/Conversation content is owner-only/);
    // The listing marks locked tables instead of hiding them.
    expect(route).toMatch(/ownerOnly: Boolean\(t\.ownerOnly\) && session\.role !== "owner"/);
  });
});
