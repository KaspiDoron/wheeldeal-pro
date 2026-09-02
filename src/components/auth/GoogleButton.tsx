"use client";

// Everything Google Identity Services, in one component.
//
// WHY THIS EXISTS
//
// GSI was 55 lines of inline useEffect on the login page, and every one of its
// failure modes was invisible:
//
//  - The effect had `[]` deps but its target div lived inside a ternary. Signing
//    up unmounted the div; "Use a different email" mounted a BRAND NEW empty one;
//    the effect never re-ran, so renderButton was never called again and the user
//    got an empty gap with no message at all. Fixed structurally by keying the
//    render effect on the NODE (a callback ref) rather than on mount, so any
//    remount re-renders the button.
//  - `initialize` was given no `error_callback`, which is GSI's only channel for
//    popup-blocked / popup-closed / FedCM-opted-out. Dismiss the popup and the
//    page state did not change by one bit. Now every one of those maps to copy.
//  - The credential callback was created inside the `[]` effect, so it pinned the
//    FIRST render's handler - which pinned the first render's currencyChoice,
//    still the literal "USD" before the restore effect ran. A Google signup could
//    therefore persist the wrong currency. useCallbackRef fixes that by design.
//  - `width: 320` was a literal. At the 320px viewport CLAUDE.md mandates, the
//    content box is 240px, so the iframe hung 40px off each edge and was clipped.
//    The width is now measured from the container.
//
// The component reports UPWARD when it turns out to be unusable
// (`onUnavailable`) instead of leaving a hole: the parent drops both this button
// AND the divider above it, which is what makes an orphaned "OR" impossible
// rather than merely unlikely.

import { useCallback, useEffect, useState } from "react";
import { Skeleton } from "../Skeleton";
import { OrbitDots } from "../OrbitDots";
import { LoadingDots } from "../LoadingDots";
import { useCallbackRef } from "../useCallbackRef";
import { useI18n } from "../../lib/i18n";
import {
  GSI_BUTTON_SIZE,
  GsiLoadError,
  gsiButtonWidth,
  gsiFailureCopy,
  gsiLocale,
  loadGsi,
} from "../../lib/auth/gsi";

/**
 * GSI paints nothing and logs to the console when this page's origin is missing
 * from the OAuth client's "Authorized JavaScript origins" - the classic
 * new-domain miss. There is no callback for it, so an empty container after the
 * button has had time to paint is the only available signal.
 */
const PAINT_PROBE_MS = 2500;

const ORIGIN_NOT_AUTHORIZED =
  "Google sign-in is not enabled for this domain yet (the site owner must authorize it in Google Cloud Console). Email login below works.";

/** GSI error codes that mean "the user or the browser stopped this attempt". */
function gsiPromptCopy(type: string | undefined): string {
  switch (type) {
    case "popup_closed_by_user":
      return "Sign-in was closed before it finished - tap the Google button to try again.";
    case "popup_failed_to_open":
      return "Your browser blocked the Google pop-up - allow pop-ups for this site, or use email below.";
    case "unknown":
    default:
      return "Google sign-in could not be completed - please try again or use email below.";
  }
}

// ---------------------------------------------------------------------------
// THE GOOGLE MARK. Google's own asset, unmodified.
//
// "You can't change the size or color of the Google G logo. It must be the
// standard color version ... and appear on a white background." So it is never
// tinted, never monochrome, never scaled off its aspect ratio, and it sits on
// the white tile below rather than directly on our dark plate.
//
// No ltr wrapper here on purpose: this is one glyph, so it cannot reverse. The
// ROW around it (mark then label) SHOULD mirror in Hebrew, and letting it do so
// is a correctness win GSI's own button does not have - Google forces
// direction:ltr on its container.
// ---------------------------------------------------------------------------
const GOOGLE_G_PATHS: { fill: string; d: string }[] = [
  {
    fill: "#EA4335",
    d: "M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z",
  },
  {
    fill: "#4285F4",
    d: "M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z",
  },
  {
    fill: "#FBBC05",
    d: "M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z",
  },
  {
    fill: "#34A853",
    d: "M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z",
  },
];

/** 18px is Google's own logo box at `size: "large"`. It is not scaled. */
function GoogleG() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 48 48"
      aria-hidden="true"
      focusable="false"
      className="block shrink-0"
    >
      {GOOGLE_G_PATHS.map((p) => (
        <path key={p.fill} fill={p.fill} d={p.d} />
      ))}
    </svg>
  );
}

export interface GoogleButtonProps {
  clientId: string;
  /** Receives the Google ID token. Wrapped so it can never go stale. */
  onCredential: (credential: string) => void;
  /**
   * Called once when this method turns out to be unusable on this device or
   * deployment. The parent removes the button AND the divider.
   */
  onUnavailable?: (reason: string) => void;
  /** Called for recoverable, user-facing GSI errors (popup closed/blocked). */
  onError?: (message: string) => void;
  /** Another method is mid-handshake - do not accept a second press. */
  disabled?: boolean;
  /** THIS method is mid-handshake - show its own pending state. */
  busy?: boolean;
}

export function GoogleButton({
  clientId,
  onCredential,
  onUnavailable,
  onError,
  disabled = false,
  busy = false,
}: GoogleButtonProps) {
  const { t, lang } = useI18n();
  // Callback ref, NOT useRef: a remount hands us a new node and re-runs the
  // effect below, which is the whole fix for the vanishing-button bug.
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [painted, setPainted] = useState(false);

  // Stable identities, so the effect below never re-subscribes and the GSI
  // callback always reaches the LATEST handler rather than the first render's.
  const emitCredential = useCallbackRef(onCredential);
  const emitUnavailable = useCallbackRef((reason: string) => onUnavailable?.(reason));
  const emitError = useCallbackRef((message: string) => onError?.(message));

  const attach = useCallback((el: HTMLDivElement | null) => setNode(el), []);

  useEffect(() => {
    if (!node || !clientId) return;
    let cancelled = false;
    let probe: ReturnType<typeof setTimeout> | null = null;

    loadGsi(undefined, lang)
      .then((gsi) => {
        if (cancelled) return;
        gsi.accounts.id.initialize({
          client_id: clientId,
          callback: (resp: { credential?: string }) => {
            if (resp?.credential) emitCredential(resp.credential);
          },
          // The channel that did not exist before: without it a blocked or
          // dismissed popup changed nothing on screen.
          error_callback: (err: { type?: string }) => {
            if (!cancelled) emitError(gsiPromptCopy(err?.type));
          },
        });
        const width = gsiButtonWidth(node.clientWidth);
        // A REMOUNT MUST NOT STACK BUTTONS. The effect re-runs when the language
        // changes, and renderButton APPENDS - so without this a traveller who
        // switched languages twice got three Google buttons in a column.
        node.replaceChildren();
        gsi.accounts.id.renderButton(node, {
          theme: "outline",
          // Shared with the plate's drawn height - see gsiDrawnHeightPx.
          size: GSI_BUTTON_SIZE,
          shape: "pill",
          text: "continue_with",
          logo_alignment: "center",
          // The app's language, not the browser's. GSI localises to the device
          // by default, which is why an English app on a Portuguese phone
          // offered "Continuar com o Google" - the one control on the page that
          // ignored the language selector. `hl` on the script URL covers the
          // first load; this covers every change after it.
          locale: gsiLocale(lang),
          ...(width ? { width } : {}),
        });
        // Painting is asynchronous inside GSI, so "did it work" can only be
        // answered a beat later - see PAINT_PROBE_MS.
        probe = setTimeout(() => {
          if (cancelled) return;
          if (node.childElementCount === 0) emitUnavailable(ORIGIN_NOT_AUTHORIZED);
          else setPainted(true);
        }, PAINT_PROBE_MS);
        (probe as unknown as { unref?: () => void }).unref?.();
        // A button that is already in the DOM should not wait for the probe to
        // drop its skeleton.
        if (node.childElementCount > 0) setPainted(true);
      })
      .catch((err) => {
        if (cancelled) return;
        emitUnavailable(
          err instanceof GsiLoadError ? err.message : gsiFailureCopy("script-error")
        );
      });

    return () => {
      cancelled = true;
      if (probe) clearTimeout(probe);
    };
  }, [node, clientId, lang, emitCredential, emitUnavailable, emitError]);

  return (
    // TWO LAYERS, ONE BOX.
    //
    // GSI renders its button inside Google's own iframe (or, on the FedCM path,
    // a div it owns), so it cannot be restyled - which is why the login screen
    // carried a stark white stock pill in a near-black premium UI. The fix is
    // to draw our own plate and leave GOOGLE'S REAL BUTTON on top of it,
    // transparent, still taking every pointer, every focus and the accessible
    // name. Google permits this: a custom button is explicitly allowed, and
    // localising the label is "permitted and encouraged".
    //
    // The one thing that must never happen is the drawn button and the
    // clickable button drifting apart. The plate is drawn at Google's own
    // `size: "large"` height (40px, see gsiDrawnHeightPx) inside a 44px row, so
    // what is painted is a strict SUBSET of what is pressable in BOTH of
    // Google's DOM shapes, and the 44px tap floor is the row.
    <div
      className={`gbtn-shell relative flex w-full min-w-0 justify-center ${
        disabled && !busy ? "pointer-events-none opacity-50" : ""
      }`}
      data-disabled={disabled && !busy ? "" : undefined}
      aria-busy={busy || !painted}
    >
      {/* The plate is aria-hidden, so nothing inside it can be announced. This
          is the only live region, and Google's own element carries the button's
          accessible name. */}
      <span className="sr-only" role="status">
        {busy ? t("Signing you in") : !painted ? t("Loading Google sign-in") : ""}
      </span>

      {/* THE COLUMN. The single box both layers measure themselves against, so
          there is no width written twice: its width is what gsiButtonWidth()
          hands to Google. */}
      <div className="relative w-full min-w-0 max-w-[360px]">
        {/* THE VISIBLE LAYER. Paint only - aria-hidden and pointer-events-none,
            so it can never receive :hover, :active or :focus itself. Every one
            of its states is driven from .gbtn-shell above it.

            h-10 is Google's drawn height; the row is 44px, so the plate is
            centred inside the tap target. rounded-2xl, text-sm and
            font-extrabold are the "Log in" button's own values: this is that
            button with the colour drained out, because it is the secondary way
            in and it should look like a sibling rather than a stranger. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-0 flex items-center"
        >
          <div className="gbtn flex h-10 w-full items-center justify-center gap-3 overflow-hidden rounded-2xl px-3">
            {!painted && !busy && (
              // A SKELETON SAYS "SOMETHING GOES HERE". A SPINNER SAYS "IT IS
              // COMING". Both, on the finished plate: the border, the radius
              // and the lift are already the real control, and only the
              // interior is still resolving - so when GSI paints, nothing
              // moves.
              <>
                <Skeleton className="absolute inset-0" rounded="rounded-2xl" />
                <span className="relative flex items-center gap-2 text-[12px] font-bold text-faint">
                  <OrbitDots
                    size={16}
                    label={t("Loading Google sign-in")}
                    className="opacity-70"
                  />
                  {t("Loading Google sign-in")}
                </span>
              </>
            )}

            {painted && !busy && (
              <>
                {/* THE ONE COLOUR HERE THAT IS NOT A THEME TOKEN, and the only
                    one Google's guidelines actually mandate: the mark "must be
                    the standard color version ... and appear on a white
                    background". White in BOTH themes - never --card, never
                    --card2, both of which are off-white on light and would let
                    the tile disappear. */}
                <span className="gbtn-mark flex h-7 w-7 shrink-0 items-center justify-center rounded-lg">
                  <GoogleG />
                </span>
                {/* OUR text, in OUR language. This is the other half of the
                    Portuguese fix: the label a traveller reads now comes from
                    the same `lang` that drives gsiLocale(lang), so the painted
                    text and the name Google announces agree instead of
                    contradicting each other. "Continue with Google" is one of
                    Google's three approved calls to action.

                    truncate is the 320px backstop: a pathologically long
                    translation shortens, it never pushes the page sideways. */}
                <span className="min-w-0 truncate text-sm font-extrabold leading-tight text-strong">
                  {t("Continue with Google")}
                </span>
              </>
            )}

            {busy && (
              // The plate does not vanish and get replaced by floating dots. It
              // stays where it is and only its contents change, so the
              // handshake reads as this button working rather than as the
              // button leaving.
              <LoadingDots label={t("Signing you in")} />
            )}
          </div>
        </div>

        {/* THE REAL GSI BUTTON. Unchanged in behaviour, transparent in paint.
            opacity-0 ONLY - display:none, visibility:hidden or a zero size
            would all kill the click. childElementCount is unaffected by
            opacity, so the 2500ms unauthorised-origin probe still reads a true
            signal and an unpainted button still disappears entirely (with its
            divider) rather than sitting there looking pressable. */}
        <div
          ref={attach}
          className={`relative z-10 flex min-h-[44px] w-full items-center justify-center overflow-hidden opacity-0 ${
            busy ? "pointer-events-none" : ""
          }`}
        />
      </div>
    </div>
  );
}
