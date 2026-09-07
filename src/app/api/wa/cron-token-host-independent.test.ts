// AUDIT M5 - A VAULT BROWNOUT SILENTLY STOPPED EVERY DRAIN AND SWEEP.
//
// One secret, two derivations. The inbound webhook authenticates with
// `webhookAuthToken()` (env-only, host-independent - the fix for OR11 I2.4,
// documented at src/lib/evolution.ts:531-540). The three cron routes gated on
// `webhookToken()`, which returns null whenever `getHosts()` is empty
// (evolution.ts:522) - and getHosts() is a pure vault read of
// EVOLUTION_HOSTS / EVOLUTION_API_URL+KEY.
//
// So the moment the vault read came back empty - a cold Cloud Run instance
// whose first app_config fetch failed (runtime-config's catch falls back to
// the EMPTY cache on a cold process and negative-caches it), or a
// SESSION_SECRET rotation without SESSION_SECRET_PREVIOUS - /api/wa/ping,
// /api/wa/tick and /api/wa/reply-tick answered 403 to their own schedulers
// while inbound kept authenticating perfectly. Nothing drained, no wakeup
// fired, and the webhook re-arm that would rescue the rotation lives INSIDE
// the 403'd ping.
//
// EXECUTED against the real GET handlers with the vault answering empty:
// runtime-config is mocked so `getConfig` returns undefined (no hosts at all)
// and the runner claim reports "lost", which each route answers with an
// immediate 200 - so what is under test is the auth gate and nothing after it.
// `@/lib/evolution` is deliberately NOT mocked: the token these routes expect
// is the real derivation.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { deriveWebhookToken } from "@/lib/wa/webhook-token";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/runtime-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/runtime-config")>();
  return {
    ...actual,
    // THE BROWNOUT: every vault key reads empty, so getHosts() is [].
    getConfig: async () => undefined,
    // Stand every route down right after the gate, so this test measures the
    // gate and never the fleet-wide work behind it.
    sbInsertClaim: async () => "lost" as const,
    sbSelect: async () => [],
    sbDelete: async () => true,
  };
});

import { GET as pingGet } from "@/app/api/wa/ping/route";
import { GET as tickGet } from "@/app/api/wa/tick/route";
import { GET as replyTickGet } from "@/app/api/wa/reply-tick/route";

const SECRET = "a-strong-secret-of-adequate-length";

const ROUTES: { name: string; path: string; run: (req: Request) => Promise<Response> }[] = [
  { name: "ping", path: "/api/wa/ping", run: (r) => pingGet(r) as Promise<Response> },
  { name: "tick", path: "/api/wa/tick", run: (r) => tickGet(r) as Promise<Response> },
  {
    name: "reply-tick",
    path: "/api/wa/reply-tick?sender=user%40example.com",
    run: (r) => replyTickGet(r) as Promise<Response>,
  },
];

const url = (path: string, token: string) =>
  `https://app.example.test${path}${path.includes("?") ? "&" : "?"}token=${token}`;

const saved = { ...process.env };
beforeEach(() => {
  process.env.SESSION_SECRET = SECRET;
  delete process.env.WEBHOOK_TOKEN_SALT;
  delete process.env.EVOLUTION_HOSTS;
  delete process.env.EVOLUTION_API_URL;
  delete process.env.EVOLUTION_API_KEY;
});
afterEach(() => {
  process.env = { ...saved };
});

describe("the cron gate does not depend on a vault read", () => {
  for (const r of ROUTES) {
    it(`EXECUTED: ${r.name} accepts the real token with an EMPTY vault`, async () => {
      const token = deriveWebhookToken({ secret: SECRET, nodeEnv: process.env.NODE_ENV });
      expect(token).toBeTruthy();
      const res = await r.run(new Request(url(r.path, token!)));
      expect(res.status, `${r.name} 403'd its own scheduler on a vault brownout`).not.toBe(403);
      expect(res.status).toBe(200);
    });

    it(`EXECUTED: ${r.name} still refuses a WRONG token`, async () => {
      const res = await r.run(new Request(url(r.path, "not-the-token")));
      expect(res.status).toBe(403);
    });

    it(`EXECUTED: ${r.name} still fails CLOSED with no derivable secret`, async () => {
      // The fail-closed shape the routes were given on purpose: in production
      // a missing SESSION_SECRET derives no token at all, and a route with no
      // expected token must refuse rather than run open.
      const prevEnv = process.env.NODE_ENV;
      delete process.env.SESSION_SECRET;
      Object.defineProperty(process.env, "NODE_ENV", { value: "production", configurable: true });
      try {
        const res = await r.run(new Request(url(r.path, "anything")));
        expect(res.status).toBe(403);
      } finally {
        Object.defineProperty(process.env, "NODE_ENV", { value: prevEnv, configurable: true });
      }
    });
  }

  it("EXECUTED: the salt is honoured by the cron gate too", async () => {
    // A rotation must move the cron token as well as the webhook token,
    // otherwise the schedulers keep authenticating with a retired one.
    process.env.WEBHOOK_TOKEN_SALT = "r1";
    const salted = deriveWebhookToken({
      secret: SECRET,
      nodeEnv: process.env.NODE_ENV,
      salt: "r1",
    });
    const plain = deriveWebhookToken({ secret: SECRET, nodeEnv: process.env.NODE_ENV });
    expect(salted).not.toBe(plain);
    expect((await pingGet(new Request(url("/api/wa/ping", salted!)))).status).toBe(200);
    expect((await pingGet(new Request(url("/api/wa/ping", plain!)))).status).toBe(403);
  });
});
