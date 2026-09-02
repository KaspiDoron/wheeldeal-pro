"use client";

// The ONE place in this application that is allowed to render an auth divider.
//
// WHY THIS EXISTS
//
// The "OR" separator used to be a literal in login/page.tsx, gated on a state
// (`!googleCredential`) that had nothing to do with whether anything would ever
// appear beneath it. The button under it needed FOUR independent conditions the
// divider knew nothing about - a resolved client ID, a reachable GSI script, a
// still-mounted container, and this origin being authorized on the OAuth client -
// so on every deployment missing any of them the screen showed a floating OR
// above an empty gap. Adding another `&&` would fix that instance and leave the
// next provider to reproduce it.
//
// The structural fix: a divider is not a thing you place, it is a thing that
// FOLLOWS from a non-empty list of alternates. `alternateMethods()` is the single
// definition of that list (src/lib/auth/methods.ts), the empty case returns
// before the divider JSX is ever reached, and a method that reports itself
// unusable at runtime is removed from the list - which takes the divider with it.
// An orphaned divider is therefore not a bug that is fixed here; it is a state
// this component cannot express.

import { useCallback, useState } from "react";
import { Skeleton } from "../Skeleton";
import { useI18n } from "../../lib/i18n";
import {
  alternateMethods,
  primaryMethod,
  type AuthMethod,
  type AuthMethodId,
} from "../../lib/auth/methods";
import type { AuthMethodsState } from "./useAuthMethods";
import { GoogleButton } from "./GoogleButton";

/**
 * The divider. Local by design - it has no export and no other call site.
 *
 * Re-cut so it and the Google button read as ONE composition rather than as a
 * rule with a widget under it:
 *  - the same max-w-[360px] column as the button, so the line stops where the
 *    button stops (it used to run the full card width and overhang it);
 *  - more space above than below, so proximity says the divider belongs to what
 *    follows it;
 *  - rules that fade toward the card edges instead of butting into them;
 *  - font-extrabold, matching the button's label weight.
 *
 * Deliberately NOT uppercase and NOT letter-spaced: this string is translated,
 * and letter-spacing breaks the joins in Arabic.
 */
function AuthDivider({ label }: { label: string }) {
  return (
    <div
      className="mx-auto mb-2 mt-5 flex w-full max-w-[360px] items-center gap-3.5 text-[11px] font-extrabold text-faint"
      role="separator"
      aria-label={label}
    >
      <span className="wd-or-rule h-px flex-1" />
      {label}
      <span className="wd-or-rule wd-or-rule-end h-px flex-1" />
    </div>
  );
}

export interface AuthMethodListProps {
  methods: AuthMethod[];
  state: AuthMethodsState;
  /** Probe-level error (we could not read the registry at all). */
  probeError?: string;
  /** Handshake-level error for the method currently being used. */
  error?: string | null;
  /** Method id currently mid-handshake, if any. */
  busyMethodId?: string | null;
  /** Something else on the form is busy - alternates must not accept a press. */
  disabled?: boolean;
  onCredential: (methodId: AuthMethodId, credential: string) => void;
  /** A recoverable provider error the user should see (popup blocked/closed). */
  onMethodError?: (message: string) => void;
}

/** Small, honest note. Used for every "no alternates" case - never a divider. */
function UnavailableNote({ text }: { text: string }) {
  return (
    <p className="mt-3 text-center text-[11px] font-bold leading-relaxed text-faint">
      {text}
    </p>
  );
}

export function AuthMethodList({
  methods,
  state,
  probeError,
  error,
  busyMethodId,
  disabled = false,
  onCredential,
  onMethodError,
}: AuthMethodListProps) {
  const { t } = useI18n();
  // Methods that resolved server-side but turned out to be unusable in THIS
  // browser (script blocked, origin not authorized). Removing them here is what
  // makes the divider disappear along with the last button.
  const [unusable, setUnusable] = useState<Partial<Record<AuthMethodId, string>>>({});

  const markUnusable = useCallback((id: AuthMethodId, reason: string) => {
    setUnusable((prev) => (prev[id] ? prev : { ...prev, [id]: reason }));
  }, []);

  if (state === "probing") {
    // A placeholder in the SHAPE of the button, so the card settles instead of
    // growing. Deliberately no divider: promising a separator before we know
    // there is anything to separate is the original bug in miniature.
    return (
      <div
        className="mt-3 flex justify-center"
        role="status"
        aria-label={t("Checking sign-in options")}
      >
        <Skeleton className="h-11 w-full max-w-[360px]" rounded="rounded-full" />
      </div>
    );
  }

  const alts = alternateMethods(methods).filter((m) => !unusable[m.id]);

  if (alts.length === 0) {
    // EVERY no-alternates path lands here, before the divider exists. The note
    // prefers the most specific truth available: why a method dropped out in
    // this browser, then why the registry could not be read, then why the
    // server says the method is off.
    const dropped = Object.values(unusable).find(Boolean);
    const offered = methods.find((m) => m.kind === "oauth" && !m.ready)?.reason;
    const note = dropped || probeError || offered;
    return (
      <>
        {note ? <UnavailableNote text={t(note)} /> : null}
        {error ? (
          <p className="mt-2 text-center text-[12px] font-bold text-brandred">{error}</p>
        ) : null}
      </>
    );
  }

  return (
    <>
      <AuthDivider label={t("OR")} />
      <div className="space-y-2">
        {alts.map((m) => (
          <div key={m.id} className="w-full min-w-0">
            {m.id === "google" && m.config?.clientId ? (
              <GoogleButton
                clientId={m.config.clientId}
                busy={busyMethodId === m.id}
                disabled={disabled && busyMethodId !== m.id}
                onCredential={(credential) => onCredential(m.id, credential)}
                onUnavailable={(reason) => markUnusable(m.id, reason)}
                onError={(message) => onMethodError?.(message)}
              />
            ) : null}
          </div>
        ))}
      </div>
      {/* The primary method is never rendered here - it is the form above - but
          if the server says it is unusable the user has to be told, because the
          alternates below are then the only way in. */}
      {!primaryMethod(methods).ready && primaryMethod(methods).reason ? (
        <UnavailableNote text={t(primaryMethod(methods).reason!)} />
      ) : null}
      {error ? (
        <p className="mt-2 text-center text-[12px] font-bold text-brandred">{error}</p>
      ) : null}
    </>
  );
}
