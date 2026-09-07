// THE canonical WhatsApp routing key + tolerant thread matching.
//
// Two independent formats reach us for the same shop:
//   - WhatsApp/Evolution deliver a JID user-part: "639661952196", and on
//     multi-device "639661952196:12@s.whatsapp.net" (a DEVICE suffix).
//   - Google Places sometimes only exposes the NATIONAL number
//     ("0966 195 2196"), which we stored as "09661952196".
// Every thread lookup is an exact `to_number=eq.<digits>` match, so those two
// spellings of one shop never meet: the outbound anchor is invisible to the
// inbound reply and the agent goes silent. `waDigits` produces one canonical
// key at every write; `numberVariants` lets a read still find rows written in
// any legacy spelling, so existing threads heal with no migration.

import { digitsOnly } from "../phone";

// Country calling codes for the markets we operate in, longest-first so "63"
// can never shadow a longer code added later.
const CALLING_CODES = ["63", "66", "84", "62", "60", "65", "91", "44", "61", "1"];

/**
 * How many trailing digits identify one subscriber line no matter how the
 * number was spelled. Nine is the shortest national subscriber length in every
 * market we operate in, so two numbers that agree on their last nine digits
 * after the country code and trunk prefix are the same line.
 *
 * WHY A TAIL AT ALL. `numberVariants` can only walk international -> national
 * for free; going national -> international needs a country code we often do
 * not have at the call site (an avatar lookup knows a number and nothing else).
 * That made matching ASYMMETRIC: a thread written from a Google national number
 * was found by an inbound international one, but never the other way round.
 * The tail closes the loop in both directions with no country knowledge.
 */
export const TAIL_LEN = 9;

/**
 * Canonical routing key: strip any JID host, drop the multi-device suffix
 * (":12"), then digits only. "639661952196:12@s.whatsapp.net" -> "639661952196".
 */
export function waDigits(input: string | null | undefined): string {
  const s = (input ?? "").trim();
  if (!s) return "";
  const userPart = s.includes("@") ? s.split("@")[0] : s;
  const noDevice = userPart.split(":")[0];
  return digitsOnly(noDevice);
}

/**
 * Every spelling this shop's number may already be stored under, newest
 * convention first. Used to build a tolerant `or=(...)` read filter so a thread
 * written before canonicalization is still found.
 *
 * "639661952196" -> ["639661952196", "09661952196", "9661952196"]
 * "09661952196"  -> ["09661952196", "9661952196", "639661952196"]  (cc unknown -> skipped)
 */
export function numberVariants(input: string | null | undefined, defaultCc?: string): string[] {
  const canonical = waDigits(input);
  if (!canonical) return [];
  const out = new Set<string>([canonical]);

  // International -> national forms (drop the country code, with/without the
  // national trunk "0").
  for (const cc of CALLING_CODES) {
    if (canonical.length > cc.length + 6 && canonical.startsWith(cc)) {
      const national = canonical.slice(cc.length);
      out.add(national);
      out.add(`0${national}`);
      break;
    }
  }

  // National -> international, when we know which country to assume.
  const cc = digitsOnly(defaultCc);
  if (cc) {
    const bare = canonical.replace(/^0+/, "");
    if (!canonical.startsWith(cc)) out.add(`${cc}${bare}`);
  }
  if (canonical.startsWith("0")) out.add(canonical.replace(/^0+/, ""));

  return [...out].filter(Boolean);
}

/**
 * The last `TAIL_LEN` digits of the SUBSCRIBER part - country code and national
 * trunk prefix removed - or "" when the number is too short to identify a line.
 * Two spellings of one shop always agree here; two different shops effectively
 * never do inside one traveller's own threads.
 */
export function nationalTail(input: string | null | undefined): string {
  const canonical = waDigits(input);
  if (!canonical) return "";
  let bare = canonical.replace(/^0+/, "");
  for (const cc of CALLING_CODES) {
    if (bare.length > cc.length + 6 && bare.startsWith(cc)) {
      bare = bare.slice(cc.length).replace(/^0+/, "");
      break;
    }
  }
  return bare.length >= TAIL_LEN ? bare.slice(-TAIL_LEN) : "";
}

/**
 * ONE SHOP, ONE KEY - whatever spelling this particular row happens to carry.
 *
 * `wa_outbox.to_key` and its unique index exist so that a shop stored once as
 * "639661952196" and once as "09661952196" cannot hold TWO live pending rows
 * that a single drain then sends inside the same second. The column shipped
 * with the migration; nothing ever wrote it, so the index quietly degraded to
 * `coalesce(to_key, to_number) = to_number` - exactly the exact-string
 * behaviour it was built to replace.
 *
 * The national tail is the strongest identity we have (it survives country-code
 * and leading-zero variation); waDigits is the fallback for a number too short
 * to yield one.
 */
export function outboxKey(input: string | null | undefined): string {
  return nationalTail(input) || waDigits(input);
}

/**
 * A PostgREST `or=(...)` value matching `column` against every known spelling.
 * Returns null when there is nothing to match (caller should skip the query).
 * Passed as a SEPARATE query param: `&or=${threadNumberOr("to_number", d)}`.
 *
 * The final clause is a TAIL match, which is what makes this symmetric: it finds
 * a row stored in a spelling we cannot derive (a national number when we only
 * hold the international one, or the reverse with no country code in hand).
 */
export function threadNumberOr(column: string, input: string, defaultCc?: string): string | null {
  const variants = numberVariants(input, defaultCc);
  if (variants.length === 0) return null;
  // PostgREST values here are bare digits (no commas/parens possible), so this
  // cannot break the or() grammar - but stay strict anyway.
  const safe = variants.filter((v) => /^\d{5,20}$/.test(v));
  if (safe.length === 0) return null;
  const clauses = safe.map((v) => `${column}.eq.${v}`);
  const tail = nationalTail(input);
  if (tail) clauses.push(`${column}.like.*${tail}`);
  return `(${clauses.join(",")})`;
}

/**
 * The complete query-param fragment for "this column is this shop's number",
 * ready to append to a PostgREST query string. THE boundary primitive: a read
 * path that uses this can never fall back to the exact `=eq.` match that made a
 * real shop's reply invisible to the thread it belonged to.
 *
 * A caller with nothing to match still gets a valid (never-matching) fragment,
 * so a query is never silently widened to "every shop".
 */
export function numberFilter(
  column: string,
  input: string | null | undefined,
  defaultCc?: string
): string {
  const raw = String(input ?? "");
  const or = threadNumberOr(column, raw, defaultCc);
  if (or) return `&or=${or}`;
  // Sentinel rows ("session", "cancel", "takeover") and unparseable input keep
  // their exact match - widening them would cross thread boundaries.
  return `&${column}=eq.${encodeURIComponent(waDigits(raw) || raw)}`;
}

/**
 * THE grouping key for in-memory joins between two sets of numbers that were
 * written by different systems (our outbound rows vs WhatsApp's inbound ones).
 * `numberFilter` is the database-side primitive; this is its twin for code that
 * has already loaded both sides and is about to build a Map. Keying a Map on a
 * raw `from_number` and looking it up with a raw `to_number` is the same bug in
 * a different place - it just fails silently instead of returning no rows.
 */
export function identityKey(input: string | null | undefined): string {
  return nationalTail(input) || waDigits(input);
}

/**
 * THE ONE `negotiation_threads.thread_key` BUILDER (audit F133).
 *
 * There were two, and they disagreed. The funnel ledger keyed
 * `email:identityKey(number)` (the national tail) while the engine keyed
 * `email:digitsOnly(number)`, so for essentially every real international
 * number one shop got TWO rows in a primary-keyed table - the one carrying
 * `stage` and vendor identity, and the one carrying `phase`/`fields`/the
 * digest. Ops listed the shop twice and the transcript read `stage: null` for
 * every live thread.
 *
 * WHY THE FULL NUMBER AND NOT THE TAIL. The tail is the stronger IDENTITY (it
 * survives country-code and leading-zero variation), but a thread key is not
 * only an identity: `buildTurnFromThread` (graph/engine.ts) rebuilds the
 * turn's `toDigits` - the SEND TARGET - by slicing the key at its last colon,
 * and the turn lock keys its slot on those same digits. A national tail there
 * would address WhatsApp with a number missing its country code. So the key
 * carries the canonical DIALABLE spelling, and the cross-spelling case is
 * closed where it belongs: both writers do a spelling-tolerant adoption read
 * (`numberFilter` on `to_number`) before creating a row, so whichever side
 * writes first, the other joins that row instead of splitting beside it.
 */
export function canonicalThreadKey(
  userEmail: string | undefined,
  number: string | null | undefined
): string {
  return `${userEmail ?? "system"}:${waDigits(number)}`;
}

/** Do two numbers denote the same shop, allowing legacy spellings? */
export function sameNumber(a: string | null | undefined, b: string | null | undefined): boolean {
  const av = new Set(numberVariants(a));
  if (av.size === 0) return false;
  if (numberVariants(b).some((v) => av.has(v))) return true;
  const ta = nationalTail(a);
  return Boolean(ta && ta === nationalTail(b));
}

// ---------------------------------------------------------------------------
// JID KINDS. Evolution hands us three shapes on the same field and they are not
// interchangeable: a phone JID carries the shop's number, a privacy @lid JID
// carries an opaque identifier that is NOT a phone number, and a group/status
// JID is not a shop at all. Treating them as one string is how an @lid reply
// became a message from "84912435006" - a number nobody owns.
// ---------------------------------------------------------------------------

export type WaIdKind = "phone" | "lid" | "group" | "unknown";

export function waIdKind(jid: string | null | undefined): WaIdKind {
  const s = String(jid ?? "").trim();
  if (!s) return "unknown";
  if (s.endsWith("@s.whatsapp.net") || s.endsWith("@c.us")) return "phone";
  if (s.endsWith("@lid")) return "lid";
  if (s.endsWith("@g.us") || s.endsWith("@broadcast") || s.endsWith("@newsletter")) return "group";
  // A bare string of digits reaching us from our own storage is a phone key.
  return /^\d{6,20}$/.test(s) ? "phone" : "unknown";
}

export function isPhoneJid(jid: string | null | undefined): boolean {
  return waIdKind(jid) === "phone";
}

/** The opaque identifier of a privacy JID ("12345@lid" -> "12345"), else "". */
export function lidKey(jid: string | null | undefined): string {
  const s = String(jid ?? "").trim();
  if (!s.endsWith("@lid")) return "";
  return s.split("@")[0].split(":")[0].replace(/\D/g, "");
}
