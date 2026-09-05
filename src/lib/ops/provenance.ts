import { isPseudonym, pseudonymForEmail } from "../privacy/pseudonym";

// GOLDEN-CASE PROVENANCE WITHOUT THE ADDRESS (audit F169).
//
// The erasure registry excused agent_golden_cases as "de-identified at
// capture", and both capture paths (Ops -> freeze this thread, and the misread
// correction) persisted `thread_key: threadKey` - the raw `${email}:${digits}`
// - beside the traveller's RFQ and up to eight verbatim shop messages. An
// erased tester's address stayed in the replay suite forever.
//
// Every writer now stamps THIS instead: the sha256-prefix pseudonym plus the
// shop digits. The owner can still tell cases from one account apart (and
// match them to the instance name the Architecture card shows); nothing in
// the row can be turned back into the person. The table is REGISTERED for
// erasure under both the legacy and the pseudonymous prefix, because the row
// still holds that person's RFQ and conversation excerpts.

export { pseudonymForEmail };

/** `${email}:${digits}` -> `${pseudonym}:${digits}`; already-stamped keys pass through. */
export function goldenProvenance(threadKey: string): string {
  const idx = threadKey.lastIndexOf(":");
  if (idx <= 0) return threadKey;
  const who = threadKey.slice(0, idx);
  const digits = threadKey.slice(idx + 1);
  if (isPseudonym(who)) return `${who}:${digits}`;
  return `${pseudonymForEmail(who)}:${digits}`;
}
