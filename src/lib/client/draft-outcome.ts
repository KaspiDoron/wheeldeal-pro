"use client";

// WHAT /api/bargain-draft JUST SAID (audit F053).
//
// The composer used to branch on two body keys and nothing else:
//
//   const data = await res.json();
//   if (data.message) { ... } else if (data.upgrade) setUpgradeNote(true);
//
// `res.ok` was never read, so every other answer the route can give - 401 after
// an aged-out session, 400, the safety-screen 500 and the price-integrity 500
// (which fires on any ungrounded numeral, a live rejection path that even
// writes its own event) - set NO state at all. The traveller got the empty
// textarea, "0 chars" and a Send button disabled by !text.trim(), with no
// reason and nothing to retry from.
//
// Three outcomes, one function, so the modal cannot silently grow a fourth.

export type DraftOutcome =
  | { kind: "draft"; message: string }
  | { kind: "upgrade" }
  /** `error` is the server's own user-safe prose, or "" when there was none
   *  (a non-JSON 500, a timeout, a dead connection) - the caller supplies a
   *  translated fallback for that case. */
  | { kind: "error"; error: string };

export function draftOutcome(ok: boolean, body: unknown): DraftOutcome {
  const b = (body ?? {}) as { message?: unknown; upgrade?: unknown; error?: unknown };
  if (ok && typeof b.message === "string" && b.message.trim()) {
    return { kind: "draft", message: b.message };
  }
  // The entitlement answer is an upsell, not a failure - it has its own note.
  if (b.upgrade === true) return { kind: "upgrade" };
  const error = typeof b.error === "string" && b.error.trim() ? b.error.trim() : "";
  return { kind: "error", error };
}
