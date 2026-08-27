import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { sbSelect, sbSelectStrict } from "@/lib/runtime-config";
import { identityKey } from "@/lib/wa/phone-key";
import { clampSince } from "@/lib/session-life";
import { searchSessionTtlMs } from "@/lib/session-life-config";
import { languageSwitchNotice } from "@/lib/wa/thread-language";
import { termsComplete } from "@/lib/deal-terms";
import { effectivePriceFor } from "@/lib/effective-price";

// A live poll - never statically cached, or new shop offers stop popping in.
export const dynamic = "force-dynamic";

// Live feed of the signed-in user's vendor replies (auto-ingested by the
// WhatsApp webhook or added manually). The app polls this while agents are
// waiting on shops, so confirmed offers pop into the cards by themselves and
// the traveller never leaves the app.
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  // ATOMIC SESSION: the client passes the epoch its current search started at;
  // only replies created since then belong to this session. This is what stops
  // a previous search's offers/threads from resurfacing on a new search.
  //
  // AND THE EPOCH IS CLAMPED. It arrives from the client, and a client that had
  // auto-restored a week-old hunt used to send a week-old epoch - so this route
  // happily returned a week of replies as "this session". Clamping to the
  // search-session TTL is the server-side backstop; `0` (no session yet) still
  // means "no lower bound from me", which the filters below already handle.
  const params = new URL(req.url).searchParams;
  const rawSince = Number(params.get("since") ?? 0);
  const sinceMs =
    rawSince > 0 ? clampSince(rawSince, Date.now(), await searchSessionTtlMs()) : 0;
  // THE DECLARED SPEC scopes the option menu. The traveller asked for one
  // vehicle and declared a licence for that class; a shop's full price board
  // must never become a list of things to pick. Narrowing-only, and the engine
  // re-derives the same scope server-side from the real RFQ for anything it
  // actually negotiates, so a tampered value can only show the sender more rows.
  const specCc = Number(params.get("cc") ?? 0);
  const specDays = Number(params.get("days") ?? 0);
  const specClass = params.get("vclass");
  const specTx = params.get("tx");
  const sinceFilter =
    sinceMs > 0
      ? `&created_at=gte.${encodeURIComponent(new Date(sinceMs).toISOString())}`
      : "";

  // Reliability core: reconcile replies the webhook may have MISSED (the
  // Evolution host can be restarting exactly when a shop answers). Throttled
  // to one real pull per user per ~25s, so most polls skip it instantly.
  try {
    const { syncInboundReplies } = await import("@/lib/wa-sync");
    await syncInboundReplies(session.email);
  } catch {
    /* the DB feed below still answers */
  }
  // Any user activity also flushes due queued messages (no dedicated worker).
  //
  // SCOPED TO THIS TRAVELLER, AND BOUNDED. This is the 8-SECOND poll - the
  // most frequent request the app makes - and both drains ran GLOBALLY with no
  // time budget: `drainOutbox()` with no sender filter executed OTHER USERS'
  // real WhatsApp sends, and `drainGraphWakeups()` ran up to 24 other users'
  // multi-agent LLM composes, inside one traveller's poll. The two sibling
  // routes that do the same job (/api/activity, /api/wa/status) have bounded
  // theirs at 8s for exactly this reason; this one was missed.
  //
  // The consequences compound: work that outran the 8s interval stacked poll on
  // poll, one user's slow Evolution host stalled a stranger's feed, and the
  // per-user pacing state was being advanced by a request that had nothing to
  // do with that user. Scope, then bound - a slow host can now only delay the
  // person it belongs to, and only for one interval.
  //
  // Rows belonging to signed-out users are not orphaned by this: the heartbeat
  // (Cloud Scheduler -> /api/wa/ping) drains globally, which is the job of a
  // worker rather than of somebody else's poll.
  try {
    // ONE DRAIN OWNER PER CYCLE (E2/L2): this poll and its siblings all
    // drained the same queue back-to-back, and the app's most frequent
    // request could wait 16s on a slow host before answering. The claim
    // makes roughly every third poll pay the drain; the rest answer at
    // payload speed. The webhook tail + heartbeat still drain on their own.
    const { claimDrainSlot } = await import("@/lib/wa/drain-owner");
    if (claimDrainSlot(session.email)) {
      const { drainOutbox } = await import("@/lib/wa-guard");
      const { sendFromUser } = await import("@/lib/evolution");
            // 3s, not 8s. This budget is applied TWICE per drain-owning poll (outbox
      // then wakeups), so 8s meant one poll could hold a Cloud Run concurrency
      // slot for 16 seconds. At 50 users x ~3 drain windows a minute that is
      // ~40 slots held against a --concurrency of 32 - i.e. the polls alone
      // force a second instance that does nothing but wait. The minute-cron and
      // reply-tick already cover the queue; this budget is opportunistic help,
      // not the delivery mechanism.
      const DRAIN_BUDGET_MS = 3_000;
      const bounded = <T,>(p: Promise<T>) =>
        Promise.race([p, new Promise((r) => setTimeout(r, DRAIN_BUDGET_MS))]);
      await bounded(
        drainOutbox((senderKey, to, text, lane) => sendFromUser(senderKey, to, text, true, { lane }), {
          senderKey: session.email,
        }).catch((e) => console.error("[drain:outbox]", e instanceof Error ? e.message : e))
      );
      const { drainGraphWakeups } = await import("@/lib/graph/engine");
      await bounded(
        drainGraphWakeups((senderKey, to, text, lane) => sendFromUser(senderKey, to, text, true, { lane }), {
          userEmail: session.email,
        }).catch((e) => console.error("[drain:wakeups]", e instanceof Error ? e.message : e))
      );
    }
  } catch (e) {
    console.error("[drain:init]", e instanceof Error ? e.message : e);
  }

  interface ReplyRow {
    id: number;
    vendor_id: string;
    vendor_name: string;
    reply_text: string;
    english_gloss?: string | null;
    found: boolean;
    price_per_day: number | null;
    matches_spec: boolean;
    confidence: string;
    auto: boolean;
    currency?: string | null;
    deposit?: string | null;
    deposit_type?: string | null;
    deposit_amount?: number | null;
    deposit_currency?: string | null;
    delivers?: boolean | null;
    insurance_included?: boolean | null;
    delivery_fee?: number | null;
    created_at: string;
  }
  const filter = `user_email=eq.${encodeURIComponent(session.email)}${sinceFilter}&order=created_at.desc&limit=40`;
  // english_gloss (W1.5) rides in the FIRST tier only - the degrade tiers
  // below keep the feed alive before the owner runs the newest schema.
  //
  // STRICT, NOT SILENT (L3): sbSelect collapses a missing-column 400 and a
  // genuinely empty feed into the same [], so every tick of every user with
  // no replies yet re-ran all three tiers - 3x the queries, forever, and no
  // signal if the schema ever actually regressed. sbSelectStrict tells the
  // two apart: the ladder now steps down ONLY on a real schema error.
  let rows: ReplyRow[] = [];
  const tier1 = await sbSelectStrict<ReplyRow>(
    "vendor_replies",
    `select=id,vendor_id,vendor_name,reply_text,english_gloss,found,price_per_day,matches_spec,confidence,auto,currency,deposit,deposit_type,deposit_amount,deposit_currency,delivers,insurance_included,delivery_fee,created_at&${filter}`
  );
  if ("rows" in tier1) {
    rows = tier1.rows;
  } else {
    const tier2 = await sbSelectStrict<ReplyRow>(
      "vendor_replies",
      `select=id,vendor_id,vendor_name,reply_text,found,price_per_day,matches_spec,confidence,auto,currency,deposit,delivers,created_at&${filter}`
    );
    if ("rows" in tier2) {
      rows = tier2.rows;
    } else {
      rows = await sbSelect<ReplyRow>(
        "vendor_replies",
        `select=id,vendor_id,vendor_name,reply_text,found,price_per_day,matches_spec,confidence,auto,created_at&${filter}`
      );
    }
  }

  // Merge the digraph engine's per-thread state so the card can show the
  // fulfillment chip (delivery / pickup / on-shop), whether the deal is
  // complete enough to PRESENT, and the pickup-consent status. Best-effort:
  // before the migration this returns [] and the feed behaves exactly as
  // before (offers show immediately).
  interface ThreadRow {
    vendor_id: string | null;
    fields: {
      fulfillment?: string;
      depositType?: string;
      depositNote?: string;
      pricePerDay?: number;
      pickupOffered?: boolean;
      pickupConsent?: boolean;
      declined?: boolean;
      shopUnavailable?: boolean;
      restockHint?: string;
      vehicleConfirmation?: { status?: string; evidence?: string };
      // WHAT THE SHOP SAID ABOUT EACH EXTRA. Written by the accessory pass
      // after each inbound turn; the card renders one chip per requested item.
      accessories?: import("@/lib/thread/accessories").AccessoryStatus[];
      // A substitution the shop offered, waiting on the traveller. While this
      // is set the thread is PAUSED, not closed - see vehicle/substitution.ts.
      alternativeOffer?: import("@/lib/vehicle/substitution").AlternativeOffer | null;
      // THE SHOP ASKED TO TALK BY PHONE (K7). Model-read post-turn; the card
      // quotes their own words instead of the request scrolling past unseen.
      wantsCall?: import("@/lib/types").CallIntentFact | null;
      // THE AGENT IS NOT SURE AND HAS ASKED (W4.4). A thread paused on a
      // confirming question looks identical to an idle one from outside, and
      // "your agent is asking for a price" is simply false while it is waiting
      // to hear whether the deposit is a passport OR the cash.
      awaitingConfirmation?: { subject?: string; question?: string; at?: string };
      // W4.6 - WHICH LANGUAGE THIS THREAD IS IN, AND WHY. Until now no language
      // decision reached the traveller anywhere: the localize trace stage is
      // filtered out of the feed, `localize-fallback` is not in its allow-list,
      // and the one "override" signal that was computed is discarded by its
      // caller. The owner asked for the opposite - "present the user in the
      // status panel and the card map/vendor card that we switched to English
      // because they are not speaking the local language".
      language?: import("@/lib/wa/thread-language").ThreadLanguage;
    } | null;
  }
  const threads = await sbSelect<ThreadRow>(
    "negotiation_threads",
    `select=vendor_id,fields&user_email=eq.${encodeURIComponent(
      session.email
    )}&order=updated_at.desc&limit=40`
  ).catch(() => [] as ThreadRow[]);
  const stateByVendor = new Map<string, ThreadRow["fields"]>();
  for (const th of threads) {
    if (th.vendor_id && !stateByVendor.has(th.vendor_id)) stateByVendor.set(th.vendor_id, th.fields);
  }
  // ONE PREDICATE, SHARED (W6.1). This was a local closure - unexported and
  // therefore unreachable - while the Trips re-check, which the owner scoped to
  // exactly "price, deposit and how we get the vehicle", had no way to ask the
  // question and messaged every shop it had ever contacted. See lib/deal-terms.
  const isComplete = (f: ThreadRow["fields"], depositLabel?: string | null) =>
    termsComplete({
      pricePerDay: f?.pricePerDay ?? null,
      depositType: f?.depositType ?? null,
      depositNote: f?.depositNote ?? null,
      depositLabel: depositLabel ?? null,
      fulfillment: f?.fulfillment ?? null,
    });

  // THE SHOP'S MENU, for the card. A reply naming more than one price is a
  // CHOICE ("some models 200 and some new 250/day"), and showing only the one
  // number the app happened to pick is how the 200 tier disappeared from the
  // traveller's screen entirely.
  //
  // Derived from the conversation, exactly as the engine derives it
  // (src/lib/offer-options.ts) - so there is one definition, no column to add,
  // and nothing that can go stale against the thread it came from. Deliberately
  // NOT a new select on this route: `rows` above degrades through three column
  // tiers, and an unknown column silently blanks the whole feed.
  //
  // ONE extra query for every inbound body in this session, scoped by the same
  // `raw->>receiver` predicate /api/thread uses (the privacy keystone), then
  // grouped per shop in memory.
  const optionsByVendor = new Map<string, import("@/lib/types").VehicleOption[]>();
  /** vendorId -> prices read off the shop's PHOTOGRAPHED board (raw.reading).
   *  These are already persisted and already used as rival leverage in OTHER
   *  shops' negotiations - but no card-facing route ever read them, which is
   *  how a priced menu photo coexisted with "No price yet" on its own card. */
  const readingPricesByVendor = new Map<string, import("@/lib/media/reading").ReadPrice[]>();
  /** vendorId -> the shop's own words when they asked where the traveller is. */
  const askedLocationByVendor = new Map<string, string>();
  try {
    const { optionsFromThread } = await import("@/lib/offer-options");
    const numberByVendor = new Map<string, string>();
    for (const r of rows) if (r.vendor_id) numberByVendor.set(r.vendor_id, "");
    // `reading:raw->reading` is a JSON-path projection on a column every deploy
    // has, so it degrades to null on rows without media - never a blanked feed.
    // NEWEST 200, NOT OLDEST 200.
    //
    // This asked for `received_at.asc LIMIT 200` - the FIRST two hundred inbound
    // messages of the session. Every message after that was invisible to this
    // block for the rest of the hunt, and this block is where the card's price
    // MENU and the shop's "where are you staying?" question come from. So on any
    // session busy enough to cross two hundred inbound messages - a 24-shop
    // batch answering, plus photo bursts, reaches it easily - both froze on
    // early chatter: a menu the shop had since revised, and a location question
    // that had already been answered, pinned to the card permanently.
    //
    // Asked newest-first and reversed back into arrival order, because both
    // consumers below are order-sensitive: `optionsFromThread` reads a
    // conversation forwards, and the location scan walks backwards from the end
    // to find the shop's LATEST asking.
    const inboundDesc = await sbSelect<{
      from_number: string;
      body: string;
      reading?: { prices?: import("@/lib/media/reading").ReadPrice[] } | null;
    }>(
      "whatsapp_messages",
      `select=from_number,body,reading:raw->reading&direction=eq.inbound&raw->>receiver=eq.${encodeURIComponent(
        session.email
      )}${
        sinceMs > 0
          ? `&received_at=gte.${encodeURIComponent(new Date(sinceMs).toISOString())}`
          : ""
      }&order=received_at.desc&limit=200`
    ).catch(() => []);
    const inbound = [...inboundDesc].reverse();
    // Keyed by IDENTITY, not by the raw string. Inbound rows carry WhatsApp's
    // spelling and outbound rows carry discovery's; joining the two on the raw
    // text silently matched nothing, so a shop's option menu and its
    // "where are you staying?" never reached the card.
    const bodiesByNumber = new Map<string, string[]>();
    const readingsByNumber = new Map<string, import("@/lib/media/reading").ReadPrice[]>();
    for (const m of inbound) {
      if (!m.from_number) continue;
      const key = identityKey(m.from_number);
      if (!key) continue;
      if (m.body) {
        const arr = bodiesByNumber.get(key) ?? [];
        arr.push(m.body);
        bodiesByNumber.set(key, arr);
      }
      if (Array.isArray(m.reading?.prices) && m.reading.prices.length) {
        const arr = readingsByNumber.get(key) ?? [];
        // Newest photo wins per vehicle label later; keep arrival order here.
        arr.push(...m.reading.prices.filter((p) => Number(p?.pricePerDay) > 0));
        readingsByNumber.set(key, arr);
      }
    }
    // vendor_id -> the digits we actually messaged, via this user's outbound rows.
    // Project ONLY raw->>vendorId, never the whole `raw` jsonb (OR11 E2.1). This
    // read runs on a 6-second poll over up to 200 rows; shipping the full blob
    // (message payload, reading, lid, ...) to extract one string was the single
    // biggest un-trimmed egress left after OR8-A7. Same JSON-path projection the
    // reading read above already uses.
    const out = await sbSelect<{ to_number: string; vendorId: string | null }>(
      "whatsapp_messages",
      `select=to_number,vendorId:raw->>vendorId&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
        session.email
      )}&order=received_at.desc&limit=200`
    ).catch(() => []);
    for (const o of out) {
      const vid = o.vendorId;
      if (vid && o.to_number && !numberByVendor.get(vid)) numberByVendor.set(vid, o.to_number);
    }
    const { shopAskedLocation } = await import("@/lib/wa/detectors");
    for (const [vendorId, digits] of numberByVendor) {
      if (digits) {
        const reads = readingsByNumber.get(identityKey(digits));
        if (reads?.length) readingPricesByVendor.set(vendorId, reads);
      }
      const bodies = digits ? bodiesByNumber.get(identityKey(digits)) : undefined;
      if (!bodies?.length) continue;
      const opts = optionsFromThread(bodies, {
        vehicleClass:
          specClass === "car" || specClass === "scooter" || specClass === "motorbike"
            ? specClass
            : undefined,
        engineSizeCc: specCc > 0 ? specCc : undefined,
        transmission: specTx === "automatic" || specTx === "manual" ? specTx : undefined,
      });
      // A SINGLE option is still a price (D2): the old `>= 2` gate kept a
      // shop that named exactly one model with one price on "No price yet".
      if (opts.length >= 1) optionsByVendor.set(vendorId, opts);
      // Did this shop ASK where the traveller is? Same rows, no extra query.
      // We keep their own wording so the card can say WHY they want it rather
      // than guessing on the traveller's behalf.
      for (let i = bodies.length - 1; i >= 0; i--) {
        if (shopAskedLocation(bodies[i])) {
          askedLocationByVendor.set(vendorId, bodies[i].slice(0, 180));
          break;
        }
      }
    }
  } catch {
    /* the menu is an enrichment - a failure must never blank the feed */
  }

  // THE VEHICLE-IDENTITY GATE, derived per reply rather than stored.
  //
  // Two live threads reached the card as "BEST PRICE ₱400" for a 110cc when the
  // traveller had declared a 125. `matches_spec` could not catch it: nothing
  // had ever paired the price with the vehicle beside it, and an unnamed
  // vehicle defaulted to "must be theirs". src/lib/vehicle pairs them, and its
  // verdict travels to the client so no surface can present an unconfirmed
  // price as a deal. Derived from the reply text the row already holds, so
  // there is no column to add and nothing to migrate or keep in sync.
  const declaredSpec = {
    class:
      specClass === "car" || specClass === "scooter" || specClass === "motorbike"
        ? (specClass as "car" | "scooter" | "motorbike")
        : undefined,
    displacementCc: specCc > 0 ? specCc : undefined,
    transmission:
      specTx === "automatic" || specTx === "manual" ? (specTx as "automatic" | "manual") : undefined,
  };
  const { assessPrice } = await import("@/lib/vehicle/resolution");
  const { amountIndexIn } = await import("@/lib/wa/rate-expr");
  const gateFor = (text: string | null, price: number | null) => {
    if (!text || !price || price <= 0) return null;
    if (!declaredSpec.class && !declaredSpec.displacementCc && !declaredSpec.transmission) return null;
    try {
      const a = assessPrice(text, declaredSpec, {
        pricePerDay: price,
        index: amountIndexIn(text, price),
      });
      return { status: a.status, note: a.travellerNote };
    } catch {
      return null;
    }
  };

  return NextResponse.json({
    replies: rows.map((r) => {
      const st = stateByVendor.get(r.vendor_id);
      const fulfillment =
        st?.fulfillment === "pickup" || st?.fulfillment === "delivery" || st?.fulfillment === "on-shop"
          ? st.fulfillment
          : r.delivers === true
          ? "delivery"
          : undefined;
      // THREAD state outranks per-row derivation - except a positively WRONG
      // vehicle, which stays wrong per row. The field failure this closes: the
      // shop confirms the vehicle once, then sends "1100b./6days"; the per-row
      // gate re-judges that text alone as unconfirmed and the card freezes on
      // the old price. What the conversation established travels with every
      // later row.
      // THE EFFECTIVE PRICE - every place the app already knows a price for
      // this shop, consulted in trust order, when the row itself carries none.
      // ONE shared resolver (src/lib/effective-price.ts, D2) so Trips and this
      // feed can never disagree about what price the app knows for a shop.
      const effectivePrice = effectivePriceFor({
        found: Boolean(r.found),
        rowPrice: r.price_per_day,
        rowCurrency: r.currency ?? null,
        threadPrice: st?.pricePerDay ?? null,
        boardPrices: readingPricesByVendor.get(r.vendor_id) ?? null,
        options: optionsByVendor.get(r.vendor_id) ?? null,
        engineSizeCc: specCc,
        durationDays: specDays,
      });
      const rowGate = gateFor(r.reply_text, r.price_per_day);
      const conf = st?.vehicleConfirmation?.status;
      const vehicleStatus =
        rowGate?.status === "wrong-vehicle"
          ? ("wrong-vehicle" as const)
          : conf === "confirmed"
            ? ("confirmed" as const)
            : conf === "assumed" && rowGate?.status !== "confirmed"
              ? ("assumed" as const)
              : rowGate?.status ?? null;
      return {
      id: r.id,
      vendorId: r.vendor_id,
      vendorName: r.vendor_name,
      replyText: r.reply_text,
      // English gloss of a local-language reply (stamped by the agent loop) -
      // the traveller can always read what the shop said, on every surface.
      english: r.english_gloss ?? null,
      found: r.found,
      pricePerDay: r.price_per_day,
      // VERIFIED = high-confidence read AND the vehicle is established. The
      // column pair alone stopped meaning that when unconfirmed prices became
      // real (unverified) offers.
      verified: r.matches_spec && r.confidence === "high" && vehicleStatus === "confirmed",
      // Raw spec match: false = the shop quoted a DIFFERENT vehicle. The client
      // must never present such a price as the best/lockable offer.
      matchesSpec: r.matches_spec,
      // Transparent verification states: "confirmed" wears the badge, "assumed"
      // presents as an honest unverified offer, only "wrong-vehicle" is barred.
      vehicleStatus,
      vehicleNote: vehicleStatus === "confirmed" ? null : rowGate?.note ?? null,
      auto: r.auto,
      // WHAT THE SHOP SAID ABOUT EACH EXTRA. The request left the app in the
      // opening message and never came back, so the card and the booking sheet
      // could only show what was ASKED. One entry per requested item, each
      // honestly confirmed / refused / still unknown.
      accessories: st?.accessories ?? null,
      // "No 125 today, but I have a 150 for 220." The card asks; nothing is
      // haggled until the traveller answers.
      alternativeOffer: st?.alternativeOffer ?? null,
      // "Can you call me?" - the model's durable reading of the shop's ask.
      wantsCall: st?.wantsCall ?? null,
      currency: r.currency ?? null, // the shop's own money - never defaulted here
      deposit: r.deposit ?? null,
      depositType: r.deposit_type ?? null,
      depositAmount: r.deposit_amount ?? null,
      depositCurrency: r.deposit_currency ?? null,
      delivers: r.delivers ?? null,
      insuranceIncluded: r.insurance_included ?? null,
      deliveryFee: r.delivery_fee ?? null,
      // Digraph engine state (undefined before migration -> card treats as ready).
      fulfillment: fulfillment ?? null,
      presentable: st ? isComplete(st, r.deposit) : undefined,
      // The shop walked away - the card must say so instead of pretending
      // the agent is still working ("still confirming the deposit...").
      declined: st?.declined === true,
      // The shop has nothing to rent right now - a real, temporary state. The
      // card stops waiting for a price and says so, and the agent has already
      // asked when one is back.
      unavailable: st?.shopUnavailable === true,
      restockHint: st?.restockHint ?? null,
      // The fact the agent is double-checking, and the exact question it put.
      // The subject is what the card shows; the question is there so the panel
      // can quote us rather than paraphrase.
      confirming: st?.awaitingConfirmation?.subject ?? null,
      confirmingQuestion: st?.awaitingConfirmation?.question ?? null,
      // Only an EXPLICIT switch is news. A thread that is English because the
      // hunt was English is not something to announce (languageSwitchNotice
      // returns null for it), so the card stays quiet in the ordinary case.
      languageSwitch: languageSwitchNotice(st?.language)?.mode ?? null,
      languageSwitchQuote: languageSwitchNotice(st?.language)?.quote ?? null,
      pickupOffered: st?.pickupOffered ?? null,
      pickupConsent: st?.pickupConsent ?? null,
      // Every tier this shop offered, so the card can show the CHOICE instead
      // of the single price the app picked. A CHOICE needs two rows - a
      // single-option menu feeds effectivePrice below instead (D2), because
      // "pick the one you want" over one row is not a choice.
      options:
        (optionsByVendor.get(r.vendor_id)?.length ?? 0) >= 2
          ? optionsByVendor.get(r.vendor_id)
          : null,
      // The shop asked where we are. The card explains why and lets the
      // traveller choose WHICH place to share - it is never sent automatically.
      askedLocationQuote: askedLocationByVendor.get(r.vendor_id) ?? null,
      // A price the app already knows from ANOTHER source (thread state, a
      // photographed board, the derived menu) when this row has none - tagged
      // with its provenance. Null when the row carries the real price.
      effectivePrice,
      createdAt: r.created_at,
      };
    }),
  });
}

// maxDuration: lift the request-timeout ceiling for slow AI/WhatsApp upstreams.
export const maxDuration = 60;
