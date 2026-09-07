// Transactional email via Resend (free tier). No-op when unconfigured so the
// rest of the flow (AI filtering, storage) still works without an email key.

import "server-only";
import { getConfig } from "./runtime-config";

// NOTHING ON THIS LADDER MAY OUTLIVE THE REQUEST (audit F042).
//
// The first rung is Gmail SMTP, and nodemailer's defaults are 120s to connect
// and 600s of socket inactivity - both longer than Cloud Run's 90s ceiling. A
// server that accepts the TCP connection and then stops answering (Google
// throttling a shared egress address is the ordinary SMTP failure mode) killed
// the traveller's signup or reset request before the CONFIGURED Brevo key was
// ever read, so the "everything degrades gracefully" ladder was inert against
// the one failure it exists for - and on the reset path the compensating clear
// of the live 30-minute token hash was skipped with it.
//
// Two halves, because either alone only relocates the stall: the transport
// gives up on its own socket, and every rung runs under a shared wall clock so
// the NEXT rung is always reached inside the platform ceiling.
const SMTP_CONNECTION_TIMEOUT_MS = 8_000;
const SMTP_GREETING_TIMEOUT_MS = 8_000;
/** Generous on purpose: feedback mail carries base64 attachments. */
const SMTP_SOCKET_TIMEOUT_MS = 25_000;
/** Ceiling for ONE provider attempt. */
const RUNG_BUDGET_MS = 30_000;
/** Ceiling for the whole Gmail -> Brevo -> Resend ladder. */
const LADDER_BUDGET_MS = 60_000;

/** SMTP transport options shared by the live probe and the send path. */
const SMTP_TIMEOUTS = {
  connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
  greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
  socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
} as const;

/**
 * Run one rung under a deadline. A race does NOT cancel the loser - the
 * transport timeouts above are what actually end the abandoned attempt - but it
 * does free the ladder to try the next provider inside the request.
 */
async function withRungBudget<T>(work: Promise<T>, budgetMs: number, onTimeout: T): Promise<T> {
  if (budgetMs <= 0) return onTimeout;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const capped = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout), budgetMs);
  });
  try {
    return await Promise.race([work, capped]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface Attachment {
  filename: string;
  content: string; // base64 (no data: prefix)
}

export interface EmailResult {
  sent: boolean;
  id?: string;
  error?: string;
  reason?: "unconfigured" | "error";
  // Which provider handled (or attempted) the send - surfaced by the live test.
  provider?: "gmail" | "brevo" | "resend";
}

/** Which email providers are configured right now (never leaks the values). */
export async function emailProviderStatus(): Promise<{
  gmail: boolean;
  brevo: boolean;
  resend: boolean;
  anyConfigured: boolean;
  resendSandbox: boolean;
  sender: string | null;
}> {
  const [gmailUser, gmailPass, brevo, resend, from, brevoSender] = await Promise.all([
    getConfig("GMAIL_USER"),
    getConfig("GMAIL_APP_PASSWORD"),
    getConfig("BREVO_API_KEY"),
    getConfig("RESEND_API_KEY"),
    getConfig("FEEDBACK_FROM_EMAIL"),
    getConfig("BREVO_SENDER"),
  ]);
  const gmail = Boolean(gmailUser && gmailPass);
  const sender = from || brevoSender || (gmailUser ? `WheelDeal <${gmailUser}>` : null);
  return {
    gmail,
    brevo: Boolean(brevo),
    resend: Boolean(resend),
    anyConfigured: gmail || Boolean(brevo) || Boolean(resend),
    // Resend's shared sandbox sender only delivers to the account owner until a
    // domain is verified - the #1 "I set the key but got no email" gotcha.
    resendSandbox: Boolean(resend) && (!from || /onboarding@resend\.dev/i.test(from)),
    sender,
  };
}

export interface EmailProbe {
  provider: "gmail" | "brevo" | "resend";
  configured: boolean;
  /**
   * TRUE means a credential was actually exercised against the provider.
   * The health roll-call used to call `emailVerificationAvailable()` - which
   * only asks whether a STRING is present - and print HEALTHY. A revoked
   * Gmail app password, a deleted Brevo key and a perfect setup all rendered
   * identically, on the path that delivers signup codes.
   */
  live: boolean;
  detail: string;
}

/**
 * ONE LIVE CREDENTIAL CHECK PER CONFIGURED EMAIL PROVIDER (Wave 7).
 *
 * Gmail: nodemailer's `verify()` opens the real SMTP session and AUTHs,
 * without sending anything - so a revoked App Password fails here, which is
 * the whole point. Brevo/Resend: an authenticated GET on an account-scoped
 * endpoint. Nothing is sent to anybody, so this is safe to press repeatedly.
 */
export async function emailLiveProbe(): Promise<EmailProbe[]> {
  const [gmailUser, gmailPass, brevo, resend] = await Promise.all([
    getConfig("GMAIL_USER"),
    getConfig("GMAIL_APP_PASSWORD"),
    getConfig("BREVO_API_KEY"),
    getConfig("RESEND_API_KEY"),
  ]);

  const gmailProbe = async (): Promise<EmailProbe> => {
    if (!gmailUser || !gmailPass) {
      return { provider: "gmail", configured: false, live: false, detail: "Not configured." };
    }
    try {
      const nodemailer = (await import("nodemailer")).default;
      const transporter = nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        auth: { user: gmailUser.trim(), pass: gmailPass.replace(/\s+/g, "") },
        // An admin probe must answer too (audit F042): verify() opens a real
        // session, and without these it inherits the same 120s/600s defaults.
        ...SMTP_TIMEOUTS,
      });
      await transporter.verify();
      return {
        provider: "gmail",
        configured: true,
        live: true,
        detail: `SMTP AUTH accepted for ${gmailUser.trim()} (live check, nothing sent).`,
      };
    } catch (e) {
      return {
        provider: "gmail",
        configured: true,
        live: false,
        detail: `SMTP rejected the App Password: ${e instanceof Error ? e.message : "connect failed"}`,
      };
    }
  };

  const brevoProbe = async (): Promise<EmailProbe> => {
    if (!brevo) return { provider: "brevo", configured: false, live: false, detail: "Not configured." };
    try {
      const res = await fetch("https://api.brevo.com/v3/account", {
        headers: { "api-key": brevo.trim(), Accept: "application/json" },
        cache: "no-store",
      });
      const d = (await res.json().catch(() => ({}))) as { email?: string; message?: string };
      return res.ok
        ? { provider: "brevo", configured: true, live: true, detail: `Key accepted (${d.email ?? "account reachable"}).` }
        : { provider: "brevo", configured: true, live: false, detail: d.message ?? `Brevo responded ${res.status}.` };
    } catch (e) {
      return { provider: "brevo", configured: true, live: false, detail: e instanceof Error ? e.message : "network error" };
    }
  };

  const resendProbe = async (): Promise<EmailProbe> => {
    if (!resend) return { provider: "resend", configured: false, live: false, detail: "Not configured." };
    try {
      const res = await fetch("https://api.resend.com/domains", {
        headers: { Authorization: `Bearer ${resend.trim()}` },
        cache: "no-store",
      });
      return res.ok
        ? { provider: "resend", configured: true, live: true, detail: "Key accepted." }
        : { provider: "resend", configured: true, live: false, detail: `Resend responded ${res.status}.` };
    } catch (e) {
      return { provider: "resend", configured: true, live: false, detail: e instanceof Error ? e.message : "network error" };
    }
  };

  return Promise.all([gmailProbe(), brevoProbe(), resendProbe()]);
}

/**
 * The one sentence the health roll-call prints, and whether it was EARNED by a
 * live call. `kind` is the honesty flag: "live" when at least one credential
 * was exercised, "config" when all we know is that a string is present.
 */
export function summariseEmailProbes(probes: EmailProbe[]): {
  status: "ok" | "degraded" | "down" | "off";
  kind: "live" | "config";
  detail: string;
} {
  const configured = probes.filter((p) => p.configured);
  if (configured.length === 0) {
    return {
      status: "off",
      kind: "config",
      detail: "No email key - invited testers sign up WITHOUT a code.",
    };
  }
  const live = configured.filter((p) => p.live);
  const dead = configured.filter((p) => !p.live);
  if (live.length === 0) {
    return {
      status: "down",
      kind: "live",
      detail: `LIVE CHECK FAILED on every configured provider - signup codes will NOT send. ${dead
        .map((p) => `${p.provider}: ${p.detail}`)
        .join(" | ")}`,
    };
  }
  return {
    status: dead.length ? "degraded" : "ok",
    kind: "live",
    detail:
      `LIVE CHECK: ${live.map((p) => p.provider).join(", ")} accepted the credential.` +
      (dead.length ? ` Failing: ${dead.map((p) => `${p.provider} (${p.detail})`).join(" | ")}` : ""),
  };
}

// Brevo (formerly Sendinblue): REST API, 300 free emails/day, single verified
// sender (no domain needed). Sender = BREVO_SENDER (must be a verified email),
// falling back to FEEDBACK_FROM_EMAIL's address.
async function sendViaBrevo(
  apiKey: string,
  opts: { to: string[]; subject: string; html: string }
): Promise<EmailResult> {
  const senderRaw = (await getConfig("BREVO_SENDER")) || (await getConfig("FEEDBACK_FROM_EMAIL")) || "";
  const m = /<([^>]+)>/.exec(senderRaw);
  const senderEmail = (m ? m[1] : senderRaw).trim();
  if (!senderEmail || !senderEmail.includes("@")) {
    return { sent: false, reason: "error", error: "Set BREVO_SENDER to your verified sender email." };
  }
  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": apiKey, "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: { email: senderEmail, name: "WheelDeal" },
        to: opts.to.map((e) => ({ email: e })),
        subject: opts.subject,
        htmlContent: opts.html,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { sent: false, reason: "error", error: data?.message ?? `brevo ${res.status}` };
    return { sent: true, id: data?.messageId };
  } catch (e) {
    return { sent: false, reason: "error", error: e instanceof Error ? e.message : "network error" };
  }
}

// Gmail SMTP with an App Password: 100% free, no custom domain, no IP
// allowlist, ~500 emails/day - the zero-cost default. Setup: Google Account
// -> Security -> 2-Step Verification -> App passwords -> paste GMAIL_USER
// (your Gmail address) + GMAIL_APP_PASSWORD into Admin -> Keys.
async function sendViaGmail(
  user: string,
  appPassword: string,
  opts: { to: string[]; subject: string; html: string; attachments?: Attachment[] }
): Promise<EmailResult> {
  try {
    const nodemailer = (await import("nodemailer")).default;
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user, pass: appPassword.replace(/\s+/g, "") },
      ...SMTP_TIMEOUTS,
    });
    const info = await transporter.sendMail({
      from: `WheelDeal <${user}>`,
      to: opts.to.join(", "),
      subject: opts.subject,
      html: opts.html,
      attachments: opts.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        encoding: "base64" as const,
      })),
    });
    return { sent: true, id: info.messageId };
  } catch (e) {
    return {
      sent: false,
      reason: "error",
      error: e instanceof Error ? e.message : "smtp error",
    };
  }
}

export async function sendEmail(opts: {
  to: string[];
  subject: string;
  html: string;
  attachments?: Attachment[];
}): Promise<EmailResult> {
  // Priority: Gmail SMTP (free, no domain, no IP allowlist, ~500/day) ->
  // Brevo (300/day, single verified sender) -> Resend (needs a domain).
  const [gmailUser, gmailPass] = await Promise.all([
    getConfig("GMAIL_USER"),
    getConfig("GMAIL_APP_PASSWORD"),
  ]);
  // One wall clock for the whole ladder, and a ceiling per rung.
  const ladderDeadlineAt = Date.now() + LADDER_BUDGET_MS;
  const rungMs = () => Math.max(0, Math.min(RUNG_BUDGET_MS, ladderDeadlineAt - Date.now()));
  if (gmailUser && gmailPass) {
    const gmail = await withRungBudget(sendViaGmail(gmailUser, gmailPass, opts), rungMs(), {
      sent: false,
      reason: "error",
      error: "gmail smtp did not answer in time",
    } as EmailResult);
    if (gmail.sent) return { ...gmail, provider: "gmail" };
    // On a hard Gmail failure - or a stall - fall through to the others.
  }

  const brevoKey = await getConfig("BREVO_API_KEY");
  if (brevoKey && !opts.attachments?.length) {
    const brevo = await withRungBudget(sendViaBrevo(brevoKey, opts), rungMs(), {
      sent: false,
      reason: "error",
      error: "brevo did not answer in time",
    } as EmailResult);
    if (brevo.sent || brevo.reason === "error") return { ...brevo, provider: "brevo" };
  }

  const apiKey = await getConfig("RESEND_API_KEY");
  const from =
    (await getConfig("FEEDBACK_FROM_EMAIL")) || "WheelDeal <onboarding@resend.dev>";
  if (!apiKey) return { sent: false, reason: "unconfigured" };

  try {
    // The last rung is bounded too: a bare fetch has no timeout of its own, so
    // an unanswering Resend would simply move the stall to the end of the
    // ladder (audit F042).
    const res = await withRungBudget(
      fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: opts.to,
          subject: opts.subject,
          html: opts.html,
          attachments: opts.attachments,
        }),
      }),
      rungMs(),
      null
    );
    if (!res) {
      return { sent: false, reason: "error", error: "resend did not answer in time", provider: "resend" };
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { sent: false, reason: "error", error: data?.message ?? `resend ${res.status}`, provider: "resend" };
    }
    return { sent: true, id: data?.id, provider: "resend" };
  } catch (e) {
    return {
      sent: false,
      reason: "error",
      error: e instanceof Error ? e.message : "network error",
      provider: "resend",
    };
  }
}
