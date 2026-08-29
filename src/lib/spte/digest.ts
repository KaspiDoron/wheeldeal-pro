// SPTE memory consolidation / context compression: the rolling ThreadDigest
// absorbs the conversation so history never accumulates in the prompt. Each
// turn the single pass returns <=3 new durable facts; these merge in, oldest
// evicted past a cap. This is what keeps 10 threads x 15 messages inside a lean
// per-turn token budget.

import type {
  ConfirmSubject,
  DurableComprehension,
  PendingConfirm,
  ThreadDigest,
  TurnArtifact,
  VerifiedExtraction,
} from "./types";
import type { TurnComprehension } from "./comprehension";

const MAX_FACTS = 10;

/**
 * THE THREE NOTES THIS FILE ITSELF WRITES WHEN A THREAD ENDS.
 *
 * `hasClosed()` used to decide the terminal fact by grepping the durable notes
 * for /closed|goodbye|declined/, and those notes are FREE TEXT THE MODEL WROTE:
 * "they have NOT declined" read as declined and muted the thread forever. The
 * verdict is a structured flag now (DurableComprehension.closed).
 *
 * This list exists ONLY to migrate rows persisted before that flag did. It is
 * matched by EXACT equality against strings this module generated itself, never
 * as a pattern over model prose, and it can be deleted once no live row predates
 * the flag.
 */
const LEGACY_CLOSED_NOTES = [
  "closed - one goodbye sent",
  "shop declined / walked away",
  "shop pointed us elsewhere - not dealing",
];

/**
 * ONE TURN OF MODEL COMPREHENSION FOLDED INTO THE THREAD'S DURABLE READING (A4).
 *
 * Pure, so the whole memory rule is testable without a provider. Three shapes of
 * fact, three different merge rules, each chosen by what a wrong answer costs:
 *
 *   - EVENTS accumulate (`firmTurns`): a refusal that happened stays happened.
 *   - LATCHES only ever go true (`depositStated`, `handoverCostKnown`, `closed`):
 *     a shop that has told us its deposit has told us, and a later message that
 *     is silent on the subject is silence, not a retraction.
 *   - STATES take the newest reading (`stance`, `declined`, `deflected`,
 *     `availability`, `handoverMode`): a shop that re-engages is engaged again,
 *     and a shop that restocks has stock.
 *
 * AND WHEN NO MODEL ANSWERED (`comp` null, `degraded`, or a field the provider
 * omitted) NOTHING CHANGES. The previous reading is carried forward untouched -
 * memory, not fabrication. A thread that never got a model read carries no
 * verdicts at all, which downstream means "unknown": not declined, not firm,
 * terms not known. Every one of those defaults keeps the negotiation alive and
 * keeps a question askable, which is the only safe direction here.
 */
export function mergeComprehension(
  prev: DurableComprehension | undefined,
  comp: TurnComprehension | null | undefined
): DurableComprehension | undefined {
  const base: DurableComprehension = { ...(prev ?? {}) };
  if (!comp || comp.degraded) return prev;
  const next: DurableComprehension = { ...base };
  next.stance = comp.stance;
  next.declined = comp.declined;
  next.deflected = comp.deflected;
  // A terminal STANCE is not yet a closed THREAD: the goodbye this very turn
  // sends in response is what closes it, and mergeDigest latches `closed`
  // when that move is actually taken. Latching here silenced the goodbye
  // itself - the policy read "closed" before the farewell could go out.
  if (comp.availability && comp.availability !== "unclear") {
    next.availability = comp.availability;
    next.restockHint = comp.restockHint;
  }
  // `firm === undefined` means the provider omitted the key - nobody looked, so
  // nothing is counted. Only an explicit `true` from a model above the firmness
  // floor may ever advance the counter that stops us bargaining.
  if (comp.firm === true) next.firmTurns = (base.firmTurns ?? 0) + 1;
  if (comp.deposit?.stated === true) {
    next.depositStated = true;
    next.depositKind = comp.deposit.kind;
  }
  if (comp.handover) {
    if (comp.handover.mode !== "unstated") next.handoverMode = comp.handover.mode;
    if (comp.handover.costStated) next.handoverCostKnown = true;
  }
  return next;
}

/**
 * HOW LONG A THREAD MAY WAIT ON AN ANSWER IT ASKED FOR.
 *
 * The owner's doctrine has two halves - ask when unsure, and WAIT for the reply
 * - and the second half needs a bound or a shop that never answers freezes the
 * negotiation forever. Turns, not minutes, because turns are what this engine
 * counts: an inbound message, a scheduled tick and a swarm poke each spend one.
 * Three is enough to survive the wakeup a paused thread schedules for itself
 * plus a couple of unrelated messages, and short enough that a silent shop is
 * released the same day.
 *
 * Durable, like the wait itself: an in-memory counter would reset on every cold
 * start, which on serverless means "never expires" or "expires at random".
 */
export const CONFIRM_WAIT_TURNS = 3;

/**
 * ...AND THE SECOND BOUND, IN WALL-CLOCK TIME.
 *
 * The turn bound only advances when a turn happens, and a shop that never
 * replies causes no turns - so a confirm-question the shop ignored froze a
 * priced thread FOREVER (the card said "double-checking with the shop"
 * indefinitely). The live path stamps `pending[].at` when the confirm is
 * delivered and arms one tick; any turn that sees this much wall time elapsed
 * releases the wait exactly as the turn bound would - with the note that the
 * shop never answered, never a claim that they confirmed.
 */
export const CONFIRM_WAIT_MS = 45 * 60_000;

/**
 * ...AND HOW LONG A DOUBT MAY SIT UNASKED.
 *
 * A flagged subject blocks the fact from reading as known, so a doubt the engine
 * never gets around to asking about would deadlock the thread just as surely.
 * The model picks the MOVE, so `confirm` being legal is not a guarantee it is
 * chosen; this is the escape hatch, and it releases the subject WITHOUT ever
 * claiming the shop confirmed anything (see the fact written on expiry).
 */
export const CONFIRM_OPEN_TURNS = 3;

export function emptyDigest(): ThreadDigest {
  return { facts: [], round: 0 };
}

/**
 * THE HALF OF THE DIGEST THAT IS DURABLE.
 *
 * Everything else on ThreadDigest (firmCount, depositKnown, options, the
 * ledger, lastOutbound) is RE-DERIVED from the thread's own rows every turn -
 * "the conversation is the state" - so persisting it would only create stale
 * copies that can disagree with the messages. These five cannot be derived:
 * the model's durable notes, the quote a shop gave and never restated, how many
 * times we pushed, the tone we read, and which confirming questions we have
 * already spent. They are what `buildDigest` seeds from.
 */
export function persistableDigest(d: ThreadDigest): Partial<ThreadDigest> {
  return {
    facts: d.facts.slice(-MAX_FACTS),
    ...(typeof d.quotedPricePerDay === "number" ? { quotedPricePerDay: d.quotedPricePerDay } : {}),
    round: d.round,
    ...(d.tone ? { tone: d.tone } : {}),
    ...(d.confirmAsked?.length ? { confirmAsked: d.confirmAsked } : {}),
    ...(d.awaitingConfirmation ? { awaitingConfirmation: d.awaitingConfirmation } : {}),
    // THE DOUBTS THEMSELVES. Derived state is deliberately not persisted here -
    // but a doubt is not derivable: the message that caused it scrolls into
    // history and the regexes that read that history are exactly the ones that
    // cannot see the ambiguity. Persist it or "unsure" evaporates on the next
    // turn, which is the bug this field exists for.
    ...(d.pending?.length ? { pending: d.pending } : {}),
    // The once-ever price-watch bound (owner report 5 #9). Durable or it is not
    // a bound at all - an in-memory flag would re-arm on every cold start.
    ...(d.priceWatchArmed ? { priceWatchArmed: true } : {}),
    // Step 7-8 state: the recap latch + its clocks, and the silent-but-owing
    // re-entry bound. Durable for the same reason as priceWatchArmed.
    ...(d.recapSent ? { recapSent: true } : {}),
    ...(typeof d.recapSentAt === "number" ? { recapSentAt: d.recapSentAt } : {}),
    ...(typeof d.recapConfirmedAt === "number" ? { recapConfirmedAt: d.recapConfirmedAt } : {}),
    ...(d.recapAmended ? { recapAmended: true } : {}),
    ...(d.oweWatchArmed ? { oweWatchArmed: true } : {}),
    // THE MODEL'S READING OF THE THREAD (A4). Same argument as `pending` above,
    // one layer up: a stance, a refusal to go lower and a stated deposit are not
    // derivable from history by anything but the regexes that could not read
    // them in the first place - and on a localized thread could not read them at
    // all, because the English gloss only exists for the current turn. Persist it
    // or every thread-level meaning restarts from a phrase list on turn two.
    ...(d.comprehension && Object.keys(d.comprehension).length
      ? { comprehension: d.comprehension }
      : {}),
  };
}

/** Read a stored digest back, defensively - the column is free-form JSON that
 *  older rows do not have at all. */
/** The durable model reading, read back defensively - free-form JSON that rows
 *  written before A4 do not have at all. Every field is optional and every
 *  malformed one drops to "we never read it", which is the safe default for all
 *  of them (keep negotiating, keep the questions askable). */
function comprehensionFromStored(
  raw: unknown,
  facts: string[]
): DurableComprehension | undefined {
  const c = (raw ?? null) as Partial<DurableComprehension> | null;
  const out: DurableComprehension = {};
  if (c && typeof c === "object") {
    if (c.stance === "engaged" || c.stance === "deflecting" || c.stance === "declining" || c.stance === "unclear") {
      out.stance = c.stance;
    }
    if (typeof c.declined === "boolean") out.declined = c.declined;
    if (typeof c.deflected === "boolean") out.deflected = c.deflected;
    if (c.availability === "has" || c.availability === "none" || c.availability === "later" || c.availability === "unclear") {
      out.availability = c.availability;
    }
    if (typeof c.restockHint === "string" && c.restockHint.trim()) out.restockHint = c.restockHint;
    if (typeof c.firmTurns === "number" && c.firmTurns > 0) out.firmTurns = Math.floor(c.firmTurns);
    if (typeof c.depositStated === "boolean") out.depositStated = c.depositStated;
    if (
      c.depositKind === "cash" || c.depositKind === "document" || c.depositKind === "cash-or-document" ||
      c.depositKind === "card" || c.depositKind === "none" || c.depositKind === "unclear"
    ) {
      out.depositKind = c.depositKind;
    }
    if (c.handoverMode === "delivery" || c.handoverMode === "pickup" || c.handoverMode === "both" || c.handoverMode === "unstated") {
      out.handoverMode = c.handoverMode;
    }
    if (typeof c.handoverCostKnown === "boolean") out.handoverCostKnown = c.handoverCostKnown;
    if (typeof c.closed === "boolean") out.closed = c.closed;
  }
  // MIGRATION ONLY. A row persisted before this block existed records its close
  // in the durable notes, so exact-match those three self-written literals once
  // on read rather than leaving every mid-flight thread able to send a second
  // goodbye. This is NOT the old prose grep: equality against strings this file
  // generated, not a pattern over anything a model wrote.
  if (out.closed === undefined && facts.some((f) => LEGACY_CLOSED_NOTES.includes(f.trim().toLowerCase()))) {
    out.closed = true;
  }
  return Object.keys(out).length ? out : undefined;
}

export function digestFromStored(stored: unknown): ThreadDigest {
  const base = emptyDigest();
  const s = (stored ?? null) as Partial<ThreadDigest> | null;
  if (!s || typeof s !== "object") return base;
  const facts = Array.isArray(s.facts)
    ? s.facts.filter((f) => typeof f === "string").slice(-MAX_FACTS)
    : [];
  return {
    ...base,
    facts,
    comprehension: comprehensionFromStored(s.comprehension, facts),
    quotedPricePerDay:
      typeof s.quotedPricePerDay === "number" && s.quotedPricePerDay > 0
        ? s.quotedPricePerDay
        : undefined,
    round: typeof s.round === "number" && s.round >= 0 ? s.round : 0,
    tone: s.tone,
    confirmAsked: Array.isArray(s.confirmAsked)
      ? (s.confirmAsked.filter((x) => typeof x === "string") as ConfirmSubject[])
      : undefined,
    awaitingConfirmation:
      s.awaitingConfirmation && typeof s.awaitingConfirmation === "object"
        ? s.awaitingConfirmation
        : null,
    // ABSENT means not armed, so a row written before this field existed reads
    // as "no watch yet" rather than as a watch that already happened.
    priceWatchArmed: s.priceWatchArmed === true ? true : undefined,
    recapSent: s.recapSent === true ? true : undefined,
    recapSentAt: typeof s.recapSentAt === "number" ? s.recapSentAt : undefined,
    recapConfirmedAt: typeof s.recapConfirmedAt === "number" ? s.recapConfirmedAt : undefined,
    recapAmended: s.recapAmended === true ? true : undefined,
    oweWatchArmed: s.oweWatchArmed === true ? true : undefined,
    // A ROW WRITTEN BEFORE `pending` EXISTED still knows it was waiting on
    // something - `awaitingConfirmation` is the card's mirror of exactly that -
    // so it is migrated forward rather than dropped. Threads mid-question at
    // deploy time keep waiting instead of quietly resuming without an answer.
    pending: pendingFromStored(s.pending) ?? pendingFromAwaiting(s.awaitingConfirmation),
  };
}

function pendingFromAwaiting(a: ThreadDigest["awaitingConfirmation"]): PendingConfirm[] | undefined {
  if (!a || typeof a !== "object" || typeof a.question !== "string" || !a.question.trim()) {
    return undefined;
  }
  return [{ subject: a.subject, question: a.question, state: "waiting", turns: 0 }];
}

/** The doubts, read back defensively - free-form JSON older rows do not have. */
function pendingFromStored(stored: unknown): PendingConfirm[] | undefined {
  if (!Array.isArray(stored)) return undefined;
  const out: PendingConfirm[] = [];
  for (const raw of stored) {
    const p = raw as Partial<PendingConfirm> | null;
    if (!p || typeof p !== "object" || typeof p.subject !== "string") continue;
    if (typeof p.question !== "string" || !p.question.trim()) continue;
    out.push({
      subject: p.subject as ConfirmSubject,
      ...(typeof p.reading === "string" ? { reading: p.reading } : {}),
      question: p.question,
      ...(typeof p.confidence === "number" ? { confidence: p.confidence } : {}),
      // A row whose state is missing reads as WAITING, the conservative side:
      // it holds the thread rather than letting an unconfirmed reading through.
      state: p.state === "open" ? "open" : "waiting",
      turns: typeof p.turns === "number" && p.turns >= 0 ? Math.floor(p.turns) : 0,
      ...(typeof p.at === "number" ? { at: p.at } : {}),
    });
  }
  return out.length ? out : undefined;
}

/**
 * ONE TURN OF THE DOUBT STATE MACHINE - pure arithmetic, run before the legal
 * move set is computed.
 *
 * Deterministic code owns "are we waiting, for what, and for how long"; the
 * MODEL owns "did they answer it" and hands its verdict in as `resolved`. That
 * split is the owner's doctrine exactly: no if/else decides what a message
 * means, and no model decides how long a bound is.
 *
 * Three outcomes per doubt:
 *   - resolved   -> gone, and the fact may read as known again.
 *   - expired    -> gone, and a durable note says the shop never answered, so
 *                   nothing downstream can claim they confirmed it.
 *   - otherwise  -> carried, one turn older.
 */
export function advanceConfirmState(
  d: ThreadDigest,
  resolved: ConfirmSubject[] = [],
  /** Wall clock for the second bound. Absent on replays - pure turn arithmetic. */
  nowMs?: number
): ThreadDigest {
  const pending = d.pending ?? [];
  if (!pending.length) return d;
  const facts = [...d.facts];
  const next: PendingConfirm[] = [];
  for (const p of pending) {
    if (resolved.includes(p.subject)) continue;
    const turns = p.turns + 1;
    const bound = p.state === "waiting" ? CONFIRM_WAIT_TURNS : CONFIRM_OPEN_TURNS;
    // The wall-clock bound (see CONFIRM_WAIT_MS): a shop that never replies
    // causes no turns, so without this the wait never expired at all.
    const clockExpired =
      p.state === "waiting" &&
      typeof nowMs === "number" &&
      typeof p.at === "number" &&
      nowMs - p.at > CONFIRM_WAIT_MS;
    if (turns > bound || clockExpired) {
      // NOT "they confirmed it" - "we never found out". The distinction is the
      // whole point: the thread is released so it cannot deadlock, and the note
      // is what stops a later surface presenting the unconfirmed reading as the
      // shop's settled terms.
      const note = `we asked the shop to confirm the ${p.subject} and they never answered - their own words are the only terms we have`;
      if (!facts.some((f) => f.toLowerCase() === note.toLowerCase())) facts.push(note);
      continue;
    }
    next.push({ ...p, turns });
  }
  const waiting = next.find((p) => p.state === "waiting");
  return {
    ...d,
    facts: facts.slice(Math.max(0, facts.length - MAX_FACTS)),
    pending: next.length ? next : undefined,
    awaitingConfirmation: waiting
      ? { subject: waiting.subject, question: waiting.question }
      : null,
  };
}

/**
 * THE LOST-RACE UNION (graph/state.ts saveThreadState). When an inbound turn
 * and a tick turn race on the optimistic version, the loser's re-merge used to
 * keep only six counters and take `...winner.fields` for everything else -
 * dropping the loser's WHOLE digest: the standing quote, the pending confirms,
 * the model's durable comprehension, the once-flags. The tick turn wins the
 * version; the inbound turn's freshly-read "deposit stated: 3000 cash"
 * vanishes and the next turn re-asks.
 *
 * Union rules by what a wrong answer costs (mergeComprehension's own logic,
 * one level up): facts union (capped), counters max, latches OR, the quote and
 * states prefer OURS (the losing write just processed the newest event),
 * pending doubts union by subject preferring ours.
 */
export function mergeStoredDigests(winnerRaw: unknown, oursRaw: unknown): Partial<ThreadDigest> {
  const w = digestFromStored(winnerRaw);
  const o = digestFromStored(oursRaw);
  const facts = [...w.facts];
  for (const f of o.facts) {
    if (!facts.some((x) => x.toLowerCase() === f.toLowerCase())) facts.push(f);
  }
  const pending: PendingConfirm[] = [...(o.pending ?? [])];
  for (const p of w.pending ?? []) {
    if (!pending.some((x) => x.subject === p.subject)) pending.push(p);
  }
  const waiting = pending.find((p) => p.state === "waiting");
  const comp: DurableComprehension | undefined =
    w.comprehension || o.comprehension
      ? {
          ...(w.comprehension ?? {}),
          ...(o.comprehension ?? {}),
          // Events accumulate and latches only go true, whoever holds them.
          ...(Math.max(w.comprehension?.firmTurns ?? 0, o.comprehension?.firmTurns ?? 0) > 0
            ? { firmTurns: Math.max(w.comprehension?.firmTurns ?? 0, o.comprehension?.firmTurns ?? 0) }
            : {}),
          ...(w.comprehension?.depositStated || o.comprehension?.depositStated
            ? { depositStated: true }
            : {}),
          ...(w.comprehension?.handoverCostKnown || o.comprehension?.handoverCostKnown
            ? { handoverCostKnown: true }
            : {}),
          ...(w.comprehension?.closed || o.comprehension?.closed ? { closed: true } : {}),
        }
      : undefined;
  return persistableDigest({
    facts: facts.slice(Math.max(0, facts.length - MAX_FACTS)),
    quotedPricePerDay: o.quotedPricePerDay ?? w.quotedPricePerDay,
    round: Math.max(w.round, o.round),
    tone: o.tone ?? w.tone,
    comprehension: comp,
    confirmAsked: [...new Set([...(w.confirmAsked ?? []), ...(o.confirmAsked ?? [])])],
    awaitingConfirmation: waiting
      ? { subject: waiting.subject, question: waiting.question }
      : null,
    pending: pending.length ? pending : undefined,
    priceWatchArmed: w.priceWatchArmed || o.priceWatchArmed || undefined,
    oweWatchArmed: w.oweWatchArmed || o.oweWatchArmed || undefined,
    recapSent: w.recapSent || o.recapSent || undefined,
    recapSentAt: o.recapSentAt ?? w.recapSentAt,
    recapConfirmedAt: o.recapConfirmedAt ?? w.recapConfirmedAt,
    recapAmended: w.recapAmended || o.recapAmended || undefined,
  });
}

/**
 * Merge a turn's outcome into the durable digest: append the model's fact patch,
 * fold in verified price/decline signals deterministically (never trust the LLM
 * for numbers), bump the round when we bargained, cap + evict oldest.
 */
export function mergeDigest(
  prev: ThreadDigest,
  artifact: TurnArtifact,
  verified: VerifiedExtraction
): ThreadDigest {
  const facts = [...prev.facts];
  const add = (f: string) => {
    const t = f.trim();
    if (t && !facts.some((x) => x.toLowerCase() === t.toLowerCase())) facts.push(t);
  };

  // Deterministic, verified signals first (these outrank any LLM claim).
  if (verified.found && typeof verified.pricePerDay === "number") {
    add(`quoted ${verified.pricePerDay}${verified.currency ? " " + verified.currency : ""}/day`);
  }
  if (verified.declined) add("shop declined / walked away");
  // Only a REAL mismatch. `hasClosed()` scans these facts, so writing this on a
  // merely-ambiguous reply permanently muted the thread.
  if (verified.wrongVehicle) add("shop does not offer the requested vehicle");
  if (verified.vehicleUnclear) add("which vehicle this price is for is not confirmed yet");
  for (const o of verified.options ?? []) {
    add(`option: ${o.label} at ${o.pricePerDay}${o.currency ? " " + o.currency : ""}/day`);
  }

  // A SHOP THAT SENT US ELSEWHERE IS A CLOSED THREAD TOO. Without this the
  // one-warm-goodbye rule (`hasClosed`) could not see a graceful close, so the
  // next event on the thread would offer a second goodbye.
  if (verified.deflected) add("shop pointed us elsewhere - not dealing");

  // The model's durable notes (deposit terms, condition, tone cues). EVIDENCE
  // ONLY - nothing downstream may read a verdict out of this prose again.
  for (const f of artifact.digestPatch) add(f);
  const closedByUs =
    artifact.move === "farewell" ||
    artifact.move === "redirect-close" ||
    artifact.move === "graceful-close";
  // The note stays for the humans reading a trace and for the prompt's memory;
  // the VERDICT is the structured flag below (A6). We wrote this literal, so
  // writing it can flip the flag - reading it back out of prose cannot.
  if (closedByUs) add("closed - one goodbye sent");

  // Keep the freshest MAX_FACTS (evict oldest).
  const capped = facts.slice(Math.max(0, facts.length - MAX_FACTS));

  // THE ASK-ONCE BOUND ON THE THIRD LEDGER STATE. A confirming question is
  // legal exactly once per subject; this is the record that makes "once" mean
  // anything, and it only means anything because the digest is now persisted.
  const confirmSubject = artifact.move === "confirm" ? artifact.confirmSubject : undefined;
  const confirmAsked = confirmSubject
    ? [...new Set([...(prev.confirmAsked ?? []), confirmSubject])]
    : prev.confirmAsked;

  // THE DOUBTS THIS TURN LEAVES THE THREAD WITH.
  //
  // Two writers, and neither of them is "the current frame looks fine":
  //   - the comprehension pass flags a subject -> it is carried as `open`,
  //     durably, so the next turn cannot forget the thread is unsure;
  //   - our confirming question goes out -> that subject flips to `waiting`,
  //     and the thread waits (policy.ts holds the moves down to silence).
  //
  // Nothing here CLEARS a doubt. Clearing is a judgement about what the shop's
  // reply meant, which belongs to the model (advanceConfirmState's `resolved`),
  // or to the turn bound. This function used to clear the wait whenever the
  // current message carried no uncertainty - which is true of every scheduled
  // tick, so the agent asked its question and then bargained without the answer.
  const pending: PendingConfirm[] = (prev.pending ?? []).map((p) => ({ ...p }));
  for (const u of verified.uncertain ?? []) {
    const seen = pending.find((p) => p.subject === u.subject);
    if (seen) {
      // The same doubt, restated: keep the state machine's clock, refresh the
      // words. A shop repeating an ambiguous answer does not buy a fresh wait.
      seen.reading = u.reading || seen.reading;
      seen.question = u.question?.trim() || seen.question;
      seen.confidence = u.confidence;
      continue;
    }
    if (!u.question?.trim()) continue;
    pending.push({
      subject: u.subject,
      reading: u.reading,
      question: u.question,
      confidence: u.confidence,
      state: "open",
      turns: 0,
    });
  }
  if (confirmSubject) {
    const question =
      (verified.uncertain ?? []).find((u) => u.subject === confirmSubject)?.question ??
      pending.find((p) => p.subject === confirmSubject)?.question ??
      artifact.message ??
      "";
    const seen = pending.find((p) => p.subject === confirmSubject);
    if (seen) {
      seen.state = "waiting";
      seen.turns = 0;
      seen.question = question || seen.question;
    } else {
      pending.push({ subject: confirmSubject, question, state: "waiting", turns: 0 });
    }
  }

  // WHAT THE CARD SAYS WHILE WE WAIT - a mirror of the state machine, never a
  // second opinion about it.
  const waiting = pending.find((p) => p.state === "waiting");
  const awaitingConfirmation = waiting
    ? { subject: waiting.subject, question: waiting.question }
    : null;

  // THE THREAD'S DURABLE READING, CARRIED (A4). `prev.comprehension` was already
  // folded this turn by live.ts (buildDigest -> mergeComprehension) so the
  // policy could see it; all that is left here is to make sure it survives into
  // the row, plus the one fact only this function knows: that WE closed.
  const comprehension: DurableComprehension | undefined = closedByUs
    ? { ...(prev.comprehension ?? {}), closed: true }
    : prev.comprehension;

  return {
    facts: capped,
    quotedPricePerDay:
      verified.found && typeof verified.pricePerDay === "number"
        ? verified.pricePerDay
        : prev.quotedPricePerDay,
    round: prev.round + (artifact.move === "bargain" ? 1 : 0),
    tone: prev.tone,
    ...(comprehension ? { comprehension } : {}),
    confirmAsked,
    awaitingConfirmation,
    pending: pending.length ? pending : undefined,
    // Step 7-8 state, carried - and the once-per-thread recap latch, set HERE
    // (deterministically, so golden replays see it) rather than on the wall
    // clock the live path stamps beside it.
    ...(prev.recapSent || artifact.move === "verify-recap" ? { recapSent: true } : {}),
    ...(typeof prev.recapSentAt === "number" ? { recapSentAt: prev.recapSentAt } : {}),
    ...(typeof prev.recapConfirmedAt === "number"
      ? { recapConfirmedAt: prev.recapConfirmedAt }
      : {}),
    ...(prev.recapAmended ? { recapAmended: true } : {}),
    ...(prev.oweWatchArmed ? { oweWatchArmed: true } : {}),
    ...(prev.priceWatchArmed ? { priceWatchArmed: true } : {}),
  };
}
