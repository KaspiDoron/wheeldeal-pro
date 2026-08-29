// The engine-v3-turn detail blob, bounded WITHOUT ever breaking its syntax.
//
// The old cap was `JSON.stringify(obj).slice(0, 1600)` - a string cut
// mid-token, so the moment a turn's payload crossed the cap the blob stopped
// being JSON at all and every reader's JSON.parse threw: the turn silently
// dropped out of ALL metrics (latency KPI, the inspector, the A/B rows). And
// the turns that cross the cap are precisely the degraded ones - long provider
// errors, many legal moves, big uncertainty lists - i.e. the metrics lost
// exactly the turns worth studying.
//
// This clamp shrinks FIELDS, never the serialization: progressively tighter
// clips of the free-text tails, then dropping them, then a minimal core that
// cannot miss. Every rung re-stringifies whole, so the output is valid JSON at
// every size.

const clip = (v: unknown, n: number): unknown =>
  typeof v === "string" && v.length > n ? v.slice(0, n) : v;
const clipArr = (v: unknown, n: number): unknown => (Array.isArray(v) ? v.slice(0, n) : v);

export function clampTurnDetail(detail: Record<string, unknown>, cap = 1600): string {
  const full = JSON.stringify(detail);
  if (full.length <= cap) return full;

  // Rung 2: tighten the known-long tails (free text + unbounded lists).
  const tightened: Record<string, unknown> = {
    ...detail,
    providerError: clip(detail.providerError, 80),
    reason: clip(detail.reason, 80),
    legalMoves: clipArr(detail.legalMoves, 8),
    leverage: clipArr(detail.leverage, 4),
    unsure: clipArr(detail.unsure, 4),
    think: clip(detail.think, 60),
    text: clip(detail.text, 60),
  };
  const second = JSON.stringify(tightened);
  if (second.length <= cap) return second;

  // Rung 3: the scratchpad and wire text go entirely - they are the bonus,
  // the metrics are the point.
  const { think: _think, text: _text, ...metrics } = tightened;
  const third = JSON.stringify(metrics);
  if (third.length <= cap) return third;

  // Rung 4: the minimal core that every KPI reader needs. The enums are
  // clipped too - they are closed vocabularies in practice, but this rung's
  // whole promise is that NOTHING can push it past a sane cap.
  return JSON.stringify({
    move: clip(detail.move ?? null, 40),
    tier: clip(detail.tier ?? null, 40),
    delivered: clip(detail.delivered ?? null, 40),
    latencyMs: typeof detail.latencyMs === "number" ? detail.latencyMs : null,
    quote: typeof detail.quote === "number" ? detail.quote : null,
    truncated: true,
  });
}
