import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { runSafety } from "@/lib/agents";
import { sendWhatsApp, whatsappConfigured } from "@/lib/whatsapp";
import {
  evolutionConfigured,
  hasSessionRow,
  ensureConnected,
  sendFromUser,
} from "@/lib/evolution";
import { placeDetails } from "@/lib/google";
import { sbInsert } from "@/lib/runtime-config";
import { killSwitchOn } from "@/lib/usage";
import { can, localLanguageAllowed } from "@/lib/entitlements";
import { digitsOnly } from "@/lib/phone";
import { mapLimit } from "@/lib/concurrency";
import { lidKey } from "@/lib/wa/phone-key";
import { outboxToKeyPatch } from "@/lib/wa/outbox-columns";
import { planCapacity, batchWindowMs, BATCH_WINDOW_MINUTES } from "@/lib/wa/capacity";
import { promisedRfq } from "@/lib/wa/thread-context";
import type { StructuredRFQ } from "@/lib/types";
import type { IntroBudgetBind } from "@/lib/wa-guard";

// Mass bargain (Pro/Ultra): fire the RFQ at several shops in one tap. The
// anti-ban rate limiter still governs every single send - the batch simply
// stops when the budget runs out (the UI shows how many actually went).
//
// CAPACITY: each search session contacts at most the plan's rolling-window
// capacity in total (sent + queued), enforced HERE - the UI cap is a courtesy,
// this is the truth. free 10 / pro 15 / ultra 24 (see wa/capacity.ts).

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  if (!can(session.plan, "mass-bargain")) {
    return NextResponse.json(
      { error: "Mass bargain is a Pro/Ultra feature.", upgrade: true },
      { status: 403 }
    );
  }
  if (await killSwitchOn()) {
    return NextResponse.json({ error: "Temporarily paused by the owner." }, { status: 503 });
  }

  // Plan-tiered batch + session caps. A single mass run (and a whole search
  // session) can reach up to the plan's rolling-window capacity of shops.
  const MAX_BATCH = planCapacity(session.plan).newContacts;
  const SESSION_SHOP_CAP = MAX_BATCH;

  const body = await req.json().catch(() => ({}));
  const message = String(body.message ?? "").trim();
  let vendors: {
    id: string;
    name: string;
    whatsapp?: string;
    placeId?: string;
    openNow?: boolean; // Google "open now" - the same truth the card shows
  }[] = Array.isArray(body.vendors) ? body.vendors.slice(0, MAX_BATCH) : [];
  if (!message || vendors.length === 0) {
    return NextResponse.json({ error: "message and vendors required" }, { status: 400 });
  }
  // RFQ INTEGRITY: this route stamps every stored opener with kind:"rfq", so it
  // MUST carry a real rfq or the thread has no anchor - a shop reply then reads
  // as "RFQ anchor MISSING" (the live Eagle's Eye drop) and every strategic-wait
  // wakeup dies. Fail loudly instead of storing a null-rfq cold opener.
  const rfqOk =
    body.rfq &&
    typeof body.rfq === "object" &&
    typeof (body.rfq as { durationDays?: unknown }).durationDays === "number";
  if (!rfqOk) {
    return NextResponse.json(
      { error: "rfq required (a cold opener must carry its structured request)" },
      { status: 400 }
    );
  }

  // Per-SESSION cap (backend truth, cannot be bypassed by repeat taps): count
  // the distinct shops already contacted or queued since this search session
  // started, and only allow the remainder. The session boundary is the user's
  // latest `searches` row - the same signal the deals dashboard groups by.
  try {
    const { sbSelect, pgTimestamp } = await import("@/lib/runtime-config");
    const enc = encodeURIComponent(session.email);
    const lastSearch = await sbSelect<{ created_at: string }>(
      "searches",
      `select=created_at&user_email=eq.${enc}&order=created_at.desc&limit=1`
    );
    // pgTimestamp, NOT raw interpolation. This value comes back from PostgREST
    // as `...+00:00`; raw, the `+` decoded to a space and the read below 400'd,
    // so `contacted` was always empty and this cap - "backend truth, cannot be
    // bypassed by repeat taps" - failed OPEN. See pgTimestamp's docblock.
    const sinceIso = lastSearch[0]?.created_at ?? new Date(Date.now() - 86400000).toISOString();
    const [sentRows, queuedRows] = await Promise.all([
      sbSelect<{ to_number: string }>(
        "whatsapp_messages",
        `select=to_number&direction=eq.outbound&raw->>sender=eq.${enc}&to_number=not.in.(session,takeover,cancel)&received_at=gte.${pgTimestamp(sinceIso)}&limit=200`
      ).catch(() => []),
      sbSelect<{ to_number: string }>(
        "wa_outbox",
        `select=to_number&sender_key=eq.${enc}&limit=50`
      ).catch(() => []),
    ]);
    const contacted = new Set([
      ...sentRows.map((r) => r.to_number),
      ...queuedRows.map((r) => r.to_number),
    ]);
    const allowance = Math.max(0, SESSION_SHOP_CAP - contacted.size);
    if (allowance === 0) {
      return NextResponse.json({
        results: [],
        sent: 0,
        queued: 0,
        capReached: true,
        cap: SESSION_SHOP_CAP,
        error: `This search already reached its ${SESSION_SHOP_CAP}-shop beta limit - replies from the contacted shops keep flowing in.`,
      });
    }
    vendors = vendors.slice(0, allowance);
  } catch {
    /* cap check is best-effort - the MAX_BATCH slice still bounds the run */
  }

  const verdict = await runSafety(message);
  if (!verdict.allowed) {
    return NextResponse.json({ error: verdict.reason ?? "Blocked." }, { status: 400 });
  }

  // Gate on EVER-PAIRED, not the live socket - a transient host outage must not
  // kill the whole batch with "Connect your WhatsApp first". A parked batch
  // drains when the host recovers; connect:true is only for a never-linked user.
  const personal =
    (await evolutionConfigured()) && (await hasSessionRow(session.email));
  const cloud = await whatsappConfigured();
  if (!personal && !cloud) {
    return NextResponse.json({ error: "Connect your WhatsApp first.", connect: true }, { status: 400 });
  }
  // Resume a dropped session before the batch (best-effort).
  if (personal) await ensureConnected(session.email, 6000);

  // ULTRA local-language: localize the batch message ONCE up front (the guard
  // then varies it per shop). English fallback if the AI is unavailable.
  let batchMessage = message;
  let englishGloss: string | undefined;
  if (localLanguageAllowed({ requested: body.localLang, plan: session.plan })) {
    const { localizeMessage } = await import("@/lib/agents");
    const localized = await localizeMessage(message, String(body.region ?? "") || undefined);
    batchMessage = localized.text;
    if (localized.english && localized.text !== message) englishGloss = localized.english;
    if (!localized.localized && localized.reason !== "english-region") {
      // Documented English fallback - never a silent flip, and never the AI
      // blamed for a region we could not resolve (owner report 4).
      await sbInsert("agent_events", [
        {
          kind: "localize-fallback",
          vendor_id: "",
          vendor_name: "(mass bargain)",
          detail: JSON.stringify({
            email: session.email,
            region: String(body.region ?? ""),
            reason: localized.reason ?? "ai-unavailable",
          }).slice(0, 800),
        },
      ]).catch(() => {});
    }
  }

  const { guardOutbound, afterSend, claimForSend, releaseSendClaim, humanizeForOutbound } =
    await import("@/lib/wa-guard");
  const { batchStagger, gaussianUnit, HARD_MIN_GAP_SEC } = await import("@/lib/wa/pacing");
  const { randomBytes } = await import("crypto");
  const results: {
    id: string;
    sent: boolean;
    queued?: boolean;
    queuedUntil?: string;
    queuedReason?: string;
    reason?: string;
    text?: string;
    gloss?: string;
  }[] = [];

  // HUMAN-PACED BATCH: only the FIRST shop is contacted right now; every
  // later shop is parked with a durable, jittered 45-75s stagger
  // (wa_outbox.not_before survives restarts/redeploys). Ten messages leaving
  // at the same timestamp is a robotic signature no real traveller produces -
  // and the drain re-runs the full guard per row at its own time, so hours/
  // caps/tombstones still apply at the actual send moment.
  const batchId = randomBytes(6).toString("hex");
  // CAP-AWARE stagger: space the first hourly-cap shops ~90s apart (they send
  // promptly), then jump the overflow to the next hour window - so each parked
  // row's not_before is the REAL time the drain will honor. The old flat 45-75s
  // stagger stamped every shop "any minute", then the drain hit the hourly cap
  // and silently re-stamped the overflow an hour out (the "it said 17:34 then
  // 18:34" bug). Using the sender's conservative effective cap keeps the stamps
  // honest and stable.
  const { effectiveHourlyCap, getPolicies } = await import("@/lib/wa-guard");
  // A FAILED READ MUST NOT RESCHEDULE THE BATCH. This used to fall back to a
  // literal 3, which is smaller than every plan's conversation budget - so a
  // transient Supabase blip turned a 3-minute batch of 8 shops into three
  // hour-groups spanning an afternoon, with nothing in the logs to say why. The
  // plan's own capacity is a known constant and is the only honest fallback.
  const planHourCap = planCapacity(session.plan).hourCap;
  const hourCap = await effectiveHourlyCap(session.email, session.plan).catch(() => planHourCap);
  // The gap the anti-ban policy ASKS for. batchStagger may compress it (never
  // below the hard floor) when honouring it would break the batch promise.
  const gapSec = await getPolicies()
    .then((p) => Math.max(HARD_MIN_GAP_SEC, p.min_gap_seconds))
    .catch(() => 12);
  // SCHEDULE TO THE DEADLINE, NOT TO THE GAP. The whole batch is on its way
  // inside BATCH_WINDOW_MINUTES; see lib/wa/capacity for why that promise had to
  // become a thing the code holds rather than an outcome it hoped for. Gaussian
  // (bell-curve) jitter keeps the gaps human-shaped inside whatever the fitted
  // gap turns out to be.
  const schedule = batchStagger({
    count: vendors.length,
    hourCap,
    gapSec,
    windowMs: batchWindowMs(),
    rand: gaussianUnit,
  });

  // WAVE PACING - the enqueue-time HALF of it (plan Part 11 F1).
  //
  // `batchStagger` above spreads the batch evenly across one window. Waves
  // replace that shape with short bursts separated by real silence, which is
  // what a person looks like: 5-8 shops, then 18-22 minutes of nothing.
  //
  // batchStagger is NOT replaced - it runs unchanged INSIDE each burst, over a
  // window of ~60% of the wave gap. A second scheduler that ignored it is how
  // HARD_MIN_GAP_SEC quietly stops being enforced.
  //
  // AND THIS IS ONLY HALF THE JOB. `not_before` is an initial floor; the
  // authoritative pacer for cold intros is the DRAIN, which selects on
  // `not_before <= now` and applies its own per-sender ceiling. A wave schedule
  // written only here is reshaped by the drain on first contact - so the drain
  // carries a matching admission rule, and the two must be changed together.
  //
  // Behind WA_WAVE_PACING, default OFF: this changes the shape of every batch,
  // so it ships as a switch rather than as a surprise.
  const { planWaves, waveEndsAtFor, WAVE_BURST_FRACTION } = await import("@/lib/wa/waves");
  const { inCohort } = await import("@/lib/cohort");
  const wavesOn = await inCohort("WA_WAVE_PACING", session.email).catch(() => false);
  let offsets = schedule.offsets;
  // Held outside the branch because the ENQUEUE HALF IS ONLY HALF THE FEATURE.
  // `not_before` is a floor; the drain is the authoritative pacer and re-stamps
  // rows it cannot send this invocation. Without the wave's end time riding the
  // row, those re-stamps walk a burst straight through its own silence and the
  // schedule degrades back to a continuous trickle - see `clampRestampToWave`.
  let wavePlan: import("@/lib/wa/waves").WavePlan | null = null;
  if (wavesOn) {
    wavePlan = planWaves({ total: vendors.length, ceiling: vendors.length });
    const waveOffsets: number[] = [];
    for (const w of wavePlan.waves) {
      // Inside the burst, the SAME stagger primitive, so the hard floor and the
      // gaussian shaping both still apply.
      const inner = batchStagger({
        count: w.size,
        hourCap,
        gapSec,
        windowMs: Math.max(1, Math.round(w.spanMs * WAVE_BURST_FRACTION)),
        rand: gaussianUnit,
      });
      for (let i = 0; i < w.size; i++) {
        waveOffsets.push(w.startOffsetMs + (inner.offsets[i] ?? 0));
      }
    }
    offsets = waveOffsets;
  }
  const batchStart = Date.now();
  // The stagger index counts only shops that ACTUALLY enter the send stream -
  // never the ones skipped for no-phone, dedupe or tomorrow-deferral. So the
  // first sendable shop is always the immediate send (offset 0), and gaps
  // stay a tight 45-75s regardless of how many earlier shops were skipped.
  let sendIndex = 0;

  // MODULE 4 - PER-SHOP COMPILED OPENERS. The root cause of the "identical
  // message to every shop" spam fingerprint was this route sending ONE stored
  // string to the whole batch. Each shop now gets its own deterministic
  // variation-matrix compile (seed = user|vendor|batchId), checked through the
  // global-uniqueness guard (in-batch + cross-fleet signature window). Ultra
  // local-language localizes PER SHOP. Legacy callers without an rfq in the
  // body keep the old single-message behavior.
  const rfqForCompile =
    body.rfq &&
    typeof body.rfq === "object" &&
    typeof (body.rfq as { durationDays?: unknown }).durationDays === "number"
      ? (body.rfq as import("@/lib/types").StructuredRFQ)
      : null;
  const compiledRecent: string[] = [];
  const wantLocalLang = localLanguageAllowed({ requested: body.localLang, plan: session.plan });
  // COMPILE IS SEQUENTIAL, LOCALIZE IS NOT.
  //
  // These used to be one function awaited once per shop inside the dispatch
  // loop, which made the whole batch serial on its slowest part - the LLM
  // localization. They are split because they have opposite constraints:
  // compiling shares mutable state (`compiledRecent`, the cross-shop
  // uniqueness ledger) and MUST run one at a time, while localizing is pure
  // per-shop work and can run in a bounded pool.
  const compileFor = async (
    vendorId: string,
    shopDigits: string,
    /** W4.7 - false when this shop already has an open thread with us. */
    firstOutbound: boolean
  ): Promise<{ text: string; gloss?: string; localize?: { digits: string; firstOutbound: boolean } }> => {
    if (!rfqForCompile) return { text: opener.text, gloss: englishGloss };
    const { compileOpener } = await import("@/lib/copy/promptCompiler");
    const { openerSeed } = await import("@/lib/copy/matrix");
    const { regionForShop } = await import("@/lib/copy/region");
    const { ensureGloballyUnique } = await import("@/lib/graph/uniqueness");
    // Region from the SHOP's phone (authoritative), label only as fallback - so
    // a +84 shop never gets a Filipino sign-off.
    const shopRegion = regionForShop(shopDigits, String(body.region ?? ""));
    const english = compileOpener(rfqForCompile, openerSeed(session.email, vendorId, batchId), shopRegion);
    const unique = await ensureGloballyUnique(english, compiledRecent);
    compiledRecent.push(unique.text);
    if (!wantLocalLang) return { text: unique.text };
    // Hand the localization back to the caller's pool rather than awaiting it
    // here - this is the one slow step, and it is the reason the batch used to
    // run out of request budget.
    return { text: unique.text, localize: { digits: shopDigits, firstOutbound } };
  };

  const localizeFor = async (
    englishText: string,
    shopDigits: string,
    firstOutbound: boolean
  ): Promise<{ text: string; gloss?: string }> => {
    const { localizeMessage } = await import("@/lib/agents");
    // The LANGUAGE comes from the full phone-prefix country map; the narrow
    // 4-market shopRegion above stays what it always was - greeting flavor.
    const { countryForShop } = await import("@/lib/copy/region");
    const localized = await localizeMessage(
      englishText,
      countryForShop(shopDigits, String(body.region ?? "")),
      undefined,
      true,
      // W4.7: rule 1 of the localize prompt ORDERS a local greeting. On a shop
      // we have already messaged that re-introduces the exact greeting the
      // English strip removed - in a script the English strip cannot read.
      { greet: firstOutbound }
    );
    return localized.localized
      ? { text: localized.text, gloss: localized.english ?? englishText }
      : { text: englishText };
  };

  // CLICK-TIME BUDGET TRUTH. The anti-ban engine only allows a limited number
  // of brand-new shop introductions per day. The old flow silently parked
  // over-budget messages behind fake near-term ETAs that crept forever
  // ("came back an hour later - everything moved 30 min further"). Now the
  // remaining budget is computed UP FRONT: shops inside it start immediately
  // (first now, the rest 45-75s apart), shops beyond it get an HONEST
  // tomorrow-morning slot and the user is told so in the response.
  const { newContactBudget, introHoldIso, introHoldReason } = await import("@/lib/wa-guard");
  // AN UNKNOWN BUDGET IS NOT AN UNLIMITED ONE.
  //
  // This used to fall back to `remaining: 99` - three to ten times any plan's
  // real cap - and it never looked at `budget.unreadable`, which the budget
  // sets precisely to say "the count could not be READ, so remaining is 0
  // defensively rather than because the budget is spent". So the one moment
  // the anti-ban meter went blind was the one moment this route handed out
  // ninety-nine cold introductions on the traveller's personal number.
  //
  // Unknown now means zero, on both paths. The cost of being wrong this way is
  // a batch that waits ~3 minutes (newContactBudget stamps nextFreeAt that
  // close on an unreadable read, deliberately, so it re-checks in minutes);
  // the cost of being wrong the other way is someone's WhatsApp account.
  // { fresh: true } bypasses the 12s budget cache (OR11 E2.2): this is the
  // click-time truth the user acts on, so it must be exact, not a poll-warmed
  // value that could be up to 12s stale after their own last batch.
  const budget = await newContactBudget(session.email, session.plan, { fresh: true }).catch(() => ({
    remaining: 0,
    cap: planCapacity(session.plan).newContacts,
    windowHours: planCapacity(session.plan).windowHours,
    nextFreeAt: new Date(Date.now() + 3 * 60_000).toISOString(),
    unreadable: true,
  }));
  const budgetUnreadable = Boolean((budget as { unreadable?: boolean }).unreadable);
  let newIntrosLeft = budgetUnreadable ? 0 : budget.remaining;
  // Which of these shops has this user EVER messaged before? (Known contacts
  // do not consume the introductions budget.)
  const { sbSelect } = await import("@/lib/runtime-config");
  const knownRows = await sbSelect<{ to_number: string }>(
    "wa_recipient_state",
    `select=to_number&sender_key=eq.${encodeURIComponent(session.email)}&limit=500`
  ).catch(() => []);
  const knownNumbers = new Set(knownRows.map((r) => r.to_number));
  // DEDUPE: a shop with a message already waiting must not get a second row
  // (the "same shop listed twice in the queue" report) - covers both re-runs
  // of mass bargain and duplicate vendors within one batch.
  const pendingRows = await sbSelect<{ to_number: string }>(
    "wa_outbox",
    `select=to_number&sender_key=eq.${encodeURIComponent(session.email)}&limit=100`
  ).catch(() => []);
  const alreadyQueued = new Set(pendingRows.map((r) => r.to_number));
  // Tighten the click-time budget by intros ALREADY parked to NEW shops (from a
  // prior tap / another instance): a committed-but-unsent introduction still
  // consumes a slot, so a double-tap can't each re-grant the full cap. The
  // per-row guard re-checks at drain regardless, so this only reduces queue
  // bloat - never over-sends.
  const parkedNewIntros = pendingRows.filter((r) => !knownNumbers.has(r.to_number)).length;
  newIntrosLeft = Math.max(0, newIntrosLeft - parkedNewIntros);
  let deferredTomorrow = 0;

  // ---- OPENERS, PREPARED BEFORE THE DISPATCH LOOP -------------------------
  //
  // Every shop's opener used to be compiled AND localized inside the loop, one
  // awaited LLM call at a time. At Ultra's 24-shop batch that is ~24 sequential
  // model round trips inside a 60s request ceiling: the request died partway
  // and the shops at the tail were silently never queued. The traveller saw a
  // hunt that had simply stopped.
  //
  // Two passes instead. Compiling stays strictly sequential because it shares
  // the cross-shop uniqueness ledger; localizing - the slow half - runs in a
  // bounded pool, so the batch costs about one round trip per POOL, not per
  // shop, and stays inside the ceiling with room to spare.
  const openerByVendor = new Map<string, { text: string; gloss?: string }>();
  {
    const withPhone = vendors
      .map((v) => ({ v, digits: digitsOnly((v.whatsapp ?? "").trim()) }))
      .filter((x) => x.digits.length > 0);
    const compiled = [];
    for (const { v, digits } of withPhone) {
      compiled.push({
        v,
        digits,
        out: await compileFor(String(v.id), digits, !knownNumbers.has(digits)),
      });
    }
    const POOL = 6; // enough to collapse the wall clock, low enough to stay under provider RPM
    const finished = await mapLimit(compiled, POOL, async ({ out, digits }) => {
      if (!out.localize) return { text: out.text, gloss: out.gloss };
      // One shop's localization failing must never take the batch down - the
      // English opener is a correct message, just not a localized one.
      return await localizeFor(out.text, digits, out.localize.firstOutbound).catch(() => ({
        text: out.text,
        gloss: out.gloss,
      }));
    });
    compiled.forEach((c, i) => openerByVendor.set(String(c.v.id), finished[i]));
  }

  for (const v of vendors) {
    let to = (v.whatsapp ?? "").trim();
    if (!to && v.placeId) to = (await placeDetails(v.placeId))?.phone ?? "";
    if (!to) {
      results.push({ id: v.id, sent: false, reason: "no-phone" });
      continue;
    }
    const digits = digitsOnly(to);
    // The user explicitly selected this shop for the mass run - that decision
    // re-opens a previously removed/cancelled recipient. AUTHORITATIVE: when
    // no durable store confirms the clear, refuse THIS shop honestly instead
    // of queueing a row the guard will terminally kill at drain (a kill that
    // then rendered as "REMOVED BY YOU" on a shop the user just selected).
    {
      const { clearCancellation } = await import("@/lib/wa/cancellations");
      const cleared = await clearCancellation(session.email, digits).catch(() => false);
      if (!cleared) {
        results.push({
          id: v.id,
          sent: false,
          reason: "still-removed - could not confirm re-opening this shop, try again",
        });
        continue;
      }
    }

    // W4.7 - HAVE WE EVER MESSAGED THIS SHOP? Hoisted above the opener compile
    // (it used to be computed only for the introductions budget, below) because
    // it is also the thread-position fact: a SECOND search that reaches a shop
    // from a previous hunt opens a fresh "Hi there!" inside a WhatsApp thread
    // that is already running, which is exactly the bot tell owner report 5
    // item 3 photographed. The localizer is told too, so it cannot answer a
    // stripped English greeting with a fresh local one.
    const isNewIntro = !knownNumbers.has(digits);
    // Per-shop compiled opener (falls back to the legacy single message when
    // the caller sent no rfq). Computed before meta so the gloss rides along.
    // Prepared above in the bounded pool; a shop whose phone only resolved via
    // placeDetails (rare) was not in that pass and compiles on the spot.
    const opener =
      openerByVendor.get(String(v.id)) ?? (await compileFor(String(v.id), digits, isNewIntro));
    // W9 - THE STAMP MAY NOT REWRITE A RUNNING THREAD'S PROMISE.
    //
    // This is the PRIMARY hunt send path, and it was the one drift generator
    // left unguarded: `rfq: body.rfq ?? null` stamped the client's live rfq onto
    // every row, including the shops `isNewIntro` had just told it were already
    // mid-conversation. That stamp becomes the thread's anchor, so a second
    // search for a different duration silently re-quoted every live thread - the
    // exact mid-thread flip /api/outreach was fixed for, on the route that sends
    // far more messages. The sibling's doctrine applies unchanged: a genuinely
    // FIRST contact IS the promise and passes through untouched; anything else
    // is reconciled against what that shop was actually told, which is what the
    // inbound resolver will compute for this thread regardless.
    const settledRfq = isNewIntro
      ? ((body.rfq as StructuredRFQ | undefined) ?? null)
      : (await promisedRfq(digits, session.email, body.rfq as StructuredRFQ | undefined)).rfq;
    const meta = {
      sender: session.email,
      vendorId: v.id,
      vendorName: v.name,
      kind: "rfq",
      round: 0,
      rfq: settledRfq ?? null,
      region: String(body.region ?? ""),
      plan: session.plan,
      localLang: localLanguageAllowed({ requested: body.localLang, plan: session.plan }),
      batchId,
      batchSize: vendors.length,
      // DISPATCH FACTS RIDE THE ROW. The drain re-guards every parked row;
      // without these it was blind to Google's "open now" and to the batch's
      // 15-minute promise, so it could re-park a sibling of an immediate
      // send on facts dispatch had already refuted (guardOutbound reads both).
      batchDeadline: batchStart + batchWindowMs(),
      ...(typeof v.openNow === "boolean" ? { openNow: v.openNow } : {}),
      // On queued rows the thread peek reads the gloss from outbox meta.
      ...((opener.gloss ?? englishGloss) ? { englishGloss: opener.gloss ?? englishGloss } : {}),
    };

    // DEDUPE: this shop already has a message waiting - never add a second.
    if (alreadyQueued.has(digits)) {
      results.push({ id: v.id, sent: false, queued: true, reason: "already-queued" });
      continue;
    }
    alreadyQueued.add(digits);

    // THE COMPANY WIRE (Wave 6) - same doctrine as the single Ask: the
    // thread's immutable stamp first, TRANSPORT_MODE second, Evolution by
    // default. Resolved PER SHOP because a thread handed off earlier stays on
    // its wire whatever the mode now says. Placed ABOVE the introductions
    // budget and the stagger on purpose: a company-wire lead spends neither
    // the traveller's Evolution intro allowance nor an anti-ban stagger slot -
    // the WABA governor + per-agency admission inside dispatchHandoff are its
    // pacing. A WABA send/hold settles this shop here (the dispatcher wrote
    // the anchor + `contacted` funnel stamp itself); a dry-run rehearsal, an
    // explicit fallback and a servable refusal all fall through to the legacy
    // lanes below.
    {
      const { resolveTransport } = await import("@/lib/wa/transports");
      const resolved = await resolveTransport(session.email, digits).catch(() => null);
      if (resolved && resolved.transport.kind === "waba") {
        // SELECTION IS NOT A WIRE. Everything below this can still fall through
        // to Evolution - a dry-run rehearsal, a shop that never opted in, any
        // servable refusal - so recording "waba" here stamped a transport on
        // the event ledger AND the consent-gated product_events projection that
        // nothing actually carried. The single Ask already stamps `evolution`
        // at selection for exactly this reason; the wire that really carried
        // the RFQ is stamped at `contacted`, by whichever lane delivered it.
        const { advanceThreadStage } = await import("@/lib/funnel/stages");
        await advanceThreadStage(
          { userEmail: session.email, toNumber: digits, vendorId: String(v.id), vendorName: v.name, transport: "evolution" },
          "selected",
          "mass outreach included this shop"
        ).catch(() => {});
        const { dispatchHandoff } = await import("@/lib/waba/dispatch");
        const { rfqLabels } = await import("@/lib/waba/render");
        const labels = rfqLabels(settledRfq);
        const out = await dispatchHandoff({
          userEmail: session.email,
          agencyNumber: digits,
          agencyName: v.name || undefined,
          sessionId: batchId,
          vehicle: labels.vehicle,
          dates: labels.dates,
          freeformText: opener.text,
          rfq: settledRfq ?? undefined,
          vendorId: String(v.id),
        });
        const rehearsal = out.outcome === "sent" && out.reason === "dry-run";
        if (out.outcome === "sent" && !rehearsal) {
          results.push({ id: v.id, sent: true, text: out.preview });
          continue;
        }
        if (out.outcome === "held") {
          results.push({
            id: v.id,
            sent: false,
            queued: true,
            queuedReason: out.reason,
            reason: "queued",
          });
          continue;
        }
        if (out.outcome === "refused" && out.reason === "suppressed") {
          results.push({
            id: v.id,
            sent: false,
            reason: "not-contactable - this shop asked not to be contacted",
          });
          continue;
        }
      }
    }

    // BUDGET: a brand-new shop beyond today's introductions budget gets the
    // honest tomorrow-morning slot - told to the user, never a fake ETA.
    if (isNewIntro && newIntrosLeft <= 0) {
      // Beyond this window's introductions budget: park on the ROLLING-window
      // anchor (when the next slot frees - at most windowHours away), not a
      // "tomorrow morning" wall. The drain re-runs the full guard at that time.
      const notBefore = await introHoldIso(
        session.email,
        digits,
        String(body.region ?? "") || undefined,
        session.plan
      );
      // Say which of the two it is. "Introductions full" is a fact about the
      // traveller's usage; an unreadable meter is a fact about us, and telling
      // someone they have spent an allowance they have not spent is the kind of
      // small lie that makes the whole queue untrustworthy.
      // ...and say WHICH ceiling. The four are minimised into one number, and
      // for three of them "refreshes soon" is simply untrue: Meter A clears
      // when a SHOP replies, not on any clock the traveller can wait out. That
      // wording is what turned "5 of my 12 shops were messaged and the rest
      // vanished" into a reasonable thing for a tester to believe.
      const holdReason = budgetUnreadable
        ? "checking your introductions allowance - retrying shortly"
        : introHoldReason((budget as { bind?: IntroBudgetBind }).bind);
      // Humanize at park: the drain delivers this row verbatim
      // (alreadyHumanized), so the anti-fingerprinting pass must run HERE.
      // Seeded, so a retry parks the identical body.
      const parked = await sbInsert("wa_outbox", [
        {
          sender_key: session.email,
          to_number: digits,
          ...(await outboxToKeyPatch(digits)),
          body: humanizeForOutbound(session.email, digits, opener.text, {
            firstOutbound: isNewIntro,
          }),
          not_before: notBefore,
          meta: { ...meta, reason: holdReason },
        },
      ]);
      deferredTomorrow++;
      results.push({
        id: v.id,
        sent: false,
        queued: parked,
        queuedUntil: parked ? notBefore : undefined,
        queuedReason: parked ? holdReason : undefined,
        reason: parked ? "queued" : "queue-unavailable",
      });
      continue;
    }
    if (isNewIntro) newIntrosLeft--;

    // This shop is entering the send stream - claim its stagger slot. The
    // first eligible shop (slot 0) sends immediately; the rest are parked.
    const slot = sendIndex++;
    // THE DRAIN'S HALF OF THE WAVE SCHEDULE, written onto the row itself.
    // Re-deriving it at drain time would need the same seed to survive a
    // redeploy, and a schedule that changes shape on deploy is not a schedule.
    // Null when waves are off, and every consumer treats null as "legacy row".
    const waveEndsAt = wavePlan ? waveEndsAtFor(batchStart, wavePlan.waves, slot) : null;
    const rowMeta = waveEndsAt ? { ...meta, waveEndsAt } : meta;
    // Shops after the first: park with the stagger - the guard runs at drain.
    if (slot > 0) {
      // Floor at now + the hard gap: the per-shop opener work above (Places
      // details + LLM localization) takes real time, so a later slot's offset
      // can already be in the past by the time its row is written - a
      // due-on-arrival row falls to the drain's 2-cold-per-tick trickle
      // instead of its own schedule. The stagger survives the loop's latency.
      const notBefore = new Date(
        Math.max(batchStart + offsets[slot], Date.now() + HARD_MIN_GAP_SEC * 1000)
      ).toISOString();
      const parked = await sbInsert("wa_outbox", [
        {
          sender_key: session.email,
          to_number: digits,
          ...(await outboxToKeyPatch(digits)),
          // Same humanize-at-park rule as the budget hold above: parked slots
          // are delivered verbatim by the drain, so the pass runs at enqueue.
          body: humanizeForOutbound(session.email, digits, opener.text, {
            firstOutbound: isNewIntro,
          }),
          not_before: notBefore,
          meta: { ...rowMeta, reason: "batch-spacing" },
        },
      ]);
      results.push({
        id: v.id,
        sent: false,
        queued: parked,
        queuedUntil: parked ? notBefore : undefined,
        queuedReason: parked ? "batch-spacing" : undefined,
        reason: parked ? "queued" : "queue-unavailable",
      });
      continue;
    }

    // FUNNEL LEDGER: this shop made the batch - intent, not delivery. No
    // restart flag (unlike the single Ask): a mass run may sweep shops already
    // mid-conversation, and forward-only keeps their real stage.
    {
      const { advanceThreadStage } = await import("@/lib/funnel/stages");
      await advanceThreadStage(
        { userEmail: session.email, toNumber: digits, vendorId: String(v.id), vendorName: v.name, transport: "evolution" },
        "selected",
        "mass outreach included this shop"
      ).catch(() => {});
    }

    // Shop 1: the immediate, fully-guarded send.
    const guard = await guardOutbound({
      senderKey: session.email,
      toDigits: digits,
      text: opener.text,
      auto: true,
      queueIfBlocked: true,
      region: String(body.region ?? "") || undefined,
      // Google truth first: an open shop is NEVER queued as "closed". Only
      // when openNow is unknown does the local-clock window apply.
      shopOpenNow: typeof v.openNow === "boolean" ? v.openNow : undefined,
      meta: rowMeta,
    });
    if (!guard.allow) {
      // FUNNEL LEDGER: parked by the guard - queued, not contacted (the drain
      // stamps `contacted` when the row delivers).
      if (guard.queuedUntil) {
        const { advanceThreadStage } = await import("@/lib/funnel/stages");
        await advanceThreadStage(
          { userEmail: session.email, toNumber: digits, vendorId: String(v.id), vendorName: v.name, transport: "evolution" },
          "contact_queued",
          `RFQ parked: ${(guard.reason ?? "guard hold").slice(0, 80)}`
        ).catch(() => {});
      }
      results.push({
        id: v.id,
        sent: false,
        queued: Boolean(guard.queuedUntil),
        queuedUntil: guard.queuedUntil ? new Date(guard.queuedUntil).toISOString() : undefined,
        // Raw guard reason so the card can explain the hold honestly.
        queuedReason: guard.queuedUntil ? guard.reason ?? undefined : undefined,
        reason: guard.queuedUntil ? "queued" : guard.reason,
      });
      continue;
    }
    // Atomic slots: no concurrent duplicate, no gap-window race.
    const claim = await claimForSend(session.email, digits, guard.text, true);
    if (!claim.ok) {
      const notBefore = new Date(batchStart + 60_000).toISOString();
      await sbInsert("wa_outbox", [
        {
          sender_key: session.email,
          to_number: digits,
          ...(await outboxToKeyPatch(digits)),
          body: guard.text,
          not_before: notBefore,
          meta: { ...rowMeta, reason: claim.kind === "duplicate" ? "batch-spacing" : "human pacing gap" },
        },
      ]).catch(() => {});
      // FUNNEL LEDGER: parked on the batch's pacing spacing.
      {
        const { advanceThreadStage } = await import("@/lib/funnel/stages");
        await advanceThreadStage(
          { userEmail: session.email, toNumber: digits, vendorId: String(v.id), vendorName: v.name, transport: "evolution" },
          "contact_queued",
          "RFQ parked: batch spacing"
        ).catch(() => {});
      }
      results.push({
        id: v.id,
        sent: false,
        queued: true,
        queuedUntil: notBefore,
        queuedReason: "human pacing gap",
        reason: "queued",
      });
      continue;
    }

    let ok = false;
    let ambiguous = false;
    let reason: string | undefined;
    let sentChatLid = "";
    if (personal) {
      const r = await sendFromUser(session.email, digits, guard.text);
      ok = r.ok;
      ambiguous = Boolean(r.ambiguous);
      reason = r.error;
      sentChatLid = lidKey(r.chatJid);
      if (r.rateLimited) {
        await releaseSendClaim(session.email, digits, guard.text).catch(() => {});
        results.push({ id: v.id, sent: false, reason: "rate-limit" });
        break; // budget exhausted - stop the batch quietly
      }
    } else if (cloud) {
      const r = await sendWhatsApp(to, guard.text);
      ok = r.ok && r.channel === "cloud-api";
      reason = r.error;
    }
    if (ok) {
      await afterSend(session.email, digits);
      await sbInsert("whatsapp_messages", [
        {
          to_number: digits,
          body: guard.text,
          type: "text",
          direction: "outbound",
          raw: {
            channel: personal ? "personal-wa" : "cloud-api",
            // Which wire carried it (one vocabulary: evolution | cloud | waba).
            transport: personal ? "evolution" : "cloud",
            ok: true,
            ...meta,
            // The chat's privacy identity, when the provider reported one -
            // this outbound anchor is what resolves the shop's FIRST @lid
            // reply (wa/lid-alias reads raw.lid on both directions).
            ...(sentChatLid ? { lid: sentChatLid } : {}),
          },
        },
      ]);
      // FUNNEL LEDGER: the RFQ reached the shop (TRUTH RULE row above).
      {
        const { advanceThreadStage } = await import("@/lib/funnel/stages");
        await advanceThreadStage(
          {
            userEmail: session.email,
            toNumber: digits,
            vendorId: String(v.id),
            vendorName: v.name,
            transport: personal ? "evolution" : "cloud",
          },
          "contacted",
          "RFQ delivered to the shop"
        ).catch(() => {});
      }
    } else if (!ambiguous) {
      await releaseSendClaim(session.email, digits, guard.text).catch(() => {});
    }
    // AMBIGUOUS (status-0 timeout): keep the claim - the intro may have landed,
    // and releasing it would let the next mass run re-introduce the same shop.
    results.push({
      id: v.id,
      sent: ok,
      reason: ok ? undefined : reason ?? "not-on-whatsapp",
      // Give the traveller the EXACT text we sent + its faithful English gloss
      // so the status panel shows what really went out (never a paraphrase).
      text: ok ? guard.text : undefined,
      gloss: ok ? englishGloss : undefined,
    });
  }

  // LIVENESS: kick the self-chaining drain so the staggered batch keeps
  // progressing even if the user locks their phone right now.
  //
  // The last bare unawaited fetch in the codebase. It was described as
  // fire-and-forget with the polls and the ping cron as backstops - but this is
  // the kick that starts a batch the traveller JUST clicked, and on Cloud Run
  // an unawaited fetch that has not finished its handshake when the response
  // flushes never leaves. Falling back to a poll means the first message of a
  // hand-triggered batch waits for whatever pokes the server next, which is the
  // slow-first-send report this chain was built to end. kickDispatcher returns
  // as soon as the tick answers, so the cost in the common case is milliseconds.
  try {
    const { webhookToken } = await import("@/lib/evolution");
    const { selfKickOrigin } = await import("@/lib/request-origin");
    const { kickDispatcher } = await import("@/lib/wa/kick");
    const token = await webhookToken();
    const origin = await selfKickOrigin(req);
    if (token) {
      await kickDispatcher(`${origin}/api/wa/tick?token=${encodeURIComponent(token)}&hop=0`);
    }
  } catch {
    /* best-effort */
  }

  return NextResponse.json({
    results,
    sent: results.filter((r) => r.sent).length,
    queued: results.filter((r) => r.queued).length,
    // Honest budget summary for the UI: how many shops start now vs deferred,
    // the rolling-window size, and when the next introduction slot frees.
    deferredTomorrow,
    // THE PROMISE, STATED BACK. The last message of this batch is stamped
    // within this many minutes - so a UI (or a test, or the owner reading a
    // response) can hold the schedule to it instead of inferring it.
    batchWindowMinutes: BATCH_WINDOW_MINUTES,
    batchGapSeconds: schedule.gapSecUsed,
    /** Shops beyond the sender's hourly ceiling - honestly scheduled later. */
    batchOverflow: schedule.overflow,
    introBudget: {
      remaining: newIntrosLeft,
      cap: budget.cap,
      windowHours: budget.windowHours,
      nextFreeAt: budget.nextFreeAt,
      // The binding ceiling rides the response so the batch sheet can explain
      // the wait in the same words the parked rows carry.
      ...((budget as { bind?: IntroBudgetBind }).bind
        ? { bind: (budget as { bind?: IntroBudgetBind }).bind }
        : {}),
      // Carried through so the UI can say "checking" rather than "you have used
      // your allowance" - the same distinction IntroBudget's own docstring asks
      // callers to make, which this route was the only caller not making.
      ...(budgetUnreadable ? { unreadable: true } : {}),
    },
  });
}

// maxDuration: lift the request-timeout ceiling for slow AI/WhatsApp upstreams.
export const maxDuration = 60;
