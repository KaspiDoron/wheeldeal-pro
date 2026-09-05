"use client";

import { useEffect, useRef, useState } from "react";
import { LoadingDots } from "./LoadingDots";
import { Skeleton } from "./Skeleton";
import { Icon } from "./icons";
import { WaTermsModal } from "./WaTermsModal";
import { TrustPanel } from "./landing/TrustPanel";
import { useI18n } from "@/lib/i18n";
import { probeWaStatus } from "@/lib/wa-status";
import { deriveConnectionPhase, isFrozen } from "@/lib/wa/connection-state";
import { readWaCache, writeWaCache } from "@/lib/client/wa-cache";
import { useWillAssistant } from "./will/WillAssistantProvider";
import { WillGuideOverlay } from "./will/WillGuideOverlay";
import { WILL_SLOW_AUTH_MS } from "@/lib/will-assistant";

// Once the shown code lapses the user is most likely still typing it, so we do
// NOT swap it out immediately - we wait this long, and only then quietly ask
// Evolution to re-issue one on the SAME instance (never a teardown).
const LAPSED_GRACE_MS = 20_000;
// Bound on those automatic re-issues, so a broken server can't loop forever.
const MAX_AUTO_REISSUES = 4;
// Overall give-up. Past this we stop polling and say so plainly instead of
// spinning silently, which is what the old unbounded poll did.
const PAIRING_DEADLINE_MS = 4 * 60_000;

// The ONE WhatsApp-connect experience, used identically in signup and in the
// Profile page. Pairing-code first (works on the same phone - no camera or
// gallery needed), QR as the secondary path for a second device.
export function WaConnect({
  phone,
  compact = false,
  onConnected,
}: {
  phone?: string;
  compact?: boolean;
  onConnected?: () => void;
}) {
  const { t } = useI18n();
  const [wa, setWa] = useState<{
    available: boolean;
    connected: boolean;
    reconnecting?: boolean;
    /** Raw Evolution state - previously fetched and then ignored, which is why
     *  the UI had no way to tell "waiting to be scanned" from "verifying". */
    state?: string | null;
  } | null>(null);
  /** Last verdict this device saw, read from localStorage before the probe. */
  const [cached, setCached] = useState<boolean | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [copied, setCopied] = useState(false);
  const [method, setMethod] = useState<"code" | "qr">("code");
  const [showTerms, setShowTerms] = useState(false);
  const [hostDown, setHostDown] = useState(false);
  const [failed, setFailed] = useState(false);
  // Pairing codes really die in ~1 minute (B1). Track expiry + a live countdown.
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const autoReissues = useRef(0);
  const startedAt = useRef<number | null>(null);
  const poll = useRef<ReturnType<typeof setInterval>>();
  /** The server-side mint stamp of the code currently ON SCREEN. Baileys
   *  rotates codes on its own schedule; when the status poll reports a NEWER
   *  stamp than this, the code the user is reading is already dead. */
  const shownIssuedAt = useRef<string | null>(null);

  const showingCode = Boolean(pairingCode || qr);

  // ONE derived truth for the whole screen. Previously the component branched
  // only on `connected`, so a live code, a rotating "Almost there..." line and a
  // "the server never gave us a code" banner could all render at once.
  const phase = deriveConnectionPhase({
    state: wa?.state ?? null,
    paired: wa?.connected === true,
    hasCredential: showingCode,
    credentialMsLeft: secondsLeft === null ? null : secondsLeft * 1000,
    requesting: busy,
    hostDown,
    failed,
  });
  const frozen = isFrozen(phase);

  // Will-as-concierge: while this screen owns the funnel, publish the step so
  // idle detection + guidance work here too (profile AND signup use this
  // component). Once connected, Find Deals takes the narration back.
  const assistant = useWillAssistant();
  const { setStep: assistantSetStep } = assistant;
  useEffect(() => {
    if (wa?.connected) return;
    assistantSetStep(phase === "AUTHENTICATING" ? "WA_AUTHENTICATING" : "WA_LINK_PENDING");
  }, [phase, wa?.connected, assistantSetStep]);

  // Slow-auth reassurance: verification usually lands in a couple of seconds;
  // past WILL_SLOW_AUTH_MS Will steps in so the wait feels held, not stuck.
  const [slowAuth, setSlowAuth] = useState(false);
  useEffect(() => {
    if (phase !== "AUTHENTICATING") {
      setSlowAuth(false);
      return;
    }
    const id = setTimeout(() => setSlowAuth(true), WILL_SLOW_AUTH_MS);
    return () => clearTimeout(id);
  }, [phase]);

  useEffect(() => {
    // LAST KNOWN GOOD, read before the probe even starts.
    //
    // The probe is a network round trip, and until it answers `wa` is null -
    // which fell straight through to the full "connect your WhatsApp" pitch.
    // A traveller whose number has been linked for weeks opened Profile and
    // was told to link it, every single time, for as long as the request took.
    // On a slow connection that is seconds of a screen saying the opposite of
    // the truth. The cached verdict is a HINT, never authority: the probe
    // overwrites it the moment it lands.
    setCached(readWaCache());
    // Shared probe (bounded + retried + never cached) - the same read the
    // Find-deals gate and the Profile pill use, so the three can never
    // disagree about whether this number is linked.
    probeWaStatus().then((s) => {
      if (s.reachable) {
        setWa({
          available: s.available ?? true,
          connected: s.connected,
          reconnecting: s.reconnecting,
          state: s.state,
        });
        writeWaCache(s.connected);
      }
    });
    return () => clearInterval(poll.current);
  }, []);

  // Live countdown on the shown credential. Works for the QR path too - it used
  // to require a pairingCode, so a QR sat on screen forever with no timer and
  // no recovery.
  useEffect(() => {
    if (!expiresAt || !showingCode) {
      setSecondsLeft(null);
      return;
    }
    const id = setInterval(() => {
      setSecondsLeft(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
    }, 500);
    return () => clearInterval(id);
  }, [expiresAt, showingCode]);

  // When the shown code lapses we do NOT yank it away: the user is probably
  // mid-entry and WhatsApp may already be verifying. Wait out a grace period,
  // then quietly ask for a replacement on the SAME instance (fresh=false, so no
  // teardown). This replaced a hard connect(fresh:true) that deleted and
  // recreated the instance every 55s - the destroy-race that broke pairing.
  useEffect(() => {
    if (secondsLeft === null || secondsLeft > 0) return;
    if (wa?.connected || failed) return;
    if (autoReissues.current >= MAX_AUTO_REISSUES) return;
    const id = setTimeout(() => {
      autoReissues.current += 1;
      void connect(false);
    }, LAPSED_GRACE_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secondsLeft, wa?.connected, failed]);

  // Overall deadline - the old poll ran forever with no way to say "this isn't
  // working". Anchored to the first connect attempt, cleared on success.
  useEffect(() => {
    if (!showingCode || wa?.connected || failed) return;
    const id = setInterval(() => {
      if (startedAt.current && Date.now() - startedAt.current > PAIRING_DEADLINE_MS) {
        clearInterval(poll.current);
        setFailed(true);
      }
    }, 2000);
    return () => clearInterval(id);
  }, [showingCode, wa?.connected, failed]);

  async function connect(fresh = false) {
    setBusy(true);
    setErr(null);
    setFailed(false);
    if (startedAt.current === null) startedAt.current = Date.now();
    try {
      const res = await fetch("/api/wa/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, ...(fresh ? { fresh: true } : {}) }),
      });
      const d = await res.json();
      if (!d.available) {
        setErr(d.error ?? t("The WhatsApp connector is not set up yet."));
        return;
      }
      // Honest infra state: the WhatsApp server itself is down/restarting.
      setHostDown(Boolean(d.hostDown));
      if (d.hostDown) {
        setErr(d.error ?? t("Our WhatsApp server is restarting - give it a minute, then tap Try again."));
        return;
      }

      // STALE-STATE KILL: a response that carries no credential must CLEAR the
      // old one. Guarded sets left a dead code on screen next to an error
      // saying no code was issued - the exact contradiction users reported.
      const gotCode = typeof d.pairingCode === "string" && d.pairingCode.length > 0;
      const gotQr = typeof d.qr === "string" && d.qr.length > 0;
      setPairingCode(gotCode ? d.pairingCode : null);
      setQr(gotQr ? d.qr : null);
      if (gotCode || gotQr) {
        const ttl = Number(d.pairingExpiresInMs);
        setExpiresAt(Number.isFinite(ttl) && ttl > 0 ? Date.now() + ttl : null);
        // A credential IS on screen, so any earlier soft error is now history.
        setErr(null);
        // NEW code, new baseline: the next status poll adopts the server's
        // fresh mint stamp. Keeping the old stamp here would make the fresh
        // code read as "rotated" and re-issue in a loop.
        shownIssuedAt.current = null;
      } else {
        setExpiresAt(null);
        setErr(
          d.error ?? t("Could not get a code yet - tap Try again in a few seconds.")
        );
      }

      clearInterval(poll.current);
      poll.current = setInterval(async () => {
        try {
          // pairing=1 skips the outbox/wakeup drains on the server: during
          // pairing there is nothing to drain and they dominated the latency.
          const s = await (
            await fetch(`/api/wa/status?pairing=1&t=${Date.now()}`, { cache: "no-store" })
          ).json();
          setWa(s);
          // SERVER-SIDE ROTATION (owner report 3, first-code-rejected).
          // Baileys re-mints on its own schedule and the QRCODE_UPDATED
          // webhook stamps the new mint time - a newer stamp than the code on
          // screen means the user is reading a DEAD code. Re-issue on the
          // same instance immediately instead of letting them type it and get
          // "Incorrect code". Guarded by the same auto-reissue budget as the
          // countdown path so a flapping webhook cannot loop forever.
          if (
            !s.connected &&
            typeof s.pairingIssuedAt === "string" &&
            shownIssuedAt.current &&
            s.pairingIssuedAt > shownIssuedAt.current &&
            autoReissues.current < MAX_AUTO_REISSUES
          ) {
            autoReissues.current += 1;
            shownIssuedAt.current = s.pairingIssuedAt;
            void connect(false);
            return;
          }
          if (typeof s.pairingIssuedAt === "string" && !shownIssuedAt.current) {
            // First poll after a code was shown: adopt the server's stamp as
            // the baseline for the code on screen.
            shownIssuedAt.current = s.pairingIssuedAt;
          }
          if (s.connected) {
            clearInterval(poll.current);
            setQr(null);
            setPairingCode(null);
            setExpiresAt(null);
            setErr(null);
            setFailed(false);
            startedAt.current = null;
            // Tell Find Deals to celebrate the handoff ("Boom, linked!") the
            // moment the user lands back on the search.
            try {
              sessionStorage.setItem("wd_wa_just_linked", "1");
            } catch {}
            onConnected?.();
          }
        } catch {
          /* a dropped poll is not fatal - the next tick retries */
        }
      }, 2000);
    } catch {
      // Previously absent: a network failure escaped as an unhandled rejection,
      // leaving the button un-busy with no message and no poll installed.
      setErr(t("Could not reach the server - check your connection and tap Try again."));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setErr(null);
    try {
      // Honest (audit F057): the route answers 502 when no host confirmed
      // the teardown - the link is then STILL LIVE, and saying "disconnected"
      // would be the lie the audit found. Only a confirmed sever flips the UI.
      const res = await fetch("/api/wa/disconnect", { method: "POST" });
      if (!res.ok) {
        setErr(t("WhatsApp could not be unlinked right now - the link is still live. Try again in a minute."));
        return;
      }
      setWa((w) => (w ? { ...w, connected: false } : w));
      setQr(null);
      setPairingCode(null);
    } catch {
      setErr(t("Could not reach the server - check your connection and tap Try again."));
    } finally {
      setBusy(false);
    }
  }

  const [resetDone, setResetDone] = useState(false);
  async function resetConversations() {
    if (!window.confirm(t("Clear all imported shop conversations from the app? Your WhatsApp stays connected; new replies re-appear as shops answer."))) {
      return;
    }
    setBusy(true);
    try {
      await fetch("/api/wa/reset-conversations", { method: "POST" });
      setResetDone(true);
    } finally {
      setBusy(false);
    }
  }

  // STILL ASKING. Never assert the negative while we do not know: show the
  // remembered state (dimmed, so it is honest about being a memory) or a
  // shimmer. `compact` renders a single pill, so it gets a single pill.
  if (wa === null) {
    if (cached) {
      return (
        <div className="rounded-2xl bg-savings-soft p-3 opacity-70" aria-busy="true">
          <span className="text-[13px] font-extrabold text-savings">
            ✓ {t("WhatsApp connected - agents bargain as you")}
          </span>
          <p className="mt-1 text-[11px] font-bold text-faint">{t("Checking the link...")}</p>
        </div>
      );
    }
    return (
      <div aria-busy="true">
        <Skeleton className="h-[46px] w-full" rounded="rounded-2xl" />
        {!compact && (
          <>
            <Skeleton className="mt-2 h-[70px] w-full" rounded="rounded-2xl" />
            <Skeleton className="mt-2 h-10 w-full" rounded="rounded-2xl" />
          </>
        )}
      </div>
    );
  }

  if (wa && !wa.available) {
    return (
      <p className="rounded-2xl bg-brandyellow-soft p-3 text-[12px] font-bold text-warn">
        {t("The WhatsApp connector is not set up yet (owner: Admin -> Keys -> Evolution API).")}
      </p>
    );
  }

  if (wa?.connected) {
    return (
      <div className={`rounded-2xl p-3 ${wa.reconnecting ? "bg-brandyellow-soft" : "bg-savings-soft"}`}>
        <div className="flex items-center justify-between">
          <span
            className={`text-[13px] font-extrabold ${
              wa.reconnecting ? "text-warn" : "text-savings"
            }`}
          >
            {wa.reconnecting
              ? `↻ ${t("WhatsApp linked - reconnecting the server...")}`
              : `✓ ${t("WhatsApp connected - agents bargain as you")}`}
          </span>
          <button
            onClick={disconnect}
            disabled={busy}
            className="btn btn-sm chip rounded-xl bg-card px-3 text-[11px] font-bold text-brandred disabled:opacity-60"
          >
            {busy ? <LoadingDots /> : t("Disconnect")}
          </button>
        </div>
        {/* Privacy tool: wipe any imported shop conversations (e.g. to clear
            historically mis-filed messages). Scoped strictly to this account. */}
        <div className="mt-2 border-t border-line/40 pt-2 text-center">
          {resetDone ? (
            <span className="text-[11px] font-bold text-savings">
              ✓ {t("Cleared - conversations re-appear as shops reply.")}
            </span>
          ) : (
            <button
              onClick={resetConversations}
              disabled={busy}
              className="text-[11px] font-bold text-faint underline hover:text-brandred disabled:opacity-60"
            >
              {t("Clear imported conversations")}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      {!showingCode && (
        <>
          {!compact && (
            <>
              {/* Trust header: pro WhatsApp-AI mark + calming pitch */}
              <div className="mb-2 flex items-center gap-2.5 rounded-2xl bg-card2 p-2.5">
                <span className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[#25D366] text-white shadow-md">
                  <Icon name="whatsapp" className="h-6 w-6" />
                  <span className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-brandblue text-white shadow">
                    <Icon name="sparkles" className="h-3 w-3" />
                  </span>
                </span>
                <div className="text-[12px] leading-snug text-soft">
                  <div className="font-extrabold text-strong">
                    {t("Your WhatsApp, your agent")}
                  </div>
                  {t("Agents message shops as YOU, so bargains are authentic - replies land back here automatically.")}
                </div>
              </div>
              {/* The four promises that make people comfortable linking */}
              <ul className="mb-2 space-y-1 rounded-2xl bg-savings-soft p-2.5 text-[11px] font-bold text-savings">
                {/* Three of these four described things the code does not do.
                    "Goes back to sleep - no activity, nothing sent" while
                    pauseIdleSessions only sets presence unavailable and the
                    socket stays open with keepalives running; "built to keep
                    your number safe" as an outcome promise; and "every trace of
                    the link is erased" while whatsapp_messages rows survive a
                    disconnect - proven by the separate "Clear imported
                    conversations" button thirty lines above this one. */}
                <li>🔒 {t("Private: we only ever see chats with shops the app messaged - never friends or family.")}</li>
                <li>😴 {t("Quiet: while you are away your agent stops sending - nothing new goes out until you are back.")}</li>
                <li>🛡 {t("Careful: human-pace sending, daily send caps, and one introduction per shop. Safeguards, not a guarantee - WhatsApp decides what happens to your number.")}</li>
                <li>✌️ {t("Yours: disconnect any time with one tap, and you can clear your stored shop conversations in the same place.")}</li>
              </ul>
              {/* The full protection story - same panel as the landing page,
                  incl. the expandable list of real anti-ban mechanics. */}
              <div className="mb-2 rounded-2xl bg-card2 p-2.5">
                <TrustPanel frame={false} />
              </div>
            </>
          )}
          <label
            dir="ltr"
            data-will="wa-consent"
            className="mb-2 flex items-start gap-2 rounded-2xl bg-card2 p-2.5 text-left text-[12px] leading-relaxed text-soft"
          >
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--blue)]"
            />
            <span>
              {t("I have read and accept the")}{" "}
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  setShowTerms(true);
                }}
                className="font-extrabold text-brandblue underline"
              >
                {t("WhatsApp Linking Terms")}
              </button>
              {/* THE SINGLE MOST IMPORTANT STRING IN THE APP.
                  The only plain statement of account-loss risk lived in clause
                  3 of the terms modal, behind a link - and this line, presented
                  as "the short version" of that document, summarised away its
                  one material term. A summary that omits the sole material risk
                  is worse than no summary.
                  This is also the one surface where naming the risk plainly is
                  REQUIRED rather than avoided: everywhere else the app talks
                  about pacing in quality-control terms, but consent has to be
                  informed to be consent. */}
              <span className="mt-0.5 block text-[11px] text-faint">
                {t(
                  "The short version: you are linking your own WhatsApp, this uses an unofficial connection, and WhatsApp can restrict or ban a number for it. Our pacing and safety limits lower that risk - they cannot remove it. Disconnect any time. Use a number you could manage without."
                )}
              </span>
            </span>
          </label>
          {showTerms && <WaTermsModal onClose={() => setShowTerms(false)} />}
          <div className="mb-2 flex items-start gap-2 rounded-2xl bg-brandblue-soft p-2.5 text-[11px] font-bold text-brandblue">
            <span className="text-[14px]">⏱</span>
            <span>
              {t("About 30 seconds. Keep this screen open - you enter one code and I do the rest.")}
            </span>
          </div>
          <button
            data-will="wa-connect-cta"
            onClick={() => void connect()}
            disabled={busy || !consent}
            className="btn w-full rounded-2xl bg-wagreen-deep py-3 text-[14px] font-extrabold text-white shadow-md hover:opacity-90 disabled:opacity-50"
          >
            {busy ? <LoadingDots light label={t("Getting your code ready")} /> : `💬 ${t("Connect my WhatsApp")}`}
          </button>
        </>
      )}

      {showingCode && (
        <div data-will="wa-pair" className="rounded-2xl bg-card2 p-3">
          {/* Method switch */}
          <div className="mb-2 flex gap-1.5">
            <button
              onClick={() => setMethod("code")}
              className={`btn btn-sm chip flex-1 rounded-xl border-2 py-1.5 text-[11px] font-extrabold ${
                method === "code" ? "border-brandblue bg-brandblue-soft text-brandblue" : "border-line text-soft"
              }`}
            >
              🔢 {t("Code (same phone)")}
            </button>
            <button
              onClick={() => setMethod("qr")}
              className={`btn btn-sm chip flex-1 rounded-xl border-2 py-1.5 text-[11px] font-extrabold ${
                method === "qr" ? "border-brandblue bg-brandblue-soft text-brandblue" : "border-line text-soft"
              }`}
            >
              📷 {t("QR (second device)")}
            </button>
          </div>

          {method === "code" && (
            <>
              {pairingCode ? (
                <button
                  onClick={() => {
                    navigator.clipboard?.writeText(pairingCode.replace(/-/g, ""));
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                  className="btn mx-auto block rounded-2xl bg-card px-6 py-3 text-center"
                >
                  <span className="font-mono text-2xl font-extrabold tracking-[0.3em] text-strong">
                    {pairingCode}
                  </span>
                  <span className="block text-[10px] font-bold text-brandblue">
                    {copied ? `✓ ${t("Copied")}` : t("Tap to copy")}
                  </span>
                </button>
              ) : null}
              {pairingCode && secondsLeft !== null && secondsLeft > 0 && (
                <p className="mt-1.5 text-center text-[11px] font-bold text-soft">
                  {secondsLeft > 10 ? "⏳" : "⚠️"}{" "}
                  {t("Enter it within")} <span className="font-mono text-brandblue">{secondsLeft}s</span>
                </p>
              )}
              {pairingCode && secondsLeft === 0 && (
                <p className="mt-1.5 text-center text-[11px] font-bold text-soft">
                  {t("If you already typed this code, just wait - we are checking with WhatsApp.")}
                </p>
              )}
              {!pairingCode && (
                <p className="rounded-xl bg-brandyellow-soft p-2 text-center text-[11px] font-bold text-warn">
                  {hostDown ? "🔧 " : ""}
                  {err ||
                    t("Preparing your code... tap Try again in a few seconds. If it keeps failing, use the QR tab from a computer.")}
                </p>
              )}
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-[11px] font-bold text-soft">
                <li>
                  <a href="whatsapp://" className="text-brandblue underline">
                    {t("Open WhatsApp")}
                  </a>{" "}
                  {t("on this phone.")}
                </li>
                <li>
                  🍏 {t("iPhone: Settings tab (bottom right) -> Linked Devices.")}{" "}
                  🤖 {t("Android: 3 dots (top right) -> Linked devices.")}
                </li>
                <li>{t("Tap Link a Device, then 'Link with phone number instead'.")}</li>
                <li>{t("Type the code above - done! This screen turns green by itself.")}</li>
              </ol>
            </>
          )}

          {method === "qr" &&
            (qr ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={qr} alt="WhatsApp QR" className="mx-auto h-40 w-40 rounded-xl bg-white p-2" />
                <p className="mt-1.5 text-center text-[11px] font-bold text-soft">
                  {t("Open this page on your computer or a second phone, then scan with WhatsApp -> Linked Devices -> Link a Device.")}
                </p>
              </>
            ) : (
              <p className="text-center text-[11px] font-bold text-faint">{t("QR not available - use the code method.")}</p>
            ))}

          {/* ONE status line, driven by the real phase. This used to be a 4s
              rotation through four hardcoded reassurances that ran regardless of
              what was actually happening - it cheerfully said "Almost there"
              while the screen was showing an error. */}
          {phase === "FAILED" ? (
            <div className="mt-2 rounded-xl bg-brandyellow-soft p-2.5 text-[11px] font-bold text-warn">
              {hostDown
                ? t("Our WhatsApp server is restarting - nothing is wrong on your side. Give it a minute, then tap Try again.")
                : t("This is taking longer than it should. Tap Try again for a fresh code, or use the QR tab from a computer.")}
            </div>
          ) : (
            <div className="mt-2 rounded-xl bg-brandblue-soft p-2.5">
              <div className="flex items-center gap-2 text-[11px] font-bold text-brandblue">
                {!frozen && <LoadingDots />}
                <span>
                  {phase === "AUTHENTICATING"
                    ? t("Verifying with WhatsApp - keep this screen open.")
                    : phase === "GENERATING_QR"
                      ? t("Asking WhatsApp for your code...")
                      : t("Enter the code in WhatsApp - this screen turns green by itself.")}
                </span>
              </div>
              {phase === "AUTHENTICATING" && (
                <p className="mt-1 text-[10px] font-bold text-brandblue/80">
                  {t("Do not close or refresh - we are not sending a new code while this finishes.")}
                </p>
              )}
            </div>
          )}
          <div className="mt-2 flex items-center justify-end">
            <button
              onClick={() => {
                autoReissues.current = 0;
                startedAt.current = Date.now();
                // A still-valid on-screen code is only re-polled; a dead or
                // missing one earns a genuinely fresh instance. Either way the
                // server never wipes a handshake that is mid-verification.
                const codeStillLive = Boolean(showingCode && secondsLeft !== null && secondsLeft > 0);
                void connect(!codeStillLive);
              }}
              disabled={busy || frozen}
              title={frozen ? t("WhatsApp is verifying - please wait") : undefined}
              className="btn btn-sm chip rounded-xl bg-card px-3 text-[11px] font-bold text-brandblue disabled:opacity-60"
            >
              {busy ? <LoadingDots /> : `↻ ${t("Try again / new code")}`}
            </button>
          </div>
        </div>
      )}

      {/* The error lives in exactly ONE place. It previously ALSO rendered here
          unconditionally, which is how a valid code and "the server didn't hand
          out a code" ended up on screen together. */}
      {err && !showingCode && (
        <p className="mt-2 rounded-xl bg-brandyellow-soft p-2 text-[11px] font-bold text-warn">
          {hostDown ? "🔧 " : ""}
          {err}
        </p>
      )}

      {/* Will steps in when the user hesitates on the pitch for 8s - pointing
          at the exact button, with a 1-tap action that starts the link (or, if
          the terms aren't ticked yet, walks them to the checkbox first). */}
      {!wa?.connected && !showingCode && !busy && !err && assistant.idle && (
        <WillGuideOverlay
          anchor="[data-will='wa-connect-cta']"
          text={
            consent
              ? t("Tap here and I'll set up your private link - about 30 seconds, one code.")
              : t("Tick the terms box and I'll handle the rest - about 30 seconds, one code.")
          }
          actions={[
            {
              label: consent ? t("Start the link") : t("Show me the box"),
              primary: true,
              onAction: () => {
                if (consent) {
                  void connect();
                } else {
                  document
                    .querySelector("[data-will='wa-consent']")
                    ?.scrollIntoView({ behavior: "smooth", block: "center" });
                }
              },
            },
          ]}
        />
      )}

      {/* Verification running longer than usual: hold the user's hand instead
          of letting the wait feel stuck. No actions on purpose - the only right
          move is to wait, and Will says so. */}
      {phase === "AUTHENTICATING" && slowAuth && (
        <WillGuideOverlay
          anchor="[data-will='wa-pair']"
          text={t("I'm setting up your private agent link now. A few more seconds and you're in.")}
        />
      )}
    </div>
  );
}
