// The consent-gated projection (Wave 9, owner problem #10).
//
// product_events is the structured behavioural dataset - one typed row per
// funnel/booking stage transition - and it is a PROJECTION of writes the
// system already makes for observability (advanceThreadStage/advanceBooking).
// One write serves both; the difference is the gate: the observability copy
// (agent_events) always lands, this copy lands ONLY while the person's
// 'analytics' consent is granted. No consent, no row - not a flag on the row,
// no row at all, so a later export or sale of the table cannot include a
// person who never opted in.
//
// Best-effort by design: a projection failure must never block a funnel
// transition, and a missing product_events table (pre-migration) is a silent
// no-op, not an error.

import "server-only";
import { sbInsert } from "../runtime-config";

export interface ProductEventInput {
  email: string;
  stage: string;
  kind: "thread-stage" | "booking-stage";
  sessionId?: string | null;
  props?: Record<string, unknown>;
}

/** Fire-and-forget: gate on consent, then insert. Never throws. */
export async function projectProductEvent(input: ProductEventInput): Promise<void> {
  const email = String(input.email ?? "").trim().toLowerCase();
  if (!email || !input.stage) return;
  try {
    const { consentFor } = await import("../consent");
    if (!(await consentFor(email, "analytics"))) return;
    await sbInsert("product_events", [
      {
        user_email: email,
        session_id: input.sessionId ?? null,
        stage: input.stage,
        kind: input.kind,
        props: input.props ?? null,
      },
    ]).catch(() => false);
  } catch {
    /* a projection is never worth a failed funnel write */
  }
}
