import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { sbSelect, sbSelectStrict, sbInsert, pgTimestamp } from "@/lib/runtime-config";
import { digitsOnly } from "@/lib/phone";
import { killSwitchOn } from "@/lib/usage";
import {
  groupSearchSessions,
  sessionIdOf,
  huntWindow,
  huntWindowFilter,
} from "@/lib/session-life";
import { recheckMessage } from "@/lib/wa/recheck-message";
import { can, localLanguageAllowed } from "@/lib/entitlements";
import type { PlanId } from "@/lib/access";
import { termsComplete, type DealTerms } from "@/lib/deal-terms";
import { threadWritesEnglish, type ThreadLanguage } from "@/lib/wa/thread-language";

export const dynamic = "force-dynamic";

// "IS THAT PRICE STILL GOOD?" - the thing a past trip is actually for.
//
// Trips could re-open an old hunt's workspace, but every number on it was
// frozen at whatever the shop said days or weeks ago. A traveller coming back
// to a hunt has exactly one question, and it is the same question for every
// shop on the list, so asking it should be one tap - not ten conversations
// re-opened by hand.
//
// This re-asks each shop from ONE past session whether its own last quote still
// stands. Three things make that safe:
//
//   * It is never a cold contact. Only numbers already in this user's own
//     outbound history are eligible, so nothing here can start a new thread -
//     it continues one the shop already answered.
//   * It goes through `guardOutbound` exactly like every other send: pacing,
//     the session pause, human takeover, cancellation tombstones and the
//     duplicate suppressor all apply, and anything held is parked in the
//     outbox and drains on its own.
//   * It quotes the shop's OWN number back to them. No invented figure ever
//     reaches a shop - the price comes from the offers row we stored when they
//     said it.
//
// W6.1 - THE COMPLETENESS FILTER, WHICH WAS THE WHOLE POINT AND WAS MISSING.
//
// The target list was built from every distinct outbound number in the hunt
// window - i.e. every shop CONTACTED, whether or not it ever answered. The
// price map was used only to pick the wording, never to filter, and the deposit
// and the fulfillment were never read at all. So the "is that price still
// good?" tap messaged shops that had never said a price, and the message it
// sent them could not name any condition to hold constant.
//
// The owner's rule, verbatim: re-ask "ONLY if we have price, deposit and how we
// get the vehicle details". `termsComplete` (src/lib/deal-terms.ts) is that
// rule, shared with /api/replies so the two can never drift.
//
// This also removes the terminal wall those shops hit: `kind: "recheck"` is not
// exempt from the engagement halt (only "rfq" is) and `isNewContact` is false
// for anyone already in `wa_recipient_state`, so every never-replied shop was
// dropped by the guard anyway - after we had already decided to message it. A
// correct filter removes them by construction.

/** One re-check per shop per day - asking twice reads as a bot, and is rude. */
const RECHECK_WINDOW_MS = 20 * 3600_000;

interface OfferRow {
  vendor_id: string | null;
  vendor_name: string | null;
  price_per_day: number | null;
  currency: string | null;
  created_at: string;
}

/** The deposit + fulfillment half of the terms, per shop, from replies. */
interface ReplyTermsRow {
  vendor_id: string | null;
  vendor_name: string | null;
  deposit: string | null;
  deposit_type?: string | null;
  deposit_amount?: number | null;
  deposit_currency?: string | null;
  delivers?: boolean | null;
  created_at: string;
}

interface ThreadRow {
  vendor_id: string | null;
  fields: {
    fulfillment?: string;
    depositType?: string;
    depositNote?: string;
    language?: ThreadLanguage;
  } | null;
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  // THE ENTITLEMENT, ON THE SERVER SIDE TOO.
  //
  // The re-ask had NO plan gate on either side: the button rendered for any
  // plan whenever `contacted > 0`, and this route checked only the session and
  // the kill switch. FEATURE_META documents `trips-history` as covering exactly
  // this ("re-open and re-engage any earlier search"), and re-engaging is the
  // half that spends the traveller's WhatsApp reputation - so it is the half
  // that most needed the gate.
  const plan = (session.plan ?? "free") as PlanId;
  if (!can(plan, "trips-history")) {
    return NextResponse.json(
      { error: "upgrade-required", feature: "trips-history" },
      { status: 402 }
    );
  }
  if (await killSwitchOn()) {
    return NextResponse.json({ error: "Temporarily paused by the owner." }, { status: 503 });
  }

  const body = await req.json().catch(() => ({}));
  const startMs = Date.parse(String(body.ts ?? ""));
  if (!Number.isFinite(startMs)) {
    return NextResponse.json({ error: "ts (session start) required" }, { status: 400 });
  }
  const enc = encodeURIComponent(session.email);

  // The session window, grouped exactly the way the Trips list groups it, so
  // "this hunt" means the same thing on both sides.
  // `id` and `source` were not even SELECTED here, so this route could not tell
  // a hunt from a request-build and grouped analytics rows as sessions. That is
  // a third way its boundaries drifted from the Trips list's - on top of the
  // duplicated loop and the timestamp match. All three are gone.
  type RecheckRow = {
    id: number;
    source: string | null;
    created_at: string;
    rfq: { durationDays?: number } | null;
  };
  const searches = await sbSelect<RecheckRow>(
    "searches",
    `select=id,source,created_at,rfq&user_email=eq.${enc}&order=created_at.desc&limit=40`
  ).catch(() => [] as RecheckRow[]);
  const groups = groupSearchSessions(searches);
  const sid = Number(body.sid);
  const gi = Number.isFinite(sid)
    ? groups.findIndex((g) => sessionIdOf(g) === sid)
    : groups.findIndex((g) => Math.abs(Date.parse(g[0].created_at) - startMs) < 1000);
  if (gi < 0) return NextResponse.json({ error: "That hunt is no longer available." }, { status: 404 });
  // THE HUNT'S WINDOW, AND IT NOW BOUNDS THE QUERIES AS WELL AS THE FILTER.
  //
  // This route read offers, replies and outbound messages with NO date bound
  // and `limit=200`, newest first, and then filtered them in memory. For an
  // ordinary active traveller (MAX_HUNTS is 20) an older hunt's rows fall
  // outside that 200-row window entirely - so the card offered "Ask if these
  // deals still stand (5)", `contactedInHunt` came out 0, and the answer was
  // "No shops were messaged in that hunt." with HTTP 200, about five shops the
  // traveller could see listed by name on the same card.
  //
  // `huntWindow` is the same object /api/deals builds the card from, and
  // `huntWindowFilter` turns it into the PostgREST bound - so what this route
  // READS and what the card COUNTED can no longer come from different windows.
  const win = huntWindow(groups, gi);
  const bound = (column: string) => huntWindowFilter(column, win, pgTimestamp);

  // A CLEARED HUNT CANNOT BE RE-CHECKED - the clear tombstoned its recipients,
  // so every send this route queued would die at the guard while the response
  // cheerfully reported "Asking N shops". Same gate as restore, same bounds
  // (marker after this group's newest row, before the next group), and STRICT
  // for the same reason: unknown must refuse, not message.
  const groupEndIso = groups[gi][groups[gi].length - 1].created_at;
  const nextGroupIso = gi > 0 ? groups[gi - 1][0].created_at : null;
  const closedRead = await sbSelectStrict<{ received_at: string }>(
    "whatsapp_messages",
    `select=received_at&to_number=eq.session&raw->>sender=eq.${enc}&raw->>kind=eq.session-closed` +
      `&received_at=gt.${encodeURIComponent(groupEndIso)}` +
      (nextGroupIso ? `&received_at=lt.${encodeURIComponent(nextGroupIso)}` : "") +
      `&order=received_at.desc&limit=1`
  );
  if ("error" in closedRead && closedRead.error === "unavailable") {
    return NextResponse.json({ error: "Could not reach your shops just now. Try again." }, { status: 503 });
  }
  if ("rows" in closedRead && closedRead.rows.length) {
    return NextResponse.json({ error: "You cleared this hunt - its shops are no longer messaged." }, { status: 404 });
  }
  const days =
    [...groups[gi]].reverse().find((r) => typeof r.rfq?.durationDays === "number")?.rfq
      ?.durationDays ?? null;

  // Shops we MESSAGED in that window, the last price each of them gave, and
  // the deposit + fulfillment they stated. All three are needed: the deposit
  // and the fulfillment are what make the question "on the same conditions"
  // rather than "how much again?".
  const [outbound, offers, replyTerms, threads] = await Promise.all([
    sbSelect<{
      to_number: string;
      received_at: string;
      raw: { vendorId?: string; vendorName?: string } | null;
    }>(
      "whatsapp_messages",
      `select=to_number,received_at,raw&direction=eq.outbound&raw->>sender=eq.${enc}&to_number=not.in.(session,takeover,cancel)${bound(
        "received_at"
      )}&order=received_at.desc&limit=250`
    ).catch(() => []),
    sbSelect<OfferRow>(
      "offers",
      `select=vendor_id,vendor_name,price_per_day,currency,created_at&user_email=eq.${enc}&simulated=eq.false${bound(
        "created_at"
      )}&order=created_at.desc&limit=250`
    ).catch(() => []),
    // Two column tiers, exactly like /api/replies: an unknown column silently
    // blanks the whole select, and a pre-migration database must degrade to
    // "we do not know the deposit" (which refuses the send) rather than to a
    // crash or, worse, to messaging everyone again.
    (async () => {
      const filter = `user_email=eq.${enc}${bound("created_at")}&order=created_at.desc&limit=250`;
      let rows = await sbSelect<ReplyTermsRow>(
        "vendor_replies",
        `select=vendor_id,vendor_name,deposit,deposit_type,deposit_amount,deposit_currency,delivers,created_at&${filter}`
      );
      if (rows.length === 0) {
        rows = await sbSelect<ReplyTermsRow>(
          "vendor_replies",
          `select=vendor_id,vendor_name,deposit,delivers,created_at&${filter}`
        );
      }
      return rows;
    })().catch(() => [] as ReplyTermsRow[]),
    // The engine's own extracted state. Authoritative for fulfillment, and it
    // carries the thread's PERSISTED language decision (W4.6) - which is why
    // the re-check can finally be localized like every other send path.
    sbSelect<ThreadRow>(
      "negotiation_threads",
      `select=vendor_id,fields&user_email=eq.${enc}&order=updated_at.desc&limit=100`
    ).catch(() => [] as ThreadRow[]),
  ]);

  // Belt to the query's braces: the bound above already fenced every read, and
  // this keeps the in-memory filter reading from the SAME window object.
  const inWindow = (iso: string) => win.contains(iso);

  const priceByVendor = new Map<string, OfferRow>();
  for (const o of offers) {
    const id = o.vendor_id || o.vendor_name;
    if (!id || !inWindow(o.created_at) || priceByVendor.has(id)) continue;
    if (o.price_per_day && o.price_per_day > 0) priceByVendor.set(id, o);
  }
  // Deposit/fulfillment from the replies IN THIS HUNT'S WINDOW - a shop that
  // told us its deposit during some other hunt has not told us about this one.
  const termsByVendor = new Map<string, ReplyTermsRow>();
  for (const r of replyTerms) {
    const id = r.vendor_id || r.vendor_name;
    if (!id || !inWindow(r.created_at)) continue;
    const cur = termsByVendor.get(id);
    // Newest-first: keep the first row that actually says something, so a later
    // bare "ok" does not erase the reply that named the deposit.
    if (!cur || (!cur.deposit && !cur.deposit_type && cur.delivers == null)) {
      termsByVendor.set(id, { ...(cur ?? {}), ...r });
    }
  }
  const threadByVendor = new Map<string, ThreadRow["fields"]>();
  for (const th of threads) {
    if (th.vendor_id && !threadByVendor.has(th.vendor_id)) threadByVendor.set(th.vendor_id, th.fields);
  }

  /** Everything we know about one shop's deal, in the shared shape. */
  const termsFor = (vendorId?: string): DealTerms => {
    if (!vendorId) return {};
    const offer = priceByVendor.get(vendorId);
    const reply = termsByVendor.get(vendorId);
    const th = threadByVendor.get(vendorId);
    return {
      pricePerDay: offer?.price_per_day ?? null,
      currency: offer?.currency ?? null,
      depositType: th?.depositType ?? reply?.deposit_type ?? null,
      depositNote: th?.depositNote ?? null,
      depositLabel: reply?.deposit ?? null,
      depositAmount: reply?.deposit_amount ?? null,
      depositCurrency: reply?.deposit_currency ?? null,
      fulfillment: th?.fulfillment ?? null,
      delivers: reply?.delivers ?? null,
    };
  };

  const targets = new Map<string, { name: string; vendorId?: string }>();
  let contactedInHunt = 0;
  for (const m of outbound) {
    if (!inWindow(m.received_at)) continue;
    const digits = digitsOnly(m.to_number);
    if (digits.length < 6 || targets.has(digits)) continue;
    contactedInHunt += 1;
    // THE FILTER. Price + deposit + how we get the vehicle, or we do not ask.
    if (!termsComplete(termsFor(m.raw?.vendorId))) continue;
    targets.set(digits, { name: m.raw?.vendorName || digits, vendorId: m.raw?.vendorId });
  }
  if (targets.size === 0) {
    return NextResponse.json({
      // Two different silences, said differently - "nobody was messaged" and
      // "nobody gave us full terms" send the traveller to different places.
      error: contactedInHunt
        ? "None of these shops gave a full deal (price, deposit and pick-up), so there is nothing to re-confirm."
        : "No shops were messaged in that hunt.",
      asked: 0,
      contacted: contactedInHunt,
      eligible: 0,
    });
  }

  // Already re-checked today? Do not ask the same shop twice.
  const recent = await sbSelect<{ to_number: string }>(
    "whatsapp_messages",
    `select=to_number&direction=eq.outbound&raw->>sender=eq.${enc}&raw->>kind=eq.recheck&received_at=gte.${encodeURIComponent(
      new Date(Date.now() - RECHECK_WINDOW_MS).toISOString()
    )}&limit=200`
  ).catch(() => []);
  const alreadyAsked = new Set(recent.map((r) => digitsOnly(r.to_number)));

  const { guardOutbound, afterSend } = await import("@/lib/wa-guard");
  const { sendFromUser } = await import("@/lib/evolution");

  let sent = 0;
  let queued = 0;
  let skipped = 0;
  const detail: { name: string; state: "sent" | "queued" | "skipped"; reason?: string }[] = [];

  for (const [digits, info] of targets) {
    if (alreadyAsked.has(digits)) {
      skipped += 1;
      detail.push({ name: info.name, state: "skipped", reason: "already asked today" });
      continue;
    }
    const english = recheckMessage({ ...termsFor(info.vendorId), days });
    // Belt and braces: the composer refuses incomplete terms on its own, so a
    // null here means the filter above and the composer disagreed. Skip, never
    // send a half-stated condition to a shop.
    if (!english) {
      skipped += 1;
      detail.push({ name: info.name, state: "skipped", reason: "terms incomplete" });
      continue;
    }
    // THE THREAD'S LANGUAGE, HONOURED HERE TOO (W4.6/W4.7).
    //
    // This route composed English and handed it straight to guardOutbound -
    // it never imported localizeMessage - so a hunt that had been conducted
    // entirely in Thai got one English message weeks later, from the same
    // number, in the same thread. That is precisely the mid-conversation
    // language flip the whole thread-language lock exists to prevent.
    let text = english;
    let englishGloss: string | undefined;
    const lang = info.vendorId ? threadByVendor.get(info.vendorId)?.language : undefined;
    if (!threadWritesEnglish(lang)) {
      const { threadLanguageMode } = await import("@/lib/wa/thread-language");
      const established = await threadLanguageMode(session.email, digits);
      if (localLanguageAllowed({ requested: established === true, plan })) {
        const { countryForShop } = await import("@/lib/copy/region");
        const { localizeMessage } = await import("@/lib/agents");
        const localized = await localizeMessage(
          english,
          countryForShop(digits),
          session.email,
          true,
          // A re-check is ALWAYS mid-thread - the shop already answered us once
          // with a full deal - so a local greeting here is a repeat greeting.
          { greet: false }
        );
        if (localized.localized && localized.text) {
          text = localized.text;
          englishGloss = localized.english ?? english;
        }
      }
    }
    const meta = {
      kind: "recheck",
      vendorId: info.vendorId ?? null,
      vendorName: info.name,
      ...(englishGloss ? { englishGloss } : {}),
    };
    // auto:true - this is the agent acting on the traveller's behalf, so it
    // must obey every automated-send veto (pause, takeover, cancellation) and
    // be paced like one. queueIfBlocked parks anything held; the outbox drains.
    const guard = await guardOutbound({
      senderKey: session.email,
      toDigits: digits,
      text,
      auto: true,
      queueIfBlocked: true,
      meta,
    });
    if (!guard.allow) {
      if (guard.queuedUntil) {
        queued += 1;
        detail.push({ name: info.name, state: "queued" });
      } else {
        skipped += 1;
        detail.push({ name: info.name, state: "skipped", reason: guard.reason });
      }
      continue;
    }
    // THE MUTEX, ON THIS PATH TOO. guardOutbound's checks are read-then-act by
    // its own documentation and cannot serialize anything; this route used to
    // go straight from the verdict to the wire. It re-asks every shop from a
    // past session at once, so it is precisely the batch most likely to land on
    // a shop the live agent is already mid-sentence with.
    const { claimForSend } = await import("@/lib/wa-guard");
    const claim = await claimForSend(session.email, digits, guard.text, true, true);
    if (!claim.ok) {
      skipped += 1;
      detail.push({
        name: info.name,
        state: "skipped",
        reason:
          claim.kind === "duplicate"
            ? "already going out"
            : "your agent is mid-message with this shop",
      });
      continue;
    }
    const r = await sendFromUser(session.email, digits, guard.text).catch(() => ({
      ok: false,
      error: "send failed",
      ambiguous: false,
    }));
    if (r.ok) {
      sent += 1;
      await afterSend(session.email, digits);
      await sbInsert("whatsapp_messages", [
        {
          to_number: digits,
          body: guard.text,
          type: "text",
          direction: "outbound",
          raw: { channel: "personal-wa", sender: session.email, ok: true, ...meta },
        },
      ]).catch(() => {});
      detail.push({ name: info.name, state: "sent" });
    } else {
      // Release the idempotency claim on failure, or a failed recheck to a shop
      // is refused as a duplicate for the whole 72h claim-GC horizon (every
      // sibling direct-send path releases; this one leaked it). An AMBIGUOUS
      // status-0 timeout keeps the claim - it may have landed.
      if (!("ambiguous" in r && r.ambiguous)) {
        const { releaseSendClaim } = await import("@/lib/wa-guard");
        await releaseSendClaim(session.email, digits, guard.text).catch(() => {});
      }
      skipped += 1;
      detail.push({ name: info.name, state: "skipped", reason: r.error });
    }
  }

  return NextResponse.json({
    asked: sent + queued,
    sent,
    queued,
    skipped,
    /** How many shops were messaged in the hunt at all, and how many of those
     *  had a full deal to re-confirm - so the UI can say WHY it asked few. */
    contacted: contactedInHunt,
    eligible: targets.size,
    detail: detail.slice(0, 40),
  });
}
