// AUDIT F042 - a stalled Gmail SMTP session must not swallow the fallback
// ladder.
//
// sendEmail tries Gmail first, and nodemailer's defaults are 120s to connect
// and 600s of socket inactivity - both longer than Cloud Run's 90s request
// ceiling. smtp.gmail.com accepting the TCP connection and then going quiet
// (Google throttling a shared egress address: the ordinary SMTP failure mode)
// therefore killed the traveller's signup or password-reset request before the
// configured Brevo rung was ever reached, and on the reset path it also
// skipped the compensating clear of the live 30-minute reset token.
//
// These tests EXECUTE sendEmail with a Gmail transport that never answers.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

const cfg: Record<string, string | undefined> = {};
vi.mock("./runtime-config", () => ({
  getConfig: async (k: string) => cfg[k],
}));

const transports: Array<Record<string, unknown>> = [];
let sendMailBehaviour: "stall" | "ok" = "stall";

vi.mock("nodemailer", () => ({
  default: {
    createTransport: (opts: Record<string, unknown>) => {
      transports.push(opts);
      return {
        sendMail: async () =>
          sendMailBehaviour === "ok"
            ? { messageId: "gmail-1" }
            : // The stall: the session is open and simply never answers.
              new Promise(() => {}),
        verify: async () => true,
      };
    },
  },
}));

import { sendEmail } from "./email";

beforeEach(async () => {
  for (const k of Object.keys(cfg)) delete cfg[k];
  transports.length = 0;
  sendMailBehaviour = "stall";
  // Warm the dynamic import BEFORE the clock is faked: fake timers cannot
  // drive module resolution, only the ladder's own budget timers.
  await import("nodemailer");
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the email ladder outlives a stalled SMTP session", () => {
  it("reaches Brevo when Gmail never answers", async () => {
    cfg.GMAIL_USER = "owner@gmail.com";
    cfg.GMAIL_APP_PASSWORD = "test-app-password";
    cfg.BREVO_API_KEY = "test-brevo-key";
    cfg.BREVO_SENDER = "sender@shop.com";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ messageId: "brevo-123" }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    let result: Awaited<ReturnType<typeof sendEmail>> | null = null;
    const p = sendEmail({ to: ["traveller@example.com"], subject: "s", html: "h" }).then((r) => {
      result = r;
      return r;
    });
    // Well past any single rung's budget and still inside a Cloud Run request.
    await vi.advanceTimersByTimeAsync(80_000);
    await Promise.resolve();
    expect(result, "sendEmail must not wait on a hung SMTP socket").not.toBeNull();
    expect(result!.provider, "the Brevo rung must be reachable").toBe("brevo");
    expect(result!.sent).toBe(true);
    await p;
  });

  it("gives the SMTP transport its own connect / greeting / socket timeouts", async () => {
    cfg.GMAIL_USER = "owner@gmail.com";
    cfg.GMAIL_APP_PASSWORD = "test-app-password";
    sendMailBehaviour = "ok";
    const p = sendEmail({ to: ["traveller@example.com"], subject: "s", html: "h" });
    await vi.advanceTimersByTimeAsync(1_000);
    const r = await p;
    expect(r.provider).toBe("gmail");
    expect(transports.length).toBeGreaterThanOrEqual(1);
    const t = transports[transports.length - 1];
    // A budget alone would only relocate the stall: the socket stays open and
    // the process keeps paying for it. The transport has to give up too.
    for (const k of ["connectionTimeout", "greetingTimeout", "socketTimeout"]) {
      expect(typeof t[k], `nodemailer needs an explicit ${k}`).toBe("number");
      expect(t[k] as number).toBeGreaterThan(0);
    }
    // Generous enough for the attachment path (feedback mail carries base64
    // attachments) but far under Cloud Run's 90s ceiling.
    expect(t.socketTimeout as number).toBeLessThan(60_000);
  });
});
