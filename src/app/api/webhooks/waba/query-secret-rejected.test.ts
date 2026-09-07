// AUDIT M2: the WABA webhook accepted its shared secret as a `?secret=` QUERY
// PARAMETER - the exact access-log leak class this same file's GET comment
// records as "a real leak".
//
// WABA_WEBHOOK_SECRET is not just a shared password: for a Meta-direct WABA it
// IS the X-Hub-Signature-256 signing key this route verifies with. An operator
// who pasted `https://<app>/api/webhooks/waba?secret=<value>` into a provider's
// callback form - and nothing told them not to, because the route accepted it -
// wrote that key into every access log in the path: Cloud Run's, the load
// balancer's, any sink. Anyone with log-read access could then forge signed
// deliveries that advance leads and open service windows.
//
// Nothing in the repo ever emitted `?secret=`, so the arm had no consumer and
// is gone. The header arm stays, and is compared in constant time.
//
// EXECUTED against the real POST.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "crypto";

vi.mock("server-only", () => ({}));

const rec = vi.hoisted(() => ({ flushes: [] as string[] }));

vi.mock("@/lib/runtime-config", async () => {
  const h = await import("@/lib/privacy/postgrest-store.test-helper");
  return h.runtimeConfigMock();
});
vi.mock("@/lib/waba/dispatch", () => ({
  onAgencyReplied: async (from: string) => {
    rec.flushes.push(from);
    return { opened: true, flushed: 1 };
  },
}));

import { store } from "@/lib/privacy/postgrest-store.test-helper";
import { POST } from "@/app/api/webhooks/waba/route";

const SECRET = "test-secret";
const AGENCY = "66812345678";

const body = (id: string) =>
  JSON.stringify({
    entry: [
      {
        changes: [
          { value: { messages: [{ id, from: AGENCY, type: "text", text: { body: "hello" } }] } },
        ],
      },
    ],
  });

const post = (url: string, headers: Record<string, string>, raw: string) =>
  POST(new Request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: raw }));

beforeEach(() => {
  store.reset();
  rec.flushes.length = 0;
  store.config.set("WABA_ENABLED", "on");
  store.config.set("WABA_WEBHOOK_SECRET", SECRET);
});

describe("EXECUTED (M2): the shared secret is never accepted from the URL", () => {
  it("a ?secret= query parameter is refused, and nothing is acted on", async () => {
    const res = await post(
      `http://localhost/api/webhooks/waba?secret=${encodeURIComponent(SECRET)}`,
      {},
      body("wamid.Q1")
    );
    expect(res.status, "a URL-borne secret is a logged secret").toBe(403);
    expect(rec.flushes).toHaveLength(0);
  });

  it("the header arm still works - that is where a reseller secret belongs", async () => {
    const res = await post(
      "http://localhost/api/webhooks/waba",
      { "x-waba-secret": SECRET },
      body("wamid.H1")
    );
    expect(res.status).toBe(200);
    expect(rec.flushes).toHaveLength(1);
  });

  it("a Meta signature still works", async () => {
    const raw = body("wamid.S1");
    const sig = "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex");
    const res = await post("http://localhost/api/webhooks/waba", { "x-hub-signature-256": sig }, raw);
    expect(res.status).toBe(200);
    expect(rec.flushes).toHaveLength(1);
  });

  it("a wrong header value is still refused", async () => {
    const res = await post(
      "http://localhost/api/webhooks/waba",
      { "x-waba-secret": "not-the-secret" },
      body("wamid.W1")
    );
    expect(res.status).toBe(403);
    expect(rec.flushes).toHaveLength(0);
  });
});
