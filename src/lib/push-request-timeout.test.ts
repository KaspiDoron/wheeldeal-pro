// AUDIT F040 (the push half) - every web-push request carries a timeout.
//
// web-push builds a bare https.request, and Node gives that no timeout at all,
// so a push endpoint that completes its TLS handshake and then never answers
// leaves the promise pending forever. Callers cannot fix that with a budget
// alone: sendPushToUser fans out to up to 20 devices in parallel, so one dead
// subscription would consume the whole after-work allowance the other
// nineteen need. This test EXECUTES sendPushToUser against a stubbed web-push
// and asserts the per-request timeout is actually handed down.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const sendArgs: unknown[][] = [];

vi.mock("web-push", () => ({
  default: {
    setVapidDetails: () => {},
    sendNotification: async (...args: unknown[]) => {
      sendArgs.push(args);
      return { statusCode: 201 };
    },
  },
}));

vi.mock("./runtime-config", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getConfig: async (k: string) =>
    k === "VAPID_PUBLIC_KEY" ? "test-public-key" : k === "VAPID_PRIVATE_KEY" ? "test-private-key" : undefined,
  setConfig: async () => true,
  sbSelect: async (table: string) =>
    table === "push_subscriptions"
      ? [{ endpoint: "https://push.example/endpoint-1", p256dh: "p256dh-1", auth: "auth-1" }]
      : [],
  sbSelectStrict: async () => ({ rows: [] as unknown[] }),
  sbInsert: async () => true,
  sbDelete: async () => true,
  vaultReadState: async () => ({ ok: true }),
}));

import { sendPushToUser } from "./push";

beforeEach(() => {
  sendArgs.length = 0;
});

describe("web-push requests are bounded", () => {
  it("passes a numeric timeout to sendNotification", async () => {
    const out = await sendPushToUser("traveller@example.com", {
      title: "You've got the wheel",
      body: "handover",
      url: "/",
    });
    expect(out.attempted).toBe(1);
    expect(sendArgs.length).toBe(1);
    const opts = sendArgs[0][2] as { timeout?: number } | undefined;
    expect(opts, "web-push must be given request options, not just a payload").toBeTruthy();
    expect(typeof opts?.timeout, "a push request with no timeout can hang forever").toBe("number");
    expect(opts!.timeout).toBeGreaterThan(0);
    // Short enough that one dead endpoint cannot eat the caller's whole
    // after-work budget (lib/after.ts AFTER_BUDGET_MS = 8s).
    expect(opts!.timeout).toBeLessThan(8_000);
  });
});
