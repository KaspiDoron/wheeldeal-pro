// OUTREACH IDENTITY RESOLUTION (privacy keystone).
//
// A stored outbound row is what later makes an inbound reply attribute to a
// shop, so a phone number may ONLY wear a real shop's name+rfq if it is
// POSITIVELY the shop's own Google-listed phone. This pure decision is the
// single choke point that keeps a spoofed / unverifiable number from
// impersonating a real vendor (which once leaked a private chat onto a real
// Bali shop's card).
//
// The rule is deliberately narrow. Only a POSITIVE contradiction - we have the
// shop's Google phone AND the supplied number provably differs from it - (or an
// explicit owner test) re-keys to a test identity. The mere ABSENCE of a
// reference phone (Google Details 5xx/quota, a shop with no listed phone, or a
// trusted seed/partner vendor with no placeId) must NOT re-key a legit shop:
// doing so orphaned every real reply (it never bound back to the card).

export type OutreachIdentity =
  | { action: "keep" } // keep the real identity, send to the supplied number
  | { action: "send-to-shop"; toPhone: string } // real shop wins; send to its own number
  | { action: "rekey-test"; vendorId: string; vendorName: string }; // windowed test identity

export function resolveOutreachIdentity(opts: {
  claimsRealShop: boolean;
  resolvedPhone: string; // digits only, "" when unknown
  supplied: string; // digits only, "" when none
  /**
   * TRUE only when the caller EXPLICITLY declared this send a drill.
   *
   * This was `isOwner`, then `isOwner && TEST_MODE`. Both were wrong, and the
   * second one broke the beta: TEST_MODE is a billing-and-banner switch that
   * stays ON for the whole tester programme, so every real shop the owner
   * contacted was re-keyed to `test-<digits>`. That vendorId is a DRILL ANCHOR
   * (wa/thread-gate isDrillAnchor), which collapses the inbound window from 14
   * days to 3 hours - so a shop replying the next morning was gated out with
   * `vendor-gate` and never stored - and it is an id no card in the app holds,
   * so even the replies that DID land bound to nothing.
   *
   * A genuine drill does not need this flag to be expressible: passing a
   * `drill-`/`test-` vendorId already sets claimsRealShop=false and keeps its
   * own identity. This is the explicit escape hatch for drilling AGAINST a real
   * shop record, and nothing infers it any more.
   */
  drillIntent: boolean;
  vendorName?: string;
}): OutreachIdentity {
  const { claimsRealShop, resolvedPhone, supplied, drillIntent } = opts;
  if (!claimsRealShop || !supplied) return { action: "keep" };

  const mismatch = Boolean(resolvedPhone && supplied && supplied !== resolvedPhone);
  if (mismatch && !drillIntent) {
    // Real shop, known Google phone, non-matching supplied number: the real
    // shop always wins - send to the shop's own number, keep its identity.
    return { action: "send-to-shop", toPhone: resolvedPhone };
  }
  if (mismatch || drillIntent) {
    // A contradiction we cannot override, or a caller that explicitly declared a
    // drill against an arbitrary number: re-key to an explicit, WINDOWED test identity so
    // a spoofed / unverifiable number can never wear the real shop's name/rfq.
    return {
      action: "rekey-test",
      vendorId: `test-${supplied}`,
      vendorName: `${String(opts.vendorName ?? "Shop").slice(0, 56)} (unverified)`,
    };
  }
  // No reference phone to contradict the number - keep the real identity (the
  // number came from this shop's own discovery record).
  return { action: "keep" };
}
