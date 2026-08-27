import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { deriveWebhookToken } from "./webhook-token";

vi.mock("server-only", () => ({}));

const readCode = (p: string) =>
  readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// OWNER REPORT 11, I2.4 - THE WEBHOOK 403'D ON OUR OWN VAULT OUTAGE.
//
// webhookToken() gated on getHosts(), which reads EVOLUTION_HOSTS from the
// vault. A Supabase wobble made that read empty, webhookToken() returned null,
// and a webhook carrying a PERFECTLY VALID token was answered 403 - a permanent
// reject that made Evolution DROP the shop's reply. The token is derived from
// SESSION_SECRET alone, so authenticity never depended on the host list.

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("webhookAuthToken authenticates without reading the vault", () => {
  it("EXECUTED: returns a token from SESSION_SECRET alone, with NO EVOLUTION_HOSTS set", async () => {
    process.env.SESSION_SECRET = "x".repeat(40);
    delete process.env.EVOLUTION_HOSTS; // the vault-empty case that used to 403
    delete process.env.EVOLUTION_API_URL;
    delete process.env.EVOLUTION_API_KEY;
    const { webhookAuthToken } = await import("../evolution");
    const tok = webhookAuthToken();
    expect(tok).toBeTruthy();
    // It IS exactly what Evolution presents (registration uses the same derive).
    expect(tok).toBe(
      deriveWebhookToken({ secret: process.env.SESSION_SECRET, nodeEnv: process.env.NODE_ENV })
    );
    // It never calls getHosts - proven by it working with zero host config above.
  });
});

describe("both webhook transports authenticate host-independently", () => {
  it("the Next route uses webhookAuthToken, not the host-gated webhookToken", () => {
    const route = readCode("src/app/api/webhooks/evolution/route.ts");
    expect(route).toMatch(/webhookAuthToken\(\)/);
    expect(route).not.toMatch(/const expected = await webhookToken\(\)/);
  });
  it("the GCP gateway uses webhookAuthToken too", () => {
    const gw = readCode("apps/gateway/src/server.ts");
    expect(gw).toMatch(/webhookAuthToken\(\)/);
    expect(gw).not.toMatch(/const expected = await webhookToken\(\)/);
  });
});
