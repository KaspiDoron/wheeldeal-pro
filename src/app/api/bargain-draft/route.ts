import { NextResponse } from "next/server";
import { composeBargain, runSafety } from "@/lib/agents";
import { getSession } from "@/lib/session";
import { sbInsert, sbSelect } from "@/lib/runtime-config";
import type { Vendor, StructuredRFQ } from "@/lib/types";
import { digitsOnly } from "@/lib/phone";
import { can, localLanguageAllowed } from "@/lib/entitlements";
import { beatRivalTarget } from "@/lib/negotiation/beat-rival";

// Adaptive Bargaining Agent: composes the next negotiation message to send.
// This is the SAME brain the automatic funnel uses - market-floor anchored
// target, cross-shop rival leverage from the user's own session, and the real
// thread history so it never re-asks something the shop already answered.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body?.vendor || !body?.rfq) {
    return NextResponse.json({ error: "vendor and rfq required" }, { status: 400 });
  }

  // Local-language street bargaining is an Ultra perk (management included).
  //
  // Named for what it CHECKS, not for the tier that currently satisfies it.
  // `isUltra` was a feature check wearing a tier's name, which is how a second
  // surface ends up hardcoding `plan === "ultra"` to "match" it.
  const wantsLocal = body.language === "local";
  const localAllowed = localLanguageAllowed({ requested: true, plan: session.plan });
  if (wantsLocal && !localAllowed) {
    return NextResponse.json(
      {
        error: "Bargaining in the shop's local language is an Ultra feature.",
        upgrade: true,
      },
      { status: 403 }
    );
  }

  let rfq = body.rfq as StructuredRFQ;
  const vendor = body.vendor as Vendor;
  const region: string | undefined = body.region || undefined;
  const quoted: number | undefined = body.currentPricePerDay;
  // THE SHARED SERVER CURRENCY CHAIN (F094).
  //
  // This route kept its own region-only lookup with a USD default, and
  // `currencyForRegion` is a country-token regex that matches nothing in the
  // labels the geocoder actually leaves behind ("My current location", a raw
  // "8.0000, 98.0000" pin). So tapping Push harder on a +66 shop composed a
  // DOLLAR ask, the server-authoritative rival lookup filtered `offers` by
  // `currency=eq.USD` while every row in the hunt is stamped THB, and the
  // market-floor gate below dropped the floor too. `resolveLocalCurrency` is
  // the same order the engine uses - region label, then the SHOP'S PHONE
  // PREFIX, then undefined. Never "USD": a currency we cannot resolve is a
  // number without a symbol, not dollars. (Async and dynamic-import backed, so
  // it stays on this interactive draft route - the reply path and the drain
  // resolve their own currency already.)
  const { resolveLocalCurrency } = await import("@/lib/local-currency");
  const cur = await resolveLocalCurrency({
    region,
    shopDigits: digitsOnly(String(vendor.whatsapp ?? "")),
  });

  // SERVER-AUTHORITATIVE DURATION (owner report 5 #7). The draft composed from
  // the CLIENT's live rfq with no reconciliation, then the send re-stamped that
  // rfq onto the outbound row - so tapping Bargain on a thread opened for 1 day
  // minted a fresh 3-day anchor and the agent started quoting a duration this
  // shop had never been asked about. The same promise the inbound path enforces
  // now governs the draft: the opener is what the shop was actually told.
  {
    const digits = digitsOnly(String(vendor.whatsapp ?? ""));
    const { promisedRfq } = await import("@/lib/wa/thread-context");
    const settled = await promisedRfq(digits, session.email, rfq);
    if (settled.rfq) rfq = settled.rfq;
    if (settled.drifted) {
      // Never silent: a drift means some other surface wrote an rfq into this
      // thread, and the owner can see it in the events trail.
      await sbInsert("agent_events", [
        {
          kind: "rfq-drift",
          user_email: session.email,
          vendor_id: String(vendor.id ?? ""),
          vendor_name: String(vendor.name ?? ""),
          to_number: digits,
          detail: `Bargain draft asked for ${
            (body.rfq as StructuredRFQ)?.durationDays
          } days; the thread was opened for ${rfq.durationDays}. Composed on the promise.`,
        },
      ]).catch(() => {});
    }
  }

  // SERVER-AUTHORITATIVE LANGUAGE (owner report 5 #14). This route used to
  // trust body.language verbatim while the modal invented its own default
  // (`isUltra ? "local" : "english"`) - so an English-only hunt composed its
  // FIRST draft in Thai. The send path (/api/outreach) already resolves the
  // thread's established mode and lets it win; the draft path now runs the
  // identical resolution, so what the traveller reviews is what would send.
  let composeLocal = wantsLocal && localAllowed;
  try {
    const digits = digitsOnly(String(vendor.whatsapp ?? ""));
    if (digits) {
      const { threadLanguageMode, resolveThreadLanguage } = await import(
        "@/lib/wa/thread-language"
      );
      const established = await threadLanguageMode(session.email, digits);
      composeLocal = resolveThreadLanguage({
        requested: localLanguageAllowed({ requested: wantsLocal, plan: session.plan }),
        established,
      }).localLang;
    }
  } catch {
    /* resolution is a guard - the entitlement gate above has already run */
  }

  // ONE MOVE PER HUMAN BEAT: inside the user-move window a second tap gets the
  // SAME draft back, not a freshly-worded one. Every dedupe downstream keys on
  // exact text - a re-composed draft is a new string by construction, which is
  // precisely how "Push harder" tapped twice put two near-identical bargains
  // into one shop's chat. Returning the last draft verbatim restores the
  // exact-text dedupe's power over the whole tap-again path.
  try {
    const { USER_MOVE_WINDOW_SEC } = await import("@/lib/wa/turn-lock");
    const since = new Date(Date.now() - USER_MOVE_WINDOW_SEC * 1000).toISOString();
    const recent = await sbSelect<{ tactic: string | null; message: string | null }>(
      "bargain_drafts",
      `select=tactic,message&user_email=eq.${encodeURIComponent(
        session.email
      )}&vendor_id=eq.${encodeURIComponent(String(vendor.id ?? ""))}&created_at=gte.${encodeURIComponent(
        since
      )}&order=created_at.desc&limit=1`
    );
    if (recent[0]?.message) {
      return NextResponse.json({
        message: recent[0].message,
        tacticId: recent[0].tactic ?? "reused",
        reused: true,
      });
    }
  } catch {
    /* reuse is a guard, never a blocker - fall through to a fresh compose */
  }

  // Market floor: the same anchor the automatic agent uses, so the manual
  // Bargain button never proposes a weak or absurd number.
  let floorPrice: number | undefined;
  try {
    const { floorPriceFor } = await import("@/lib/market");
    // The floor is asked for in the currency of record, so the gate below can
    // actually pass for a country-less label (F094/F095).
    const floor = await floorPriceFor(region, rfq, { currency: cur });
    if (floor && cur && floor.currency === cur) floorPrice = floor.floor;
  } catch {
    /* floor is an enhancement, never a blocker */
  }

  // Cross-shop leverage: the user's best OTHER offer for the same vehicle in
  // this session.
  //
  // THE SERVER OWNS THIS NUMBER (owner report 5 #2). It used to be seeded from
  // `body.rivalPricePerDay` - a figure posted by the BROWSER - which the server
  // could then only LOWER (`Math.min`), never replace and never reject. The
  // client-side selector applies three fewer filters than the server one (no
  // vehicle class, no search session, no "strictly cheaper than this shop's
  // quote"), and when this shop had no quote yet the server check was skipped
  // entirely and the client's number went into the prompt unexamined. So the
  // one number the agent is forbidden to soften could arrive from the least
  // trustworthy source in the system.
  //
  // Now: the server lookup is the ONLY source. The client hint is used for
  // exactly one thing - noticing that it disagrees, which is worth an event.
  let rival: number | undefined;
  let rivalDerivedFromDays: number | undefined;
  const clientHint = Number(body.rivalPricePerDay);
  try {
    // No currency of record means no like-for-like comparison: a rival row is
    // only leverage when we know both quotes are in the same money (F094).
    if (quoted && cur) {
      const { vehicleKeyFor } = await import("@/lib/market");
      const { cheapestRivalQuoteFor } = await import("@/lib/search-session");
      const server = await cheapestRivalQuoteFor(session.email, {
        vendorId: String(vendor.id ?? ""),
        currency: cur,
        vehicleKey: vehicleKeyFor(rfq),
        belowPrice: quoted,
        // Duration-aware: a per-day divided out of someone's 3-day package is
        // not a like-for-like rival for a 1-day rental.
        durationDays: rfq.durationDays,
      });
      if (server) {
        rival = server.pricePerDay;
        rivalDerivedFromDays = server.derivedFromDays;
      }
    }
  } catch {
    /* leverage is an enhancement */
  }
  if (Number.isFinite(clientHint) && clientHint > 0 && clientHint !== rival) {
    // Never silent: the client believed something the server could not verify,
    // and the owner can see the divergence in the events trail.
    await sbInsert("agent_events", [
      {
        kind: "rival-hint-ignored",
        user_email: session.email,
        vendor_id: String(vendor.id ?? ""),
        vendor_name: String(vendor.name ?? ""),
        detail: `Client posted a rival of ${clientHint}; the server-authoritative rival is ${
          rival ?? "none"
        }. Composed on the server's.`,
      },
    ]).catch(() => {});
  }

  // Thread history: what we and the shop already said - the draft must never
  // repeat an answered question.
  //
  // PRIVACY holds: both directions are filtered to THIS user in JS below
  // (outbound by sender, inbound by receiver), so no other user's message can
  // ever reach the prompt. There is no leak here and never was.
  //
  // WHAT WAS BROKEN IS THE LIMIT'S POSITION. The comment above this block used
  // to claim the SQL filtered by user; it did not. `limit=20` was applied to a
  // query whose only predicate is `vendorId OR from_number` - and the comment
  // itself explains why that is cross-user: a Google place id is shared by
  // every traveller, and so is a shop's number. For any shop several people are
  // talking to, the newest 20 rows are mostly other users', `mine` comes back
  // empty, and the bargaining prompt loses the traveller's own history - so the
  // agent re-asks questions the shop already answered, which is the exact
  // failure this block exists to prevent. It degrades silently, and gets worse
  // the more popular the shop is.
  //
  // Scoping the SQL to this user makes the 20 rows THEIR 20 rows. Both arms of
  // the OR are still needed (outbound rows carry vendorId; inbound rows are
  // matched by the shop's number), so the ownership predicate is expressed as a
  // second OR over the two directional stamps rather than one column.
  let history: string | undefined;
  try {
    const digits = digitsOnly(String(vendor.whatsapp ?? ""));
    const me = encodeURIComponent(session.email);
    const out = await sbSelect<{
      direction: string;
      body: string | null;
      raw: { sender?: string; receiver?: string } | null;
    }>(
      "whatsapp_messages",
      `select=direction,body,raw&or=(raw->>vendorId.eq.${encodeURIComponent(
        String(vendor.id ?? "")
      )},from_number.eq.${encodeURIComponent(digits || "none")})` +
        `&or=(raw->>sender.eq.${me},raw->>receiver.eq.${me})` +
        `&order=received_at.desc&limit=20`
    );
    // The JS filter stays. It is stricter than the SQL (it pairs the stamp with
    // the DIRECTION), and it is the guarantee - the query is an optimisation.
    const mine = out.filter((m) =>
      m.direction === "inbound"
        ? m.raw?.receiver === session.email
        : m.raw?.sender === session.email
    );
    if (mine.length) {
      history = mine
        .slice(0, 10)
        .reverse()
        .map((m) => `${m.direction === "outbound" ? "Us" : "Shop"}: ${(m.body ?? "").slice(0, 250)}`)
        .join("\n");
    }
  } catch {
    /* history is an enhancement */
  }

  // Target: strictly UNDER the rival when we have one, floor-clamped.
  //
  // BEAT, NEVER MATCH (owner report 5 #2). This was `Math.min(quoted*0.85,
  // rival)` under a `Math.max(floor, ...)` - so a rival at or below the 15% cut
  // became the target EXACTLY, and a floor above the rival pushed the ask to or
  // past it. Both outcomes ask a shop to match, and the best a match can win the
  // traveller is the price they already had. `beatRivalTarget` owns the rule.
  const target =
    quoted === undefined
      ? undefined
      : rival
        ? beatRivalTarget({ rivalPricePerDay: rival, quotePerDay: quoted, floorPerDay: floorPrice })
        : Math.max(floorPrice ?? 0, Math.round(quoted * 0.85));

  const draft = await composeBargain({
    rfq,
    vendor,
    currentPricePerDay: quoted,
    rivalPricePerDay: rival,
    rivalDerivedFromDays,
    region,
    round: Math.max(0, Number(body.round ?? 0)),
    currency: cur,
    localLanguage: composeLocal,
    targetPricePerDay: target,
    floorPricePerDay: floorPrice,
    history,
    voiceKey: session.email,
  });

  // Safety-screen even our own composed drafts before they can be sent.
  const verdict = await runSafety(draft.message);
  if (!verdict.allowed) {
    return NextResponse.json(
      { error: "Draft failed the safety screen - try again." },
      { status: 500 }
    );
  }

  // THE DRAFT PATH HAD NO NUMERIC RAIL AT ALL (owner report 5 #2).
  //
  // `runSafety` above is a blocklist plus a tone judge - it has no idea what a
  // price is. Every money guarantee in this product (fabricated rival, ask
  // below the floor, an inverted ask ABOVE the shop's own quote, and the
  // provenance rule that every price-scale numeral be a number this thread
  // actually holds) lived on the SPTE path only, and this is the route the
  // traveller reaches by tapping Bargain. Same rail, same rules; a draft that
  // fails is not shown, because a number we cannot verify is a number we do not
  // send. Numbers-only, so the phrasing rails (commitment, farewell) that need
  // a full SPTE turn context stay where they are.
  {
    const { checkOutboundNumbers } = await import("@/lib/graph/guardrails");
    const { citesAMatch } = await import("@/lib/negotiation/beat-rival");
    const check = checkOutboundNumbers({
      text: draft.message,
      ceiling: quoted,
      floor: floorPrice,
      rivalPrice: rival,
      rivalPrices: rival ? [rival] : [],
      excludeExact: [rfq.durationDays, rfq.engineSizeCc ?? 0].filter(Boolean) as number[],
      grounded: [quoted, floorPrice, rival, target].filter(
        (n): n is number => typeof n === "number" && n > 0
      ),
      durationDays: rfq.durationDays,
      checkAskBounds: true,
    });
    // BEAT, NEVER MATCH holds here too - the live "Could you match the 200
    // THB/day offer" was composed by this very function.
    const matched = citesAMatch(draft.message);
    if (!check.ok || matched) {
      await sbInsert("agent_events", [
        {
          kind: "bargain-draft-rejected",
          user_email: session.email,
          vendor_id: String(vendor.id ?? ""),
          vendor_name: String(vendor.name ?? ""),
          detail: matched
            ? `beat-not-match: the draft asked the shop to match ("${matched.phrase}")`
            : `${check.violation ?? "numbers"}: ${check.detail ?? ""}`,
        },
      ]).catch(() => {});
      return NextResponse.json(
        { error: "Draft failed the price-integrity check - try again." },
        { status: 500 }
      );
    }
  }

  await sbInsert("bargain_drafts", [
    {
      user_email: session.email,
      vendor_id: String(vendor.id ?? ""),
      tactic: draft.tacticId,
      message: draft.message,
    },
  ]);

  // The language the draft was ACTUALLY composed in, so the modal can reflect
  // reality when the server overrode the request (thread already in English,
  // hunt not local, plan not entitled).
  return NextResponse.json({ ...draft, languageUsed: composeLocal ? "local" : "english" });
}

// maxDuration: lift the request-timeout ceiling for slow AI upstreams.
export const maxDuration = 60;
