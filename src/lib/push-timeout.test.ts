// AUDIT F039 (second half) - the web-push call had no timeout.
//
// web-push only sets an https request timeout when a `timeout` option is
// passed; sendPushToUser called sendNotification(subscription, payload) with no
// options object at all, so a push endpoint that accepts the connection and
// then goes quiet held the request open with nothing to cut it. That is what
// makes the awaited version of the lost-best push (F039's first half) safe to
// await: the budget abandons the work, but only a real timeout stops one dead
// endpoint from eating the whole budget for the devices behind it.
//
// EXECUTED against the real sendPushToUser with the transport mocked.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const sendNotification = vi.fn(async (..._args: unknown[]) => ({ statusCode: 201 }));
vi.mock("web-push", () => ({
  default: {
    setVapidDetails: () => {},
    sendNotification: (...args: unknown[]) =>
      (sendNotification as unknown as (...a: unknown[]) => unknown)(...args),
  },
}));

const store = new Map<string, string>([
  ["VAPID_PUBLIC_KEY", "test-public-key"],
  ["VAPID_PRIVATE_KEY", "test-private-key"],
  ["ADMIN_EMAILS", "owner@x.com"],
]);

vi.mock("./runtime-config", () => ({
  getConfig: async (k: string) => store.get(k),
  setConfig: async () => {},
  sbInsert: async () => true,
  sbSelect: async (table: string) =>
    table === "push_subscriptions"
      ? [{ endpoint: "https://push.example/ep1", p256dh: "p", auth: "a" }]
      : [],
  sbSelectStrict: async () => [],
  sbDelete: async () => {},
  vaultReadState: async () => ({ ok: true }),
}));
vi.mock("./site", () => ({ resolveSiteHost: async () => "example.test" }));

describe("F039 - every web push carries a request timeout", () => {
  beforeEach(() => sendNotification.mockClear());

  it("sendNotification is called with a bounded timeout option", async () => {
    const { sendPushToUser } = await import("./push");
    const out = await sendPushToUser("u@x.com", { title: "T", body: "B" });
    expect(out.attempted).toBe(1);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    const opts = sendNotification.mock.calls[0][2] as { timeout?: number } | undefined;
    expect(opts, "no options object means no timeout").toBeTruthy();
    expect(typeof opts!.timeout).toBe("number");
    expect(opts!.timeout).toBeGreaterThan(0);
    // Small enough to sit inside the reply path's own after-work budget.
    expect(opts!.timeout).toBeLessThanOrEqual(5_000);
  });
});
