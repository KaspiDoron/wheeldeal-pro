import { NextResponse } from "next/server";
import { runSafety } from "@/lib/agents";
import { sendWhatsApp, whatsappConfigured } from "@/lib/whatsapp";
import {
  evolutionConfigured,
  wasEverConnected,
  sendFromUser,
} from "@/lib/evolution";
import { placeDetails } from "@/lib/google";
import { getSession } from "@/lib/session";
import { sbInsert, sbSelect } from "@/lib/runtime-config";
import { normalizePlan } from "@/lib/access";
import { digitsOnly } from "@/lib/phone";
import { lidKey } from "@/lib/wa/phone-key";
import { outboxToKeyPatch } from "@/lib/wa/outbox-columns";
import { resolveOutreachIdentity } from "@/lib/wa/identity";
import { jsonRoute } from "@/lib/http/json-route";
import { can, localLanguageAllowed } from "@/lib/entitlements";
import type { StructuredRFQ } from "@/lib/types";

// In-app outreach: the ONLY way messages leave the app. The user never jumps
// to WhatsApp - we screen the message through the safety agent, resolve the
// shop's number server-side (Place Details) when needed, send via the official
// WhatsApp Cloud API, and log the full thread context so the webhook can match
// the shop's reply back to this conversation automatically.
//
// Body: { to?, placeId?, vendorId?, vendorName?, message, kind?, rfq?, round? }
//
// EVERY EXIT IS JSON, including the ones nobody wrote. This handler awaits an
// LLM safety screen, Google Place Details, Supabase, the integrity ladder, the
// anti-ban guard and the WhatsApp host - any of which can throw or hang, and
// each of which used to end the request as an HTML 500 or a gateway 504. The
// browser's `res.json()` then threw, and the shop card told the traveller their
// connection was down. `jsonRoute` makes the failure modes part of the contract
// (see lib/http/json-route).
export const POST = jsonRoute("Sending your message", handlePost);

async function handlePost(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Sign in to message vendors." }, { status: 401 });
  }
  const { killSwitchOn } = await import("@/lib/usage");
  if (await killSwitchOn()) {
    return NextResponse.json(
      { error: "WheelDeal is temporarily paused by the owner." },
      { status: 503 }
    );
  }
  const body = await req.json().catch(() => ({}));
  const message = String(body.message ?? "").trim();
  if (!message) {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }

  const verdict = await runSafety(message);
  if (!verdict.allowed) {
    return NextResponse.json(
      { allowed: false, reason: verdict.reason, suggestion: verdict.suggestion },
      { status: 200 }
    );
  }

  // Free-tier pickup rule: only TODAY pickups are allowed. A free user who is
  // already in a cooldown (from a prior bypass attempt) is blocked entirely;
  // a fresh attempt to arrange a next-day pickup triggers a 6-hour cooldown.
  // PLATFORM INTEGRITY, GRADUATED (lib/integrity).
  //
  // This used to be one regex over ONE message and an instant six-hour block:
  // a single phrase - "maybe next week", "my flight is tomorrow" - and the
  // traveller lost the product for the rest of their day, with no warning and
  // nobody to appeal to. One phrase is a signal, not a verdict.
  //
  // Now signals accumulate WITH their evidence and decay on their own, and the
  // response climbs: a nudge that explains the plan rule and blocks nothing, a
  // short explained pause, a feature limit while the agents keep negotiating,
  // and only then a block PROPOSAL queued for the owner with the evidence
  // attached. Nothing bans an account by itself.
  //
  // TWO AUTHORITIES, AND ONLY TWO. A rung of the ladder pauses sending iff it
  // carries `pauseMinutes` (that table, and nothing here, decides which rungs
  // are restrictive). Anything longer than a rung's pause exists only because
  // the OWNER approved it in Admin -> Ops, and lands as an `integrity-block`
  // cooldown. The gate below used to conflate the two: reaching the top rung
  // refused every send for as long as the evidence stayed live, so the
  // "proposal" was already the punishment and no owner was ever in the loop.
  let notice: string | null = null;
  {
    const { cooldownLeft } = await import("@/lib/cooldown");
    const { BLOCK_KIND } = await import("@/lib/integrity/adjudication");
    const restricted = await cooldownLeft(session.email, BLOCK_KIND);
    if (restricted > 0) {
      return NextResponse.json({
        allowed: false,
        blocked: true,
        cooldownMinutes: restricted,
        reason:
          "Sending from this account is paused after a review. Your deals are intact and replies still arrive - get in touch and we will sort it out.",
        underReview: false,
        upgrade: false,
      });
    }

    const { noteAndAssess } = await import("@/lib/integrity/store");
    const { requiresOwnerApproval } = await import("@/lib/integrity/signals");
    const verdict = await noteAndAssess({
      email: session.email,
      plan: session.plan,
      text: message,
    });
    if (verdict.pauseMinutes) {
      return NextResponse.json({
        allowed: false,
        blocked: true,
        cooldownMinutes: verdict.pauseMinutes,
        reason: verdict.message,
        // The top rung is a proposal a human decides on; say so rather than
        // implying a consequence that has not happened.
        underReview: requiresOwnerApproval(verdict.step),
        upgrade: session.plan === "free",
      });
    }
    // A nudge is information, not a refusal - the message still goes, and the
    // explanation goes WITH it. It used to be computed and thrown away, so the
    // gentlest rung of the ladder was silent and the traveller's first hint
    // that a rule existed was the pause two rungs later.
    notice = verdict.message ?? null;
  }

  // Resolve the destination number server-side. ANTI-SPOOF: when the vendor
  // has a real Google identity (placeId), the client-supplied number must
  // match the resolved one - a mismatched number must NEVER wear a real
  // vendor's name (this is exactly how a test number once impersonated a real
  // Bali shop and leaked a private chat onto its card). The owner may still
  // test against an arbitrary number, but the thread is then re-keyed as an
  // explicit test vendor.
  let to = String(body.to ?? "").trim();
  let vendorIdOverride: string | null = null;
  let vendorNameOverride: string | null = null;
  // IDENTITY VERIFICATION (privacy keystone). A stored outbound row is what
  // later makes an inbound reply attribute to a shop, so a number may ONLY wear
  // a real shop's name+rfq if it is POSITIVELY the shop's own Google-listed
  // phone. This runs for ANY send that claims a real shop - not just when a
  // placeId happens to be present (the old `if (body.placeId)` guard left two
  // holes: no placeId at all, and a placeId whose Google record has no phone -
  // both let an unverifiable personal number keep the real shop's identity and
  // ingest that contact's private chats as "shop replies").
  {
    const claimedId = String(body.vendorId ?? "");
    const claimsRealShop =
      Boolean(body.vendorName || body.vendorId || body.placeId) &&
      !claimedId.startsWith("test-") &&
      !claimedId.startsWith("drill-");
    let resolvedPhone = "";
    if (body.placeId) {
      const details = await placeDetails(String(body.placeId));
      resolvedPhone = digitsOnly(details?.phone);
      if (!digitsOnly(to) && details?.phone) to = details.phone; // fill from Google
    }
    const supplied = digitsOnly(to);
    // The decision is a pure, unit-pinned helper (see wa/identity.ts) - only a
    // POSITIVE phone contradiction or an EXPLICITLY declared drill re-keys to a
    // test identity; the mere absence of a reference phone keeps the real one.
    //
    // This used to read `session.role === "owner" && await testModeOn()`, which
    // meant that for the entire beta - TEST_MODE is on for the whole tester
    // programme - every real shop the owner contacted was stamped
    // `test-<digits>`. That is a drill anchor, so the inbound window shrank from
    // 14 days to 3 hours and real shop replies were gated out as `vendor-gate`.
    // TEST_MODE is a billing and banner switch; it is not a statement that the
    // shop on the other end is fake.
    const drillIntent = body.drill === true;
    const identity = resolveOutreachIdentity({
      claimsRealShop,
      resolvedPhone,
      supplied,
      drillIntent,
      vendorName: body.vendorName ? String(body.vendorName) : undefined,
    });
    if (identity.action === "send-to-shop") {
      to = `+${identity.toPhone}`;
    } else if (identity.action === "rekey-test") {
      vendorIdOverride = identity.vendorId;
      vendorNameOverride = identity.vendorName;
    }
  }
  if (!to) {
    return NextResponse.json({
      allowed: true,
      sent: false,
      reason: "no-phone",
      note: "No phone number found for this shop yet.",
    });
  }

  const digits = digitsOnly(to);
  // An explicit send from the user RE-OPENS a shop they previously removed
  // from the queue - the tombstone yields only to a fresh human decision.
  {
    const { clearCancellation } = await import("@/lib/wa/cancellations");
    await clearCancellation(session.email, digits).catch(() => {});
  }
  // The identity every stored row uses - a spoofed number can only ever be a
  // clearly-labelled test vendor, never the real shop.
  const vendorId = vendorIdOverride ?? String(body.vendorId ?? "");
  const vendorName = vendorNameOverride ?? String(body.vendorName ?? "");

  // Anti-Ban gate for agent-composed sends (RFQs, bargains). Custom messages
  // the user typed are auto:false - they skip the engagement halt but still
  // respect volume caps. Blocked-by-hours sends are QUEUED, not lost.
  const kind = String(body.kind ?? "custom");
  const isAuto = kind !== "custom";

  // ONE MOVE PER HUMAN BEAT (wa/turn-lock). A tap on Push harder / Bargain
  // composes a FRESH draft every time, so the exact-text dedupe further down
  // can never see that two taps are the same intent - which is exactly how
  // three near-identical bargains landed in one shop's chat inside a minute
  // in the field. The client marks those sends userMove:true; one such move
  // per (traveller, shop) per ~3-minute window, refused HONESTLY. Hand-typed
  // messages are not marked and are never throttled here.
  const isUserMove = body.userMove === true;
  const moveClaimAt = Date.now();
  if (isUserMove) {
    const { claimUserMove } = await import("@/lib/wa/turn-lock");
    const move = await claimUserMove(session.email, digits, moveClaimAt);
    if (move === "lost") {
      return NextResponse.json({
        allowed: true,
        sent: false,
        held: true,
        error:
          "Your agent just made a move in this chat - give the shop a couple of minutes to answer before pushing again.",
      });
    }
  }
  // A move that did NOT happen (refused, failed) gives the window back so the
  // traveller's retry is not stranded; a sent or queued move keeps it - the
  // window IS the debounce.
  const releaseMove = async () => {
    if (!isUserMove) return;
    const { releaseUserMove } = await import("@/lib/wa/turn-lock");
    await releaseUserMove(session.email, digits, moveClaimAt).catch(() => {});
  };
  // THE THREAD'S OWN LANGUAGE OUTRANKS THE LIVE TOGGLE.
  //
  // The switch is global and the traveller can flip it at any moment - which,
  // before this, changed the language of every OPEN conversation mid-sentence.
  // To the shop, the customer they have been messaging in Thai for ten minutes
  // suddenly writes English, then Thai again: the exact bot tell the whole
  // anti-fingerprinting effort exists to avoid. The opener decides; the toggle
  // only governs threads that have not started.
  const requestedLocal = localLanguageAllowed({ requested: body.localLang, plan: session.plan });
  const { threadLanguageMode, resolveThreadLanguage } = await import("@/lib/wa/thread-language");
  const established = await threadLanguageMode(session.email, digits);
  const langChoice = resolveThreadLanguage({ requested: requestedLocal, established });
  const wantsLocal = langChoice.localLang;

  // RFQ INTEGRITY: an agent send stamped kind rfq/bargain/clarify MUST carry a
  // real rfq, or the stored thread has no anchor (the "RFQ anchor MISSING" drop)
  // and inbound replies can never be attributed. A user-typed "custom" is exempt.
  if (
    (kind === "rfq" || kind === "bargain" || kind === "clarify") &&
    !(body.rfq && typeof body.rfq === "object" && typeof (body.rfq as { durationDays?: unknown }).durationDays === "number")
  ) {
    return NextResponse.json(
      { error: `rfq required for a ${kind} send (the thread anchor)` },
      { status: 400 }
    );
  }

  // SERVER-AUTHORITATIVE DURATION, ON THE SEND PATH TOO (owner report 5 #7).
  //
  // Every send re-stamps `raw.rfq` onto the outbound row, which is what the
  // whole thread is later re-anchored from. A bargain or a hand-typed custom
  // composed on the client's live rfq therefore did not merely SAY a duration
  // the shop was never quoted - it made that duration the thread's new truth,
  // and the mid-thread flip became permanent. The opener is immutable evidence
  // of what we promised; it governs here exactly as it does on the inbound
  // path. An `rfq` kind IS the opener (no promise exists yet), so it passes
  // through untouched.
  const { promisedRfq } = await import("@/lib/wa/thread-context");
  const settledRfq =
    kind === "rfq"
      ? ((body.rfq as StructuredRFQ | undefined) ?? null)
      : (await promisedRfq(digits, session.email, body.rfq as StructuredRFQ | undefined)).rfq;

  let outboundText = message;
  let englishGloss: string | undefined;

  // PER-SHOP MESSAGE VARIETY: the client sends ONE rfq.vendorMessage for the
  // whole search, so every shop was getting the identical first message. For
  // agent RFQs we regenerate a freshly-varied message here (server-side single
  // source of truth), so no two shops ever receive the same opening text.
  if (isAuto && kind === "rfq" && body.rfq) {
    try {
      // Module 4: the deterministic variation-matrix compiler (seed =
      // user|vendor|hour) + the global-uniqueness guard, replacing the old
      // Math.random template pools - reproducible diversity, cross-fleet
      // skeleton dedup (the Redis window no-ops when REDIS_URL is unset).
      const { compileOpener } = await import("@/lib/copy/promptCompiler");
      const { openerSeed } = await import("@/lib/copy/matrix");
      const { regionForShop } = await import("@/lib/copy/region");
      const { ensureGloballyUnique } = await import("@/lib/graph/uniqueness");
      // Region from the SHOP's phone (authoritative), label as fallback.
      const shopRegion = regionForShop(digits, String(body.region ?? ""));
      const compiled = compileOpener(
        body.rfq,
        openerSeed(session.email, vendorId || digits, new Date().toISOString().slice(0, 13)),
        shopRegion
      );
      // A REAL RECENT LIST, NOT `[]` (W-beta30). ensureGloballyUnique has two
      // layers: the cross-fleet Redis signature window, and the in-process
      // trigram compare against this list. The Redis layer is a documented
      // no-op when REDIS_URL is unset - so passing an empty list here meant
      // the single-shop path did ZERO uniqueness checking on exactly the
      // deployment shape the beta runs. With 30 travellers hunting the same
      // town, matrix-compiled openers differing only by seed then land on the
      // same shops from many numbers through one egress IP: the clustering
      // signature the whole uniqueness layer exists to prevent.
      //
      // Same source the engine's own send path uses (recentOutboundGlobal):
      // one bounded fleet-wide read, and a failure degrades to the old
      // empty-list behaviour rather than blocking the send.
      const recent = await sbSelect<{ body: string | null }>(
        "whatsapp_messages",
        `select=body&direction=eq.outbound&received_at=gte.${encodeURIComponent(
          new Date(Date.now() - 6 * 3600_000).toISOString()
        )}&order=received_at.desc&limit=200`
      )
        .then((rows) => rows.map((r) => r.body ?? "").filter(Boolean))
        .catch(() => [] as string[]);
      outboundText = (await ensureGloballyUnique(compiled, recent)).text;
    } catch {
      /* keep the client message on any failure */
    }
  }

  // ULTRA local-language: the FIRST message must also be in the shop's own
  // language, not just later bargains (this was the "local language doesn't
  // work" gap - the RFQ always went out in English). Bargain drafts arrive
  // already localized by composeBargain, so only localize agent RFQs here.
  //
  // AND A MESSAGE THE TRAVELLER TYPED THEMSELVES, TOO (M26). This gate read
  // `isAuto && kind === "rfq"`, so on a local-language hunt the agent wrote
  // Thai and the traveller's own hand-typed line went out in English - into
  // the same thread, from the same number, one message apart. The shop sees
  // one person switching languages mid-conversation, which is exactly the tell
  // the thread-language lock above exists to prevent. The gloss comes back
  // with it, so the card can still show the traveller what was sent for them.
  const localizeThis = wantsLocal && ((isAuto && kind === "rfq") || kind === "custom");
  if (localizeThis) {
    const { localizeMessage } = await import("@/lib/agents");
    // countryForShop, NOT regionForShop (owner report 4): the latter knows
    // only four SE-Asia markets, so a +52 Mexico opener went out in English
    // with a false "AI localization unavailable" reason - the AI was never
    // asked. The full phone-prefix map asks it for every country; the
    // English-speaking ones short-circuit inside localizeMessage.
    const { countryForShop } = await import("@/lib/copy/region");
    // W4.7 - THREAD POSITION FOR THE LOCALIZER. `established !== null` means
    // this shop already has an open thread with us (the language lock read the
    // thread's first outbound to compute it), so a "custom" line, or a second
    // search reaching the same shop, must NOT be given a fresh local greeting -
    // rule 1 of the localize prompt orders one unless it is told otherwise, and
    // the deterministic strip at the send-time choke point reads English only.
    const localized = await localizeMessage(
      outboundText,
      countryForShop(digits, String(body.region ?? "")),
      session.email,
      true,
      { greet: kind === "rfq" && established === null }
    );
    if (localized.english && localized.text !== outboundText) englishGloss = localized.english;
    // DOCUMENTED fallback: if localization declined or failed, the opener
    // goes out in English and the TRUE reason is durably recorded - a
    // language flip is never a silent mystery, and the AI is never blamed
    // for a country we could not resolve. ("english-region" is a decision,
    // not a failure - no event.)
    if (!localized.localized && localized.reason !== "english-region") {
      await sbInsert("agent_events", [
        {
          kind: "localize-fallback",
          vendor_id: vendorId,
          vendor_name: vendorName,
          detail: JSON.stringify({
            email: session.email,
            region: String(body.region ?? ""),
            reason: localized.reason ?? "ai-unavailable",
          }).slice(0, 800),
        },
      ]).catch(() => {});
    }
    outboundText = localized.text;
  }

  // CONNECTION FIRST (same rule as mass outreach): if the user has no WhatsApp
  // channel at all, say exactly that - never queue the message and tell them
  // "the shop is closed" when the real problem is on our side.
  {
    // Gate on EVER-PAIRED (hasSessionRow), NOT the live socket state
    // (wasEverConnected). A transient Evolution-host outage must never tell a
    // linked user to "connect first" - the send path (sendFromUser) already
    // returns an honest "reconnecting" state when the socket is momentarily
    // down. connect:true is reserved for a user who has genuinely never linked.
    const { evolutionConfigured, hasSessionRow } = await import("@/lib/evolution");
    const { whatsappConfigured } = await import("@/lib/whatsapp");
    const personal =
      (await evolutionConfigured()) && (await hasSessionRow(session.email));
    const cloud = await whatsappConfigured();
    if (!personal && !cloud) {
      return NextResponse.json(
        {
          allowed: true,
          sent: false,
          connect: true,
          error: "Your WhatsApp is not connected - open Profile and link it first.",
        },
        { status: 400 }
      );
    }
  }

  // CONCURRENT CAMPAIGNS: the paid concurrency lever, finally enforced.
  //
  // `PlanCapacity.concurrentCampaigns` has been in the type since Module 6 with
  // a comment calling it "a separate, sellable concurrency lever" - and no call
  // site ever read it, so a free account ran as many parallel hunts as it liked
  // and the paid tiers sold nothing. A campaign is a search session's cold
  // outreach; adding another shop to a hunt already in flight is always allowed
  // (see campaignVerdict), only a NEW hunt beyond the plan is refused.
  if (kind === "rfq") {
    const { campaignVerdict } = await import("@/lib/wa/campaigns");
    const pending = await sbSelect<{ meta: { kind?: string; campaign?: string } | null }>(
      "wa_outbox",
      `select=meta&sender_key=eq.${encodeURIComponent(session.email)}&limit=200`
    ).catch(() => []);
    const verdict = campaignVerdict(
      normalizePlan(session.plan),
      pending.map((r) => ({ kind: r.meta?.kind, campaign: r.meta?.campaign })),
      body.campaign
    );
    if (!verdict.allowed) {
      return NextResponse.json(
        {
          allowed: false,
          sent: false,
          upgrade: true,
          reason: "concurrent-campaigns",
          error: verdict.reason,
        },
        { status: 429 }
      );
    }
  }

  // FUNNEL LEDGER: the traveller explicitly asked THIS shop - intent, not
  // delivery (delivery stamps `contacted` below / in the drain). restart:true
  // because a fresh Ask on a shop from an earlier hunt genuinely restarts the
  // funnel; the ledger still refuses to resurrect a hard terminal. Stamped
  // AFTER the admission checks so a refused request records nothing, and
  // BEFORE the guard so a queued send still shows the shop as selected.
  if (kind === "rfq") {
    const { advanceThreadStage } = await import("@/lib/funnel/stages");
    await advanceThreadStage(
      { userEmail: session.email, toNumber: digits, vendorId, vendorName, transport: "evolution" },
      "selected",
      "traveller asked this shop for a price",
      { restart: true }
    ).catch(() => {});
  }

  // THE COMPANY WIRE (Wave 6). resolveTransport says which wire carries this
  // thread's FIRST contact: the thread's own stamp first (immutable), the
  // owner's TRANSPORT_MODE second, Evolution by default. Only a cold RFQ may
  // ride the WABA lead handoff - bargains and customs continue on the thread's
  // existing wire, and the reply leg of a handed-off thread is still the
  // traveller's own WhatsApp (the handoff's whole point is that the shop
  // messages the traveller). This sits ABOVE guardOutbound/claimForSend on
  // purpose: those govern the traveller's number, and a company-wire send is
  // governed by the WABA governor + admission inside dispatchHandoff instead.
  if (kind === "rfq") {
    const { resolveTransport } = await import("@/lib/wa/transports");
    const resolved = await resolveTransport(session.email, digits).catch(() => null);
    if (resolved && resolved.transport.kind === "waba") {
      const { dispatchHandoff } = await import("@/lib/waba/dispatch");
      const { rfqLabels } = await import("@/lib/waba/render");
      const labels = rfqLabels(settledRfq);
      const out = await dispatchHandoff({
        userEmail: session.email,
        agencyNumber: digits,
        agencyName: vendorName || undefined,
        sessionId: body.campaign ? String(body.campaign) : undefined,
        vehicle: labels.vehicle,
        dates: labels.dates,
        freeformText: outboundText,
        rfq: settledRfq ?? undefined,
        vendorId: vendorId || undefined,
      });
      // A DRY RUN rehearses the WABA funnel without contacting anyone - the
      // traveller's real enquiry must still go out, so a rehearsal falls
      // through to the legacy lane below (as do an explicit fallback-legacy
      // and any refusal the traveller's own number can still serve).
      const rehearsal = out.outcome === "sent" && out.reason === "dry-run";
      if (out.outcome === "sent" && !rehearsal) {
        // The truthful anchor row + the `contacted` funnel stamp were written
        // inside the dispatcher; nothing here needs to double-record them.
        return NextResponse.json({
          allowed: true,
          sent: true,
          configured: true,
          channel: "waba",
          phone: to,
          logged: true,
          note: out.userMessage,
          notice,
        });
      }
      if (out.outcome === "held") {
        // Contactable on the company wire, just not right now - the lead
        // flushes free the moment the agency answers anyone. Queued, not
        // failed; the move window stays spent (a queued move is a move).
        return NextResponse.json({
          allowed: true,
          sent: false,
          configured: true,
          channel: "waba",
          queued: true,
          queuedReason: out.reason,
          error: out.userMessage,
          notice,
        });
      }
      if (out.outcome === "refused" && out.reason === "suppressed") {
        // No lane may contact this shop (fleet-wide opt-out). Say so here
        // rather than letting the legacy guard repeat it with less context.
        await releaseMove();
        return NextResponse.json({
          allowed: true,
          sent: false,
          suppressed: true,
          error: "This shop asked not to be contacted - your agent will leave it alone.",
        });
      }
      // fallback-legacy / other refusals / dry-run: the traveller's own wire.
    }
  }

  const { guardOutbound, afterSend } = await import("@/lib/wa-guard");
  const guard = await guardOutbound({
    senderKey: session.email,
    toDigits: digits,
    text: outboundText,
    auto: isAuto,
    queueIfBlocked: true,
    region: String(body.region ?? "") || undefined,
    // The client passes the shop's live Google "open now" state so the gate
    // agrees with the badge the user sees on the card (fixes false "closed").
    shopOpenNow: typeof body.openNow === "boolean" ? body.openNow : undefined,
    meta: {
      sender: session.email,
      vendorId,
      vendorName,
      kind,
      round: Number(body.round ?? 0),
      rfq: settledRfq ?? null,
      // WHICH HUNT this introduction belongs to (the search epoch). Read back
      // by the concurrent-campaigns check above - without it, every queued row
      // would look like the same anonymous campaign.
      ...(body.campaign ? { campaign: String(body.campaign) } : {}),
      region: String(body.region ?? ""),
      plan: session.plan,
      localLang: wantsLocal,
      // Carried on the queued outbox row so the card's thread peek can show
      // the English reading of a held local-language message.
      ...(englishGloss ? { englishGloss } : {}),
    },
  });
  if (!guard.allow) {
    // A refusal with nothing queued means no move happened - give it back.
    if (!guard.queuedUntil) await releaseMove();
    // FUNNEL LEDGER: the guard parked the RFQ - the shop is queued, not
    // contacted (the drain stamps `contacted` when the row actually delivers).
    if (guard.queuedUntil && kind === "rfq") {
      const { advanceThreadStage } = await import("@/lib/funnel/stages");
      await advanceThreadStage(
        { userEmail: session.email, toNumber: digits, vendorId, vendorName, transport: "evolution" },
        "contact_queued",
        `RFQ parked: ${(guard.reason ?? "guard hold").slice(0, 80)}`
      ).catch(() => {});
    }
    const halted =
      (guard.reason ?? "").startsWith("engagement-halt") ||
      (guard.reason ?? "").startsWith("rfq-dedup");
    return NextResponse.json({
      allowed: true,
      sent: false,
      queued: Boolean(guard.queuedUntil),
      queuedUntil: guard.queuedUntil,
      // The guard's REAL reason - the card renders it honestly (a pacing hold
      // must never be shown as "shop closed").
      queuedReason: guard.queuedUntil ? guard.reason ?? null : null,
      halted,
      error: halted
        ? "This shop was already asked - your agent keeps the existing conversation going instead of re-sending the question."
        : guard.queuedUntil
        ? /closed|business hours/i.test(guard.reason ?? "")
          ? "The shop is closed right now - your message is queued and will be sent when they open."
          : "Queued for a moment - your agent paces messages like a human so your number stays safe."
        : guard.reason,
    });
  }
  const guardedMessage = guard.text;

  // Channel priority:
  //   1. The user's OWN WhatsApp (Evolution QR session) - the most authentic
  //      sender a bargain can have, with strict anti-ban rate limits.
  //   2. The official Meta Cloud API (owner-level business number).
  //   3. Neither connected -> the UI falls back to copy-paste, still in-app.
  let result: {
    channel: string;
    ok: boolean;
    error?: string;
    rateLimited?: boolean;
    unconfirmed?: boolean;
    messageId?: string;
    chatJid?: string;
    /** status-0 timeout - may have landed; keep the claim, never blind-retry. */
    ambiguous?: boolean;
  } = {
    channel: "none",
    ok: false,
  };
  let configured = false;

  // ATOMIC SEND SLOTS, claimed BEFORE the network send: two concurrent
  // identical requests (double-tap, retried fetch) can never both deliver -
  // the old dedup row was only written AFTER a successful send, so both
  // passed the pre-flight together. Auto sends also take the pacing slot.
  {
    const { claimForSend } = await import("@/lib/wa-guard");
    const claim = await claimForSend(session.email, digits, guardedMessage, isAuto);
    if (!claim.ok && claim.kind === "duplicate") {
      return NextResponse.json({
        allowed: true,
        sent: false,
        duplicate: true,
        reason: "This exact message is already on its way to the shop.",
      });
    }
    // THE AGENT IS MID-SENTENCE WITH THIS SHOP.
    //
    // A human send now takes the per-recipient mutex too (see wa/pacing.ts):
    // the traveller tapping Bargain while an agent turn is going out is the
    // likeliest version of two-messages-in-one-minute, because the app invites
    // the tap exactly when a thread is active. Losing that lock is not a pacing
    // hold to bury in the queue - the traveller is standing there - so say what
    // happened. The card already renders this state ("Your agent is on it").
    if (!claim.ok && claim.kind === "recipient-busy") {
      return NextResponse.json({
        allowed: true,
        sent: false,
        agentBusy: true,
        reason: "Your agent is mid-message with this shop - give it a few seconds.",
      });
    }
    if (!claim.ok) {
      // pacing loss / unknown claim state: park honestly instead of racing.
      const { jitteredHold } = await import("@/lib/wa/pacing");
      const notBefore = jitteredHold(Date.now(), 1, 2);
      await sbInsert("wa_outbox", [
        {
          sender_key: session.email,
          to_number: digits,
          ...(await outboxToKeyPatch(digits)),
          body: guardedMessage,
          not_before: notBefore,
          meta: {
            sender: session.email,
            vendorId,
            vendorName,
            kind,
            reason: claim.kind === "pacing" ? "human pacing gap" : "sync-retry",
          },
        },
      ]).catch(() => {});
      // FUNNEL LEDGER: parked on a pacing/sync hold - queued, not contacted.
      if (kind === "rfq") {
        const { advanceThreadStage } = await import("@/lib/funnel/stages");
        await advanceThreadStage(
          { userEmail: session.email, toNumber: digits, vendorId, vendorName, transport: "evolution" },
          "contact_queued",
          claim.kind === "pacing" ? "RFQ parked: human pacing gap" : "RFQ parked: sync-retry"
        ).catch(() => {});
      }
      return NextResponse.json({
        allowed: true,
        sent: false,
        queued: true,
        queuedUntil: notBefore,
        queuedReason: claim.kind === "pacing" ? "human pacing gap" : "sync-retry",
      });
    }
  }

  // Try the user's personal WhatsApp whenever the connector is set up.
  // sendFromUser itself verifies the live session (auto-resuming a dropped
  // one), so we never wrongly tell a connected user to "connect first" just
  // because a bookkeeping row is missing.
  if (await evolutionConfigured()) {
    configured = (await wasEverConnected(session.email)) || false;
    // One tapped send with the traveller on the card - the jitter would only
    // be latency they can see.
    const r = await sendFromUser(session.email, digits, guardedMessage, true, {
      skipJitter: true,
    });
    if (r.ok || r.error === "reconnecting" || r.rateLimited) configured = true;
    result = {
      channel: "personal-wa",
      ok: r.ok,
      error: r.error,
      rateLimited: r.rateLimited,
      unconfirmed: r.unconfirmed,
      messageId: r.messageId,
      chatJid: r.chatJid,
      ambiguous: r.ambiguous,
    };
    if (r.rateLimited) {
      const { releaseSendClaim } = await import("@/lib/wa-guard");
      await releaseSendClaim(session.email, digits, guardedMessage).catch(() => {});
      await releaseMove();
      return NextResponse.json({
        allowed: true,
        sent: false,
        configured: true,
        channel: "personal-wa",
        rateLimited: true,
        error: r.error,
      });
    }
    if (r.error === "reconnecting") {
      const { releaseSendClaim } = await import("@/lib/wa-guard");
      await releaseSendClaim(session.email, digits, guardedMessage).catch(() => {});
      await releaseMove();
      return NextResponse.json({
        allowed: true,
        sent: false,
        configured: true,
        channel: "personal-wa",
        reconnecting: true,
        error:
          "Your WhatsApp is reconnecting (the server was waking up). Wait a few seconds and tap again - no need to re-link.",
      });
    }
  }
  if (!result.ok && (await whatsappConfigured())) {
    configured = true;
    const r = await sendWhatsApp(to, guardedMessage);
    result = { channel: r.channel, ok: r.ok, error: r.error };
  }
  if (result.ok) {
    await afterSend(session.email, digits);
  } else if (!result.ambiguous) {
    // Failed send: release the idempotency claim so the user's retry tap is
    // not swallowed as a "duplicate" of the failure.
    const { releaseSendClaim } = await import("@/lib/wa-guard");
    await releaseSendClaim(session.email, digits, guardedMessage).catch(() => {});
    await releaseMove();
  }
  // AMBIGUOUS (status-0 timeout): the message may already be on the shop's
  // phone. Keep the idempotency claim and do NOT release the move - a retry
  // that duplicated a delivered intro is exactly what this guards against.

  // TRUTH RULE: the outbound whatsapp_messages row is the record every
  // surface (thread peek, activity feed, deals dashboard, contacted counts)
  // treats as "a message reached this shop". A FAILED send must therefore
  // never write one - it used to (raw.ok:false), which made the UI count
  // shops as contacted when nothing was delivered.
  let logged = true;
  if (result.ok) {
    // Log the outbound message WITH thread context (vendor + rfq), so the
    // webhook can match the inbound reply and keep the loop fully in-app.
    //
    // BOOKKEEPING MUST NEVER FAIL A DELIVERED SEND. This await had no catch, so
    // a Supabase hiccup AFTER the message had left WhatsApp threw out of the
    // handler - the traveller was told the server could not be reached about a
    // message the shop had already received, and tapping again was the natural
    // response. The row is important, but it is not the send: record the loss
    // and answer honestly instead.
    const wroteLog = await sbInsert("whatsapp_messages", [
      {
        // Provider id -> the webhook echo-check matches by id, never by body.
        wa_message_id: (result as { messageId?: string }).messageId ?? null,
        to_number: digits,
        body: guardedMessage,
        type: "text",
        direction: "outbound",
        raw: {
          channel: result.channel,
          // Which wire carried it (one vocabulary: evolution | cloud | waba).
          transport: result.channel === "cloud-api" ? "cloud" : "evolution",
          sender: session.email,
          ok: true,
          // false when Evolution accepted the request but returned no delivery
          // receipt - the card shows "sent, unverified" instead of a checkmark.
          confirmed: result.unconfirmed ? false : true,
          vendorId,
          vendorName,
          kind: String(body.kind ?? "custom"),
          round: Number(body.round ?? 0),
          rfq: settledRfq ?? null,
          region: String(body.region ?? ""),
          plan: session.plan,
          localLang: wantsLocal,
          // English gloss of a localized message so the traveller can read
          // what their agent sent on their behalf (card thread peek).
          ...(englishGloss ? { englishGloss } : {}),
          // The chat's privacy identity, when the provider reported one -
          // the outbound anchor is what resolves the shop's FIRST @lid reply.
          ...(lidKey(result.chatJid) ? { lid: lidKey(result.chatJid) } : {}),
        },
      },
    ]);
    // sbInsert RETURNS false on failure - it never rejects, so the old .catch
    // was dead code and `logged` reported true even when the row was lost.
    // Check the boolean: the message left WhatsApp but our record of it did not
    // reach the DB, so the reply may later die as `no-rfq-thread`.
    if (!wroteLog) {
      logged = false;
      await sbInsert("agent_events", [
        {
          kind: "outbound-log-failed",
          user_email: session.email,
          to_number: digits,
          vendor_id: vendorId,
          vendor_name: vendorName,
          detail: JSON.stringify({
            email: session.email,
            channel: result.channel,
          }).slice(0, 800),
        },
      ]).catch(() => {});
    }
    // FUNNEL LEDGER: the message reached the shop (the TRUTH RULE row above is
    // the evidence) - an RFQ is the contact, a bargain is the negotiation.
    if (kind === "rfq" || kind === "bargain") {
      const { advanceThreadStage } = await import("@/lib/funnel/stages");
      await advanceThreadStage(
        { userEmail: session.email, toNumber: digits, vendorId, vendorName, transport: "evolution" },
        kind === "rfq" ? "contacted" : "negotiating",
        kind === "rfq" ? "RFQ delivered to the shop" : "traveller-sent bargain delivered"
      ).catch(() => {});
    }
  } else {
    // Keep the failure observable without polluting the "sent" record. Stamp the
    // join columns so the trail (messagePath) and the per-user safety signals
    // can actually find it.
    await sbInsert("agent_events", [
      {
        kind: "send-failed",
        user_email: session.email,
        to_number: digits,
        vendor_id: vendorId,
        vendor_name: vendorName,
        detail: JSON.stringify({
          email: session.email,
          channel: result.channel,
          error: result.error ?? "unknown",
        }).slice(0, 800),
      },
    ]).catch(() => {});
  }

  return NextResponse.json({
    allowed: true,
    sent: configured && result.ok,
    configured,
    channel: configured ? result.channel : "unconfigured",
    error: result.error,
    phone: to,
    // false when the message reached the shop but our record of it did not
    // reach the database - the transcript may be a message short.
    logged,
    // Present only on a nudge: the plan rule, explained, on a message that was
    // sent anyway.
    notice,
  });
}

// maxDuration: lift the request-timeout ceiling for slow AI/WhatsApp upstreams.
export const maxDuration = 60;
