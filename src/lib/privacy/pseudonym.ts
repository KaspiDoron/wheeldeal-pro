import { createHash } from "node:crypto";

// A PSEUDONYM FOR AN ACCOUNT THAT CARRIES NO ADDRESS.
//
// The same shape evolution.ts's instanceNameFor already uses for the WhatsApp
// instance name - `wd-` plus the first 16 hex chars of sha256(lowercased
// email) - so a pseudonymous key stays traceable for the owner across the
// surfaces that already show the instance, while nothing in it can be turned
// back into the person. Pure: node crypto only, no store, so the erasure
// registry can build a filter from it without a server context.

export function pseudonymForEmail(email: string): string {
  return `wd-${createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 16)}`;
}

/** Whether a key half already IS a pseudonym (re-stamping must be idempotent). */
export function isPseudonym(value: string): boolean {
  return /^wd-[0-9a-f]{16}$/.test(value);
}
