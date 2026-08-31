"use client";

import { useEffect, useState } from "react";
import { BrandMark } from "@/components/BrandMark";
import { TermsModal } from "@/components/TermsModal";
import { PlanCard, type PlanView } from "@/components/UpgradeSheet";
import { CountryPhoneInput } from "@/components/CountryPhoneInput";
import { WaConnect } from "@/components/WaConnect";
import { PasswordInput } from "@/components/PasswordInput";
import { LanguageButton } from "@/components/LanguageButton";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LoadingDots } from "@/components/LoadingDots";
import { CURRENCIES, savedCurrency, setSavedCurrency } from "@/lib/currency";
import { startNav } from "@/components/NavVeil";
import { Icon } from "@/components/icons";
import { TrustPanel } from "@/components/landing/TrustPanel";
import { useI18n } from "@/lib/i18n";
import { digitsOnly } from "@/lib/phone";
import { probeWaStatus } from "@/lib/wa-status";
import { fetchJson } from "@/lib/client/fetch-json";
import { AuthMethodList } from "@/components/auth/AuthMethodList";
import { useAuthMethods } from "@/components/auth/useAuthMethods";
import { useAuthHandshake } from "@/components/auth/useAuthHandshake";
import { AuthHandshakeError, type HandshakeRun } from "@/components/auth/handshake";

type Mode = "login" | "signup";

export default function LoginPage() {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [acceptTerms, setAcceptTerms] = useState(false);
  // Two extra mandatory, separately-ticked consents (WhatsApp ban risk + AI
  // responsibility) required to create an account. All three are enforced
  // server-side too.
  const [acceptWaRisk, setAcceptWaRisk] = useState(false);
  const [acceptAiResp, setAcceptAiResp] = useState(false);
  // Progressive disclosure: the plain-English summary of what acceptance
  // covers, expanded only when the user wants the detail.
  const [showHowItWorks, setShowHowItWorks] = useState(false);
  const [googleCredential, setGoogleCredential] = useState<string | null>(null);
  const [googleName, setGoogleName] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [forgotBusy, setForgotBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [verifyFor, setVerifyFor] = useState("");
  const [code, setCode] = useState("");
  const [showTerms, setShowTerms] = useState(false);
  const [step, setStep] = useState<"auth" | "whatsapp" | "plans">("auth");
  // Currency is asked at signup (item #6): auto-detected from the device,
  // one dropdown to correct it. Persisted the moment the account is created.
  const [currencyChoice, setCurrencyChoice] = useState("USD");
  useEffect(() => setCurrencyChoice(savedCurrency()), []);
  const [plans, setPlans] = useState<PlanView[]>([]);
  const [subBusy, setSubBusy] = useState(false);

  // Password-reset redemption: /login?reset=<token> from the emailed link.
  // The token only becomes a password change when THIS form submits it - the
  // request that produced the email changed nothing (see /api/auth/forgot).
  const [resetToken, setResetToken] = useState<string | null>(null);
  const [resetPw, setResetPw] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  const [resetErr, setResetErr] = useState("");
  useEffect(() => {
    try {
      const tok = new URLSearchParams(window.location.search).get("reset");
      if (tok) setResetToken(tok);
    } catch {
      /* no query string - normal login */
    }
  }, []);

  async function submitReset() {
    if (resetPw.length < 6) {
      setResetErr(t("New password needs at least 6 characters."));
      return;
    }
    setResetBusy(true);
    setResetErr("");
    try {
      const res = await fetchJson<any>("/api/auth/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        timeoutMs: 15000,
        body: JSON.stringify({ token: resetToken, next: resetPw }),
      });
      if (res.ok) {
        // The route signed us in - straight into the app.
        startNav();
        window.location.href = "/";
        return;
      }
      setResetErr(
        res.data?.error ?? res.error ?? t("Could not set the new password - try again.")
      );
    } finally {
      setResetBusy(false);
    }
  }

  // WHICH sign-in methods exist is now a server-resolved list, not four
  // disconnected facts. The list is what renders, so the "OR" divider follows
  // from it (see components/auth/AuthMethodList) and this page can no longer
  // paint a separator above a button that will never arrive.
  const probe = useAuthMethods();
  // Provider round trips get their own bounded pending/failed state instead of
  // borrowing the email form's `status`, which never changed when the Google
  // button was pressed.
  const handshake = useAuthHandshake();

  function enterApp(session: any, opts?: { welcome?: boolean; changePw?: boolean }) {
    startNav(); // instant feedback while the next page loads
    if (opts?.changePw) {
      window.location.href = "/profile?pw=1";
      return;
    }
    const base = session?.role && session.role !== "user" ? "/admin" : "/";
    window.location.href = opts?.welcome ? `${base}?welcome=1` : base;
  }

  // `ctl` is present only when this leg is running inside a handshake; it lets
  // the post-auth hop declare itself as `entering` so the provider button keeps
  // its pending state right up to the navigation instead of snapping back to
  // "pressable" while the next page loads.
  async function afterAuth(data: any, isNew: boolean, ctl?: HandshakeRun) {
    // Lock in the (auto-detected or corrected) currency for this traveller.
    if (isNew) setSavedCurrency(currencyChoice);
    if (data.mustChangePassword) {
      ctl?.phase("entering");
      enterApp(data.session, { changePw: true });
      return;
    }
    if (isNew && data.session?.role === "user") {
      // WhatsApp is part of signing up: without it the agents cannot bargain.
      //
      // THE TIMEOUT USED TO MEAN "NO NEED TO LINK". This was a raw fetch with an
      // 8s abort against an endpoint whose own worst case was ~20s (a 4s socket
      // probe plus two 8s outbox drains, all ahead of the response). `wa.ok` was
      // then false, the condition fell through, and a brand-new account was sent
      // straight to plans having never been offered WhatsApp linking - silently,
      // with nothing on screen suggesting a step had been skipped. The one thing
      // signup exists to set up was the thing a slow backend removed.
      //
      // Now: the shared probe, which is bounded, retried, never cached and asks
      // the endpoint to skip the drains (a brand-new account has an empty outbox
      // by definition, so there is nothing to drain anyway).
      //
      // And an unanswered probe is UNKNOWN, not "no". Showing the linking step
      // to somebody already linked costs them one tap on a step they can skip;
      // hiding it from somebody unlinked costs them the product. Only a definite
      // `available === false` (Evolution is not configured at all, which the
      // endpoint answers instantly and never times out on) skips it.
      const wa = await probeWaStatus({ pairing: true, attempts: 2 });
      if (wa.available !== false && !wa.connected) {
        setStep("whatsapp");
        return;
      }
      await goPlans();
      return;
    }
    ctl?.phase("entering");
    enterApp(data.session, { welcome: isNew });
  }

  async function goPlans() {
    const res = await fetchJson<{ plans?: PlanView[] }>("/api/billing/checkout", {
      timeoutMs: 8000,
    });
    const paid = (res.data?.plans ?? []).filter((p: PlanView) => p.amount > 0);
    if (res.ok && paid.length) {
      setPlans(paid);
      setStep("plans");
      return;
    }
    startNav();
    window.location.href = "/?welcome=1";
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // Google-verified signups finish through the Google endpoint - they have
    // no password (Google IS the credential). This was the loop bug.
    if (googleCredential) {
      await runGoogle(googleCredential, true);
      return;
    }
    setStatus("loading");
    setError("");
    const res = await fetchJson<any>("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      timeoutMs: 15000,
      body: JSON.stringify({
        mode,
        email,
        password,
        phone,
        acceptTerms,
        acceptWaRisk,
        acceptAiResp,
      }),
    });
    const data = res.data ?? {};
    if (!res.ok) {
      setStatus("error");
      setError(data.error ?? res.error ?? t("Something went wrong."));
      if (data.needsSignup) setMode("signup");
      return;
    }
    // Email must be verified before the account is created.
    if (data.needsVerification) {
      setVerifyFor(data.email);
      setCode("");
      setStatus("idle");
      setNotice(t("We emailed you a 6-digit code. Enter it below to finish."));
      return;
    }
    await afterAuth(data, mode === "signup");
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    setStatus("loading");
    setError("");
    const res = await fetchJson<any>("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      timeoutMs: 15000,
      body: JSON.stringify({ email: verifyFor, code }),
    });
    const data = res.data ?? {};
    if (!res.ok) {
      setStatus("error");
      setError(data.error ?? res.error ?? t("Wrong code."));
      return;
    }
    setVerifyFor("");
    await afterAuth(data, true);
  }

  /**
   * The Google credential exchange. It reports failure by THROWING
   * AuthHandshakeError rather than by setting page state, because the handshake
   * owns the provider leg's pending/error surface - that is what gives the
   * Google button its own spinner instead of borrowing the email submit
   * button's, which was the "OAuth hangs with no feedback" symptom.
   */
  async function submitGoogle(credential: string, withProfile: boolean, ctl: HandshakeRun) {
    ctl.phase("exchanging");
    const res = await fetchJson<any>("/api/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctl.signal,
      timeoutMs: 15000,
      body: JSON.stringify(
        withProfile
          ? { credential, phone, acceptTerms, acceptWaRisk, acceptAiResp }
          : { credential }
      ),
    });
    const data = res.data ?? {};
    if (data.needsSignup) {
      setGoogleCredential(credential);
      setGoogleName(data.name ?? "");
      setEmail(data.email ?? "");
      setMode("signup");
      setStatus("idle");
      setNotice(
        t("Almost there - add your phone and accept the terms. No password needed: you'll always sign in with Google.")
      );
      return;
    }
    if (!res.ok) {
      throw new AuthHandshakeError(data.error ?? res.error ?? t("Google sign-in failed."));
    }
    await afterAuth(data, Boolean(data.isNew), ctl);
  }

  /** Single entry point for the Google leg, so it can never run twice at once. */
  function runGoogle(credential: string, withProfile = false) {
    setError("");
    setStatus("idle");
    return handshake.run("google", (ctl) => submitGoogle(credential, withProfile, ctl));
  }

  async function forgot() {
    if (!email) {
      setError(t("Type your email above first, then tap Forgot password."));
      setStatus("error");
      return;
    }
    setForgotBusy(true);
    setError("");
    setNotice("");
    try {
      const res = await fetchJson<any>("/api/auth/forgot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        timeoutMs: 15000,
        body: JSON.stringify({ email }),
      });
      const data = res.data ?? {};
      if (!res.ok) {
        setStatus("error");
        setError(data.error ?? res.error ?? t("Could not send the email."));
      } else {
        setStatus("idle");
        setNotice(data.message);
      }
    } finally {
      setForgotBusy(false);
    }
  }

  if (resetToken !== null) {
    return (
      <main className="mx-auto flex min-h-[100dvh] max-w-md flex-col justify-center px-5 pb-safe pt-safe">
        <div className="mb-4 text-center">
          <div className="mx-auto mb-2 w-fit animate-slide-up">
            <BrandMark size={72} />
          </div>
          <h1 className="font-display text-2xl font-extrabold text-strong">
            {t("Choose a new password")} 🔑
          </h1>
          <p className="mx-auto mt-1 max-w-[300px] text-sm text-soft">
            {t("You opened a password reset link. Set the new password for your account here - it signs you in right away.")}
          </p>
        </div>
        <div className="surface rounded-blob p-5">
          <PasswordInput
            value={resetPw}
            onChange={setResetPw}
            placeholder={t("New password (6+ characters)")}
            minLength={6}
            autoComplete="new-password"
          />
          {resetErr && (
            <p className="mt-2 rounded-2xl bg-brandred-soft p-2.5 text-[12px] font-bold text-brandred">
              {resetErr}
            </p>
          )}
          <button
            onClick={submitReset}
            disabled={resetBusy}
            className="btn btn-primary mt-3 w-full rounded-2xl py-3 text-[14px] disabled:opacity-50"
          >
            {resetBusy ? <LoadingDots /> : t("Set new password and sign in")}
          </button>
        </div>
        <button
          onClick={() => {
            setResetToken(null);
            setResetErr("");
          }}
          className="btn mx-auto mt-3 text-[11px] font-bold text-faint underline"
        >
          {t("Back to login")}
        </button>
      </main>
    );
  }

  if (step === "whatsapp") {
    return (
      <main className="mx-auto flex min-h-[100dvh] max-w-md flex-col justify-center px-5 pb-safe pt-safe">
        <div className="mb-4 text-center">
          <div className="mx-auto mb-2 w-fit animate-slide-up">
            <BrandMark size={72} />
          </div>
          <h1 className="font-display text-2xl font-extrabold text-strong">
            {t("Last step: connect WhatsApp")} 💬
          </h1>
          <p className="mx-auto mt-1 max-w-[300px] text-sm text-soft">
            {t("This is how the agents bargain for you - shops answer YOUR number and every reply lands in the app.")}
          </p>
        </div>
        <div className="surface rounded-blob p-5">
          <WaConnect phone={phone} onConnected={() => goPlans()} />
        </div>
        <button
          onClick={() => goPlans()}
          className="btn mx-auto mt-3 text-[11px] font-bold text-faint underline"
        >
          {t("Having trouble? Connect later from Profile")}
        </button>
      </main>
    );
  }

  if (step === "plans") {
    return (
      <main className="mx-auto flex min-h-[100dvh] max-w-md flex-col justify-center px-5 pb-safe pt-safe">
        <div className="mb-4 text-center">
          <h1 className="font-display text-2xl font-extrabold text-strong">
            {t("Welcome aboard!")} 🎉
          </h1>
          <p className="mt-1 text-sm font-bold text-brandred">
            {t("Pro and Ultra are billed every 3 months. Cancel any time.")}
          </p>
        </div>
        <div className="space-y-3">
          {plans.map((p) => (
            <PlanCard
              key={p.id}
              plan={p}
              busy={subBusy}
              onSubscribe={async (id) => {
                setSubBusy(true);
                try {
                  const res = await fetchJson<{ url?: string }>("/api/billing/checkout", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    timeoutMs: 15000,
                    body: JSON.stringify({ planId: id }),
                  });
                  window.location.href = res.data?.url || "/?welcome=1";
                } finally {
                  setSubBusy(false);
                }
              }}
            />
          ))}
        </div>
        <button
          onClick={() => (window.location.href = "/?welcome=1")}
          className="btn btn-ghost mx-auto mt-4 rounded-2xl px-6 py-2.5 text-sm"
        >
          {t("Maybe later - start saving")}
        </button>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-[100dvh] max-w-md flex-col justify-center px-5 pb-safe pt-safe">
      {/* Global translate - flashy so every traveller notices it up front */}
      <div
        className="fixed right-4 z-40"
        style={{ top: "calc(env(safe-area-inset-top, 0px) + 12px)" }}
      >
        <div className="flex items-center gap-1.5">
          <ThemeToggle />
          <LanguageButton flashy />
        </div>
      </div>

      {/* Hero */}
      <div className="mb-5 text-center">
        <div className="mx-auto mb-2 w-fit float-soft">
          <BrandMark size={92} />
        </div>
        <h1 className="font-display text-3xl font-extrabold text-strong">
          Wheel<span className="text-brandblue">Deal</span>
        </h1>
        <p className="mx-auto mt-1 max-w-[280px] text-sm text-soft">
          {t("AI agents hunt the cheapest scooter, motorcycle and car rentals around your hotel - and bargain for you.")}
        </p>
        <div className="mx-auto mt-2 flex w-fit flex-wrap items-center justify-center gap-1.5">
          <span className="badge-flash rounded-full px-3 py-1 text-[11px] font-extrabold">
            🤝 {t("Authentic bargaining")}
          </span>
          <span className="rounded-full bg-brandblue-soft px-3 py-1 text-[11px] font-extrabold text-brandblue">
            🔐 {t("Sign in or create an account to enter")}
          </span>
        </div>
        <a href="/welcome" className="mt-2 inline-block text-[12px] font-bold text-brandblue underline">
          {t("New here? See how WheelDeal works")}
        </a>
      </div>

      {/* Mode switch */}
      <div className="surface-strong mb-3 flex gap-1 rounded-2xl p-1">
        {(["login", "signup"] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => {
              setMode(m);
              setError("");
              setNotice("");
            }}
            className={`btn btn-sm flex-1 rounded-xl py-2.5 text-[13px] font-extrabold ${
              mode === m ? "bg-brandblue text-white" : "text-soft hover:bg-card2"
            }`}
          >
            {m === "login" ? t("Log in") : t("Sign up")}
          </button>
        ))}
      </div>

      {verifyFor ? (
        <form onSubmit={verifyCode} className="surface rounded-blob p-5">
          <div className="mb-1 text-[15px] font-extrabold text-strong">{t("Check your email")}</div>
          <p className="mb-3 text-[12px] text-soft">
            {t("We sent a 6-digit code to")} <span className="font-bold text-strong">{verifyFor}</span>.{" "}
            {t("Enter it to verify this is really your email and finish creating your account.")}
          </p>
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(digitsOnly(e.target.value))}
            placeholder="123456"
            className="w-full rounded-2xl border-2 border-line bg-card p-3 text-center font-mono text-2xl font-extrabold tracking-[0.4em] text-strong focus:border-brandblue focus:outline-none"
          />
          {error && <p className="mt-2 text-[12px] font-bold text-brandred">{error}</p>}
          <button
            type="submit"
            disabled={status === "loading" || code.length < 6}
            className="btn btn-primary mt-3 w-full rounded-2xl py-3 text-[14px] disabled:opacity-50"
          >
            {status === "loading" ? <LoadingDots light /> : t("Verify & create my account")}
          </button>
          <button
            type="button"
            onClick={() => {
              setVerifyFor("");
              setError("");
              setNotice("");
            }}
            className="mt-2 block w-full text-center text-[12px] font-bold text-brandblue underline"
          >
            {t("Use a different email")}
          </button>
        </form>
      ) : (
      <form onSubmit={submit} className="surface rounded-blob p-5">
        {googleCredential ? (
          <div className="mb-3 flex items-center gap-2 rounded-2xl bg-brandblue-soft p-3 text-[13px] font-bold text-brandblue">
            <Icon name="check" className="h-4 w-4" />
            {t("Google verified")}
            {googleName ? `: ${googleName}` : ""} ({email})
          </div>
        ) : (
          <>
            <label className="text-[12px] font-extrabold text-soft">{t("Email")}</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="mt-1 w-full rounded-2xl border-2 border-line bg-card p-3 text-sm text-strong placeholder:text-faint focus:border-brandblue focus:outline-none"
            />
          </>
        )}

        {!googleCredential && (
          <>
            <label className="mt-3 block text-[12px] font-extrabold text-soft">
              {t("Password")}
            </label>
            <div className="mt-1">
              <PasswordInput
                value={password}
                onChange={setPassword}
                required
                minLength={mode === "signup" ? 6 : 1}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                placeholder={
                  mode === "signup"
                    ? t("Choose a password (6+ characters)")
                    : t("Your password")
                }
              />
            </div>
            {mode === "login" && (
              <button
                type="button"
                onClick={forgot}
                disabled={forgotBusy}
                className="btn mt-1 text-[12px] font-extrabold text-brandblue disabled:opacity-60"
              >
                {forgotBusy ? (
                  <LoadingDots label={t("Sending a reset email")} />
                ) : (
                  t("Forgot password?")
                )}
              </button>
            )}
          </>
        )}

        {mode === "signup" && (
          <>
            <label className="mt-3 block text-[12px] font-extrabold text-soft">
              {t("Phone number")}
            </label>
            <div className="mt-1">
              <CountryPhoneInput value={phone} onChange={setPhone} />
            </div>
            <label className="mt-3 block text-[12px] font-extrabold text-soft">
              {t("Your currency")}{" "}
              <span className="font-bold text-faint">
                ({t("auto-detected - fix it if we guessed wrong")})
              </span>
            </label>
            <select
              value={currencyChoice}
              onChange={(e) => {
                setCurrencyChoice(e.target.value);
                setSavedCurrency(e.target.value);
              }}
              className="mt-1 w-full rounded-2xl border-2 border-line bg-card p-3 text-sm font-bold text-strong focus:border-brandblue focus:outline-none"
            >
              {CURRENCIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.flag} {c.code}
                </option>
              ))}
            </select>
            <div className="mt-3 space-y-2">
              {/* ONE clear acceptance. It covers the Terms, the WhatsApp
                  connection method and the AI-assistant acknowledgements in a
                  single clearly-labelled action - the full text is one tap
                  away, and all three durable consent stamps are still
                  recorded server-side (nothing legally changed, only the
                  anxiety). */}
              <label className="flex items-start gap-2.5 text-[12px] leading-relaxed text-soft">
                <input
                  type="checkbox"
                  checked={acceptTerms}
                  onChange={(e) => {
                    setAcceptTerms(e.target.checked);
                    setAcceptWaRisk(e.target.checked);
                    setAcceptAiResp(e.target.checked);
                  }}
                  className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--blue)]"
                  required
                />
                <span>
                  I accept the{" "}
                  <button
                    type="button"
                    onClick={() => setShowTerms(true)}
                    className="font-extrabold text-brandblue underline"
                  >
                    Terms of Use and Privacy Policy
                  </button>
                  , including how the WhatsApp connection and the AI assistant
                  work on my behalf ({t("summary below, full text in the Terms")}
                  ).
                </span>
              </label>
              <button
                type="button"
                onClick={() => setShowHowItWorks((v) => !v)}
                className="flex w-full items-center justify-between rounded-xl bg-card2 px-3 py-2 text-left text-[11px] font-extrabold text-soft"
              >
                <span className="flex items-center gap-1.5">
                  <Icon name="shieldCheck" className="h-3.5 w-3.5 text-brandblue" />
                  {t("The short, honest version")}
                </span>
                <Icon
                  name="chevron"
                  className={`h-3.5 w-3.5 transition-transform ${showHowItWorks ? "rotate-90" : ""}`}
                />
              </button>
              {showHowItWorks && (
                <ul className="space-y-1.5 rounded-xl bg-card2 px-3 py-2.5 text-[11px] leading-relaxed text-soft pop-in">
                  <li>
                    · {t("Messages send from your own WhatsApp at a natural, human pace - many travellers use a spare SIM for peace of mind.")}
                  </li>
                  <li>
                    · {t("Will drafts and sends messages for you. You see every move live, can pause everything or take over any chat - and what's sent from your account is yours.")}
                  </li>
                  <li>
                    · {t("Your chats stay private: we only ever read the rental-shop threads you open through WheelDeal, never your personal conversations.")}
                  </li>
                </ul>
              )}
            </div>
          </>
        )}

        {notice && (
          <p className="mt-2 rounded-xl bg-savings-soft p-2 text-[12px] font-bold text-savings">
            {notice}
          </p>
        )}
        {/* The Google-profile-completion form submits through the handshake, so
            its failure copy has to appear here rather than under a divider that
            is not rendered in that state. */}
        {(status === "error" || (googleCredential && handshake.error)) && (
          <p className="mt-2 text-[12px] font-bold text-brandred">
            {error || handshake.error}
          </p>
        )}

        <button
          type="submit"
          disabled={
            status === "loading" ||
            handshake.busy ||
            // Signup (including Google-profile completion) requires all three
            // mandatory consents. Login never shows them.
            ((mode === "signup" || googleCredential !== null) &&
              !(acceptTerms && acceptWaRisk && acceptAiResp))
          }
          className="btn btn-primary mt-4 w-full rounded-2xl py-3 text-sm disabled:opacity-60"
        >
          {status === "loading" || (googleCredential && handshake.busy) ? (
            <LoadingDots light label={t("One moment")} />
          ) : googleCredential ? (
            t("Create my account")
          ) : mode === "login" ? (
            t("Log in")
          ) : (
            t("Create my account")
          )}
        </button>

        {/* The alternate sign-in methods AND their divider. This page renders
            neither directly: an "OR" above nothing was possible precisely
            because the separator used to be a literal here, disconnected from
            whether any method would ever appear beneath it. */}
        {!googleCredential && (
          <AuthMethodList
            methods={probe.methods}
            state={probe.state}
            probeError={probe.error}
            error={handshake.error}
            busyMethodId={handshake.busy ? handshake.methodId : null}
            disabled={status === "loading" || handshake.busy}
            onCredential={(_id, credential) => {
              void runGoogle(credential);
            }}
            onMethodError={(message) => handshake.fail(message)}
          />
        )}

        <p className="mt-3 flex items-center justify-center gap-1.5 text-[11px] text-faint">
          <Icon name="lock" className="h-3.5 w-3.5" />
          {t("Secure signed session. Your details are stored safely.")}
        </p>
      </form>
      )}

      {/* Trust strip: the three promises, compact */}
      <div className="mt-5 rounded-blob bg-card2 p-3.5">
        <TrustPanel compact />
      </div>

      {/* Private-beta note: this is an invite-only test. */}
      <p className="mt-4 text-center text-[11px] text-faint">
        🔒 {t("Private beta - access is limited to invited testers.")}
      </p>

      {showTerms && <TermsModal onClose={() => setShowTerms(false)} />}
    </main>
  );
}
