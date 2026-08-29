// WHAT EACH MOVE MEANS - stated once, in the place the vocabulary lives.
//
// The prompt used to end with a bare `LEGAL MOVES: close, silent` and nothing
// else. A closed vocabulary is a safety property, but a vocabulary is only
// closed for the CODE: the model reads those tokens as English words and
// infers what they must mean. On Ko Tao it inferred that `close` meant close
// the deal, and replied "great, 180 baht per day is a good price!" to a shop
// that had just said it had nothing to rent.
//
// Two fixes, both here. The token is now `farewell`, which cannot be read as
// an agreement; and every legal move now arrives at the model with a one-line
// definition, so nothing is left to inference.

import type { MoveKind } from "./types";

/** One line per move, written for the model, in the model's own terms. */
const MEANING: Record<MoveKind, string> = {
  bargain: "ask for a better daily price, using a real lever",
  answer: "answer what the shop just asked, and nothing more",
  clarify: "ask for the daily price - we still do not have one",
  present: "state the deal as it stands so the traveller can decide",
  "verify-recap":
    "recap the agreed terms back to the shop in one short message - the daily " +
    "price, the length, the deposit and how the vehicle is collected - and ask " +
    "them to confirm it is all correct. If a term is still unknown, ask it " +
    "inside the recap instead of guessing. Never change any number",
  farewell:
    "a warm goodbye ONLY - thank them and end the conversation. This is NOT " +
    "an agreement: never state a price, never accept one, never confirm a booking",
  "deposit-probe": "ask what deposit they require",
  // The glossary is what the model reads. It has to carry BOTH questions, or a
  // shop that has already said "we deliver" gets asked whether it delivers.
  "fulfillment-probe":
    "ask how the traveller gets the vehicle - and if they have already said " +
    "they deliver, ask what the delivery CHARGE is and whether collecting at " +
    "the shop is cheaper. Never ask again what they have already answered",
  "pickup-location": "give them the traveller's stay address and ask if they deliver",
  "option-probe": "they offered several tiers - ask what separates them",
  "confirm-vehicle": "check the quote is for the exact vehicle the traveller asked for",
  "restock-probe": "they have nothing right now - ask warmly when it comes back",
  "redirect-close": "they do not offer what we need - thank them and end it",
  // The token IS the definition (the `close` lesson): a move the model reads as
  // "graceful close" cannot be mistaken for a rate question, which is exactly
  // what the ladder's no-price default used to send to a shop that had just
  // pointed us at its competitors.
  "graceful-close":
    "they have politely sent us elsewhere or bowed out - thank them warmly for " +
    "their time and STOP. Never ask for a price again, never ask anything at " +
    "all, never mention another shop, never try to win them back. One short, " +
    "genuinely friendly line and the conversation is over",
  confirm:
    "you are NOT sure you understood something they said - put it back to them " +
    "as ONE short question in your own words (\"wait - do you mean I can leave " +
    "a passport OR 4,000 cash?\") and wait for their answer. Do not guess, do " +
    "not bargain, do not move on: confirm the fact first",
  momentum: "the thread went quiet - one light nudge to restart it",
  "closing-message": "hand the conversation to the traveller to finish in person",
  silent: "say nothing this turn",
};

/** `LEGAL MOVES` for the prompt, each with its meaning. */
export function moveGlossary(moves: MoveKind[]): string {
  return moves.map((m) => `- ${m}: ${MEANING[m] ?? m}`).join("\n");
}

/**
 * Old names, accepted on the way IN.
 *
 * `close` was the move's name for the whole of the engine's life, so it is
 * still what arrives from three places we do not control: a model that learned
 * the old vocabulary from an exemplar, an owner correction stored in
 * `ops_learning`, and a golden case row written before the rename. Renaming a
 * value that has persisted representations means accepting the old spelling
 * forever - the alternative is a silent coercion to `legal[0]`, which throws
 * away a choice that was actually correct.
 */
const LEGACY: Record<string, MoveKind> = { close: "farewell" };

/** Normalize any externally-sourced move string to the current vocabulary. */
export function normalizeMove(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  return LEGACY[s] ?? s;
}

/** The closed vocabulary as data - MEANING is keyed on MoveKind, so this list
 *  can never drift from the type. */
export const MOVE_KINDS = Object.keys(MEANING) as MoveKind[];

/** Is this externally-sourced string a move the engine actually has? Used by
 *  the golden-case builders: a stored expectation naming a move that does not
 *  exist would fail every replay forever, so unknown strings are dropped at
 *  the door rather than frozen. */
export function isMoveKind(v: unknown): v is MoveKind {
  return typeof v === "string" && (MOVE_KINDS as string[]).includes(v);
}

/** Does this move put a PRICE or an AGREEMENT on the table? */
export function isPriceMove(move: MoveKind): boolean {
  return move === "bargain" || move === "present" || move === "momentum";
}
