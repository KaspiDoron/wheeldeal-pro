# WheelDeal - Production Readiness & Scale Review

Date: 2026-08-14 (owner report 4 pass) · Branch: `claude/rental-agents-legal-setup-o7rgcv`
Scope: queue architecture, concurrency, rate limiting, test mode,
observability, cost control and the concrete path to hundreds of concurrent
users. Complements `docs/ENTERPRISE-READINESS.md` (the earlier QA pass).

> **Companion document:** `SCALING.md` is the same territory written for the
> OWNER rather than for a reviewer - per service, what the limit is today, what
> breaks at 100/300/500 simultaneous users, what to buy, and which button in
> Admin -> Keys proves it worked. This file stays the engineering review; that
> one is the runbook. The four ceilings it orders are the four readings on the
> Keys tab's choke-point card.

> **READ THIS FIRST IF YOU ARE ABOUT TO CHANGE `wa-guard.ts`, the usage limits
> or the outbox/wakeup draining.** That instruction (in `CLAUDE.md`) is only
> worth following while this file is TRUE. Owner report 4 changed all three,
> so the next section states exactly what moved; the sections below it have
> been corrected in place.

## Executive summary

The platform is architecturally sound for the private beta: every queue claim
is atomic at the database level (no double-sends across serverless
instances), inbound WhatsApp events are deduplicated exactly-once, per-user
isolation is enforced consistently by `user_email`/`sender_key` filters, and
the anti-ban engine's budgets are conservative. The remaining scaling
constraint is operational: queue draining depends on user traffic plus ONE
external cron, and the hottest table (`whatsapp_messages`) needed two more
indexes (added in this pass).

**Three cost/safety gaps that this document previously listed under P2 have now
been closed, and one of them was materially worse than described here.**
`LIMIT_AI_PER_DAY` was not merely "bypassed by background wakeups" - it
governed exactly one route, and that route never debited, so the counter was
permanently zero and the cap could not fire at any call site. The owner's "AI
calls per day" slider reported that spend was capped while capping nothing. See
P2 #2, #5 and #6 below for what shipped, including the honest caveat that the
atomic cap is a no-op without `REDIS_URL`.

Verdict: **safe for the 25-tester beta today; complete the P1 runbook before
paid public signups; the remaining P2 items before hundreds of concurrent
users.**

## What owner report 4 changed (Waves 1-3, 2026-08-14)

Three waves shipped against this document's own P2 list and the anti-ban
review. What follows is the delta; everything else below still stands.

**Reply delivery (W2.1).** Every hold an ENGAGED reply could hit that exceeded
~2 minutes is now lane-proportional - the daily-cap resume no longer snaps a
reply to business hours, a risk-pause re-checks replies in 10-15 min instead
of holding them the full 240, the five fail-closed `sync-retry` sites hold a
reply 1-2 min (cold keeps 5-10), duplicate-claim holds are 30s for replies,
and the inline claim-loss re-park is 20-40s. The engagement halt can no longer
TERMINALLY drop a reply that was composed against a real inbound (a probe
misread used to delete it). **The Next runtime now has its own drain armer**
(`wa/drain-armer.ts`): a bounded in-process timer whose only action is an HTTP
self-kick of the per-sender reply dispatcher, so a reply parked 20-40s out
lands then rather than on the next cron minute.

**The number that was missing.** `turn-latency` measures compose time plus the
delay we INTENDED. The drain now also stamps `reply-latency` =
`delivered - composedAgainst.inboundAt`, the latency that HAPPENED, so the gap
between the two is the queue, visible in the WA doctor and the launch card.

**Media (W2.3).** Multi-image bursts coalesce on the runtime that actually
runs (`wa/image-burst.ts` - the DB is the buffer; the newest frame of a burst
runs ONE turn holding every frame), with a per-frame/per-request byte budget
and honest truncation events. Native video, PDF rate cards, captioned voice
notes, the Whisper language hint, and audit copies of every fetched frame.

**Local language (W2.4).** `countryForShop` replaced the 4-country ceiling, so
localization is attempted for every country; failures name a true reason and
an AI outage SUPPRESSES a local-language bargain rather than sending fluent
English mid-negotiation.

**Anti-ban (W3.1).** Read receipts (`markMessageAsRead` on a humanized 2-7s
delay, batched in parallel, failures counted), presence failures traced,
fingerprint refreshed and baked into `deploy/evolution/Dockerfile`, a
datacenter-IP cluster banner, and the webhook re-arm throttle moved to a
shared config row. `ANTI-BAN.md` carries the detail AND the accepted residual
risks.

**Scale (W3.2).** See the corrected P2 list below: the Cloud Run shape,
`REDIS_URL` delivery, retention, the RPM budgeter, the inbound concurrency
gate and the launch KPI card all landed.

## How work actually gets done (queues & workers)

- **Outbound queue** (`wa_outbox`): rows are claimed with an atomic
  `DELETE ... RETURNING` - the DB row is the lock, so N concurrent instances
  can never double-send. Failed sends re-queue with backoff, and the two
  classes differ: a RECIPIENT failure backs off `min(attempts x 4, 20)` minutes
  (4/8/12/16/20) for at most 5 attempts, then a durable `wa-send-dropped`
  event; a TRANSIENT/infra failure retries in 45-120s for up to 60 attempts
  across a 24h lifetime and burns no attempt cap. Selection per drain call is
  24 reply candidates + 48 general, spending 2 cold intros per sender and a
  reply budget of 6.
- **Strategic waits** (`graph_wakeups`): identical atomic-claim pattern. Rows
  are stamped with `user_email` so owner-scoped purges are exact matches (the
  old `thread_key LIKE email:%` pattern treated `_` in emails as a wildcard).
- **Who drains** (corrected, owner report 4): every activity poll from any open
  app, every webhook tail, the replies/status polls, `/api/wa/ping` hit by
  **Cloud Scheduler** (provisioned by the deploy workflow itself - the external
  cron-job.org pinger is now a redundant backstop, not the only timer), the
  per-sender `/api/wa/reply-tick` dispatcher kicked by ingest, and the
  **in-process drain armer** (`wa/drain-armer.ts`) that HTTP-self-kicks that
  dispatcher at the exact moment a parked reply comes due.
  `/api/queue` (the queued-messages VIEWER) deliberately does
  NOT drain - opening the list to review or remove messages must never be the
  event that sends them. On a serverless free tier a cron might run at most
  once per day, so the external pinger was the fallback there - but it is a single
  point of failure: if it lapses, queued messages only move while someone has
  the app open. **Action: keep two independent pinger services pointed at
  `/api/wa/ping` (5-10 min).**
- **Self-chaining drain** (`/api/wa/tick`, token-gated): kicked by every
  mass-bargain run and every ping-cron hit. One invocation drains, rides out
  a stagger step in-process (<=45s), then fire-and-forgets ONE call to
  itself while near-term work remains (hop-bounded ~40, single-runner via a
  30s chain claim). Result: a staggered batch keeps progressing for ~30 min
  after any trigger even with every app closed. Backstops unchanged:
  activity polls (app open) + the external pinger. Stalls are VISIBLE now:
  rows overdue >5 min surface an in-app "sending fell behind - catching up"
  banner instead of silently creeping ETAs.
- **New-contact budget is a PLAN-TIERED ROLLING WINDOW** (`src/lib/wa/
  capacity.ts`): free 10 new shops/6h, pro 20/4h, ultra 24/3h. Capacity
  refreshes CONTINUOUSLY as the oldest introduction ages out of the window -
  there is no hard "everything waits until tomorrow (UTC midnight)" wall any
  more. When the budget is spent, holds anchor to when the next slot frees
  (`newContactBudget().nextFreeAt`, clamped into the shop's business hours).
  Admission is the MINIMUM OF FOUR ceilings and the hold length follows
  WHICHEVER is binding (`IntroBudgetBind`): the plan window is at most
  windowHours away and never tomorrow, but Meter A - introductions nobody has
  answered - clears when a SHOP REPLIES or when the oldest silent one turns
  7 days old, so it anchors there and re-checks every 12h under honest
  "waiting on replies" copy rather than promising capacity that is not coming.
  A row held on a slow ceiling has its freshness stamp cleared so the 6h outbox
  ceiling cannot bin it for serving a wait we gave it; the 24h absolute wall
  still bounds it. The
  window is counted migration-free from timestamped outbound RFQ rows
  (`whatsapp_messages.raw->>kind=rfq`), so no schema change is needed.
  **`max_new_contacts_per_day` is a fifth, OWNER-SET ceiling and it is OFF
  (0) by default.** A fixed daily cap is the model the rolling window
  replaced - crushed by the warm-up ramp it gave a fresh number ~2 shops for a
  whole day and parked the rest until tomorrow morning. It is wired and it
  works, so an owner can clamp the whole fleet during an incident (10-15 holds
  every number to the week-one warm-up band), but it must never be left on by
  accident: at any positive value it silently overrides every plan's window. Plans
  are now REAL: `dynamicHourCap` and the new-contact cap both scale with the
  plan (Ultra gets 24/h headroom vs free's 10/h), so `vip-concurrency` finally
  does something. Warm-up is humane: the ramp floor is 50% (not the old ~14%
  day-0 that let a fresh number reach only ~2 shops/day). Mass bargain
  computes the remaining budget AT CLICK TIME: in-budget shops start
  immediately (first now, 45-75s stagger), over-budget shops park on the
  rolling anchor and the user sees a "next slot in ~Xh" countdown. Duplicate
  pending rows per shop are refused at enqueue.
- **Hourly-cap holds no longer creep**: an over-cap send now anchors to when
  the rolling hour actually frees (oldest in-window send + 1h + <=3min
  jitter), a fixed future instant - not a fresh `now+15-35min` re-stamped on
  every drain (the residual "came back later, everything moved another 30 min"
  path, which the daily fix in the prior round had left on the hourly cap).
  Burst tolerance scales with the plan's hourly headroom (the 50-120s min-gap
  already spaces a paced batch, so it is not a robotic flurry).
- **Cancellation tombstones** (`wa_cancellations`, unique on sender+number):
  written when a user removes queued messages, clears a search, or closes a
  deal. `guardOutbound` REFUSES automated sends to a tombstoned recipient
  (rule -2, plus a last-instant re-check right before the network send in
  both drain paths), so outbox re-queues, wakeup re-compositions and retries
  are all covered - removal is permanent until the user explicitly sends to
  that shop again (outreach / mass / consent / close-deal clear the
  tombstone). Human takeover is enforced at the same choke point AND the
  takeover event purges that thread's outbox rows + tick wakeups. Read
  semantics are strict: a missing table is vacuously "not cancelled", but a
  transient read failure is UNKNOWN and automated sends fail CLOSED (queued
  `sync-retry`, +5-10 min). Kill switch: `CANCEL_GUARD=off` (Admin - Keys)
  disables enforcement while writes continue.

## Rate limiting & anti-ban budgets (as shipped)

> DOC PIN: every number below is asserted against the live constants
> (`PLAN_CAPACITY`, `getPolicies()` defaults, the usage lane limits) by
> `src/lib/wa/readiness-numbers.test.ts`. Change code and doc together or the
> gate goes red - this section drifted from the code once before and shipped
> five stale numbers.

Per user daily: 5 searches, 300 geocodes, 300 AI calls. WhatsApp sends run in
two lanes: cold introductions 24/hour and 80/day, replies 40/hour and 200/day.
Anti-ban per number: base 4/hour growing to 14/hour with trust, with the
hourly velocity floor pinned to the plan budget (free 10/h, pro 20/h, ultra
24/h) so a within-budget batch never splits across hours; 220/day ceiling,
WARM-UP RAMPED (owner report 8 wave D): the all-lanes daily cap is
`day_cap x jitter x warmupNewContactFactor`, floored at 40, so a day-0 number
sits near 110/day and reaches 220 only once it is warm. Warm-up therefore no
longer ramps introductions ALONE - it moves the daily ceiling too. Ceiling
(±20% jitter); 12-28s jittered gaps on the cold lane and ~5s per engaged shop
on the reply lane; cold intros wait for the recipient's business hours 08-21
(replies are exempt; `FAST_DISPATCH` lifts it); plan-tiered rolling
new-contact window (free 10/6h, pro 20/4h, ultra 24/3h); auto-pause at risk
score 70 for 240 min. The warm-up ramp is REAL as of owner report 3: a
brand-new number starts at ~50% of its plan's introductions on day 0 (ultra
12, pro 10, free 5) and earns to 100% over 7 days, accelerated by an observed
reply rate. A shop that says "stop messaging me" (multilingual detection) is
opted out permanently - the guard refuses every future send, manual included.
`SCALE_MODE=on` triples the per-user budgets and relaxes client polling
(12s→25s activity, 15s→30s replies) - it does NOT change anti-ban pacing
(deliberate: number safety never scales down).

**Concurrency + herd hardening (wa_send_claims + jittered holds):**
- Every send claims two atomic slots in `wa_send_claims` (PK conflict = the
  lock): a per-sender min-gap bucket (serializes the 5+ concurrent drain
  callers - two invocations can no longer both pass the same stale gap
  check) and a per-message idempotency hash claimed BEFORE the network send
  (concurrent duplicates can no longer both deliver). Straddle-proof at
  bucket boundaries via a previous-bucket age check. Failed sends release
  their message claim so retries are not self-deduped. GC after 24h.
- Cap holds are JITTERED (hourly +15-35m, daily new-contact +60-90m, pause
  +60-75m): a held batch regains individual release times - never ten
  messages sharing one "~15:27" ETA again. Parked rows count toward the
  hourly cap only when due within the next hour (no cascade wedging).
- Mass bargain is a durable TRICKLE: shop 1 sends immediately, shops 2..N
  are parked with cumulative 45-75s jittered `not_before` stamps
  (`batch-spacing` + batchId/batchIndex/batchSize meta for the progress UI).
  The drain re-runs the full guard per row at its own time.
- The COLD lane is capped at 2 intros per sender per invocation; excess DUE
  rows are re-spaced forward with jitter (a stale backlog trickles out, never
  bursts). REPLIES drain concurrently on their own per-invocation budget of 6,
  capped at one per recipient - reciprocal traffic is the safe lane and is
  deliberately not held to the cold lane's pacing.
- FAIL-CLOSED reads: the guard's reputation + 24h-history reads are strict -
  a transient Supabase failure holds automated sends (`sync-retry`) instead of
  reading as "fresh number, nothing sent today" (the old behavior disabled the
  entire anti-ban engine exactly during outages). The hold is LANE-PROPORTIONAL
  since owner report 4: a reply re-checks in 1-2 min, a cold intro keeps 5-10.
  The safety posture is identical (nothing sends while the state is unknown);
  only the re-check cadence matches the lane. Manual sends stay permissive.
  Missing tables (pre-migration) degrade to today's behavior.
- Observability: `claim-lost` / `sync-retry` / `cancelled-send-blocked` /
  `takeover-send-blocked` agent_events; drain failures log tagged errors.
- Dev harness: `node scripts/hammer-queue.mjs` fires parallel drain storms +
  a racing delete at a local server to observe serialization.

## Connection lifecycle (Evolution)

- **Closing a deal keeps the WhatsApp link.** The old flow logged out AND
  deleted the instance after every closed deal (full QR re-link each time -
  the "my WhatsApp disconnected by itself" report). The session-closed
  marker + cancellation tombstones already silence the agents; teardown adds
  nothing. Rollback switch: `KEEP_WA_ON_CLOSE=off` restores the old
  behavior for one release. Explicit disconnect stays in Profile.
- **Connect re-entry is non-destructive for 90s.** A second Connect tap
  while a pairing is mid-handshake ("connecting", started <90s ago)
  re-polls the SAME instance for its current QR/pairing code instead of
  logout+delete (which destroyed the exact pairing the phone was completing).
  Stale or wedged pairings still get the clean recreate.
- Keep-alive remains the external pinger on `/api/wa/ping` (see above).

## Test mode - the honest truth table

| Area | TEST_MODE on (flagged tester) | Production |
|---|---|---|
| Plan | Ultra, free, instant | paid via PayPal |
| Checkout | sandbox - returns `{sandbox:true, applied:"ultra"}` and writes NOTHING; the entitlement comes from `getSession` deriving Ultra for a flagged tester, so a free grant cannot outlive the switch that granted it | real checkout |
| Banner | global strip visible | none |
| WhatsApp | **REAL** - messages go to real shops from the tester's number, real ban-risk budget | same |
| Google Places/geocode spend | **REAL** | same |
| AI token spend | **REAL** | same |
| Data | same tables (no reset mechanism - "may be reset" is a policy, not a feature) | same |

Implications: testers must treat WhatsApp hunts as real outreach to real
businesses. The banner copy now says exactly that. Kill switch + per-user
daily limits are the cost guard in both modes.

**Tester capacity - TWO independent ceilings, and they are not the same one.**

1. **The invite list**: `BETA_ALLOWLIST_MAX` in `src/lib/allowlist.ts`,
   currently **100** testers + owner, enforced on save (the env-var fallback
   list is uncapped). An over-long paste now REPORTS what it could not store
   instead of silently truncating, which is how the previous ceiling of 25 lost
   the tail of a list without telling anyone.
2. **The fleet**: `EVOLUTION_MAX_PER_HOST` (default **25** linked numbers per
   Evolution host) x the number of `EVOLUTION_HOSTS` entries. At the cap the
   app REFUSES a new link rather than overfilling - on a single-host deployment
   as well as a pooled one - and says "at capacity" rather than blaming the
   configuration.

**Supabase egress is a THIRD ceiling, and it is the one the audit ranked
first.** The free tier allows 5 GB/month and a restricted project takes the
whole app down, not one feature. Every previous plan ended with "watch the
Supabase usage graph during a real hunt", which needs a human present at the
moment traffic happens and leaves nothing behind. The app now counts its own
read-path bytes at the `sbSelect`/`sbSelectStrict` chokepoint and Admin -> Ops
-> choke points renders a 30-day projection against the 5 GB. It is an
estimate - read path only, and it over-states where transport compression is
active - and it refuses to project a month from less than 12 hours of traffic,
because a confident wrong number on a launch panel gets acted on where a dash
does not. **If it goes amber before an invite wave, decide on Supabase Pro
($25/mo) before the wave, not after the project is restricted.**

**Being invited is not a socket.** A tester past the fleet ceiling signs in
perfectly happily and then cannot link WhatsApp, which is the confusing half of
that failure. Admin -> Ops -> choke points now renders *"Invited testers vs
fleet capacity"* so the invite decision is a number on a screen rather than
arithmetic: 100 testers need **4 hosts** at the default per-host cap.
`deploy/fleet/README.md` is the $0 way to add them.

## Execution resilience (the "batch stopped after one send" fix)

The Evolution host is the single hard dependency for sending. When it blips
(the observed Render free-tier "wd-evolution HTTP health check failed" - free
instances sleep and can be replaced), sends fail transiently. The code now
survives that gracefully instead of stalling/losing the batch:

- **`drainOutbox` classifies failures** (`src/lib/wa/send-classify.ts`): a
  transient/infra failure (reconnecting, 5xx, timeout, unknown) retries in
  ~45-120s with NO attempt-cap burn, so a batch resumes within a minute of the
  host recovering. Only RECIPIENT failures (not-on-WhatsApp / invalid / blocked)
  count toward the 5-attempt give-up, whose event now names the shop. The prior
  behaviour deferred every failure 10/20/30/40/50 min then dropped it silently -
  that is what made "only one message sent, then it stalled".
- **Connection state is honest** (`hasSessionRow` fail-safe, no open->connecting
  clobber): a host outage reports *reconnecting*, never *not linked*, so the app
  never tells a connected user to re-link.

**Adversarial-sweep hardening (this pass) - drain can no longer lose a queued
message, and no external call can hang a handler:**

- **Age is the one drop the user did not ask for.** A queued row older than
  `OUTBOX_MAX_AGE_MS` (6h from when it first came due) or
  `OUTBOX_ABSOLUTE_MAX_AGE_MS` (24h from when it was composed, which nothing
  re-stamps) is binned with a `wa-send-expired` event - sending it would answer
  a question the traveller has moved on from. It is not silent, but it IS the
  only drop class that fires with no user action, so it belongs in any alert
  set. A row serving a deliberate long hold has its stamp cleared and is not
  charged for that wait.
- **A claimed row is never silently dropped** (`src/lib/wa/outbox-policy.ts`
  `needsRepark`, pinned by `outbox-policy.test.ts`). `drainOutbox` claims a due
  row by DELETING it, then re-runs the guard. Previously the daily-cap and the
  reply/delivery-rate circuit breakers returned a bare `{allow:false}` WITHOUT
  re-queuing, so the already-deleted row vanished ("sent a few, the rest
  disappeared"). Now: those branches `queue()` with a real rolling-window hold;
  every deliberate drop (cancelled / duplicate / rfq-dedup / takeover) is marked
  `terminal:true`; and the drain re-parks any reject that is neither queued nor
  terminal. A `send()` that throws is caught and re-queued too, so one bad send
  never abandons the rest of the batch.
- **The daily cap counts ACTUAL sends, not the sender's own parked backlog.**
  Counting parked rows toward the 24h volume cap made a legitimately-staggered
  40-shop batch trip its own ceiling (1 sent + 38 parked >= cap) and defer
  almost everything. Concurrency is already serialized by the send-claim rows;
  the hourly cap still counts due-soon pending for near-term pacing.
- **Every external fetch is time-bounded.** `evoFetch` (Evolution) now aborts at
  12s and Supabase's REST helpers (`runtime-config.ts` `timedFetch`) at 8s - a
  cold/asleep host or a stalled DB connection returns a transient failure the
  drain retries, instead of hanging a request until the platform kills the function
  (which, mid-drain, previously LOST an already-claimed row). Pinned by
  `hardening-invariants.test.ts`.
- **Pairing state is honest** (`isLinkedForUi` / `isLinkedFromStatus`, pinned by
  `linked-status.test.ts`): a not-yet-opened `connecting` session no longer
  reports `connected:true`. Previously `/api/wa/status`'s first 3s poll during a
  first-time link saw the `connecting` row via `hasSessionRow`, reported linked,
  and cleared the pairing code before the user could enter it. `/api/wa/status`
  and `/api/wa/health` now require a durable `open` (still fail-safe on a DB
  blip); the send path keeps `hasSessionRow`'s permissive semantics.
- **Cross-user isolation on wakeup purges/reads.** `graph_wakeups` filters moved
  off `thread_key=like.<email>:*` to the exact stamped `user_email=eq.` column,
  and `wa_sessions` reads off `email=ilike.` to `email=eq.` - an underscore in
  one user's email is a single-char SQL wildcard that could match (delete/read)
  a different registered user's rows. Pinned by `hardening-invariants.test.ts`.

**Owner infra action (the ~$10/mo ask):** the durable fix for the host itself is
to move the Evolution instance off Render's **free** tier to **Render Starter
(~$7/mo, no sleep, faster restart)** - this removes the recurring cold-start /
health-check-timeout that triggers the transient path in the first place. Pair
it with the two independent `/api/wa/ping` crons (below) at a 1-2 min cadence so
the outbox drains without depending on an open app. That combination (paid
always-on host + external cron + the health-aware retry above) reliably
progresses hundreds of concurrent users' queues; a dedicated worker/queue
(Upstash QStash free tier, or a Render background worker) is the P2 upgrade if
volume outgrows it, not a launch blocker.

## Before a paid public launch (P1) - the owner runbook

Everything in this section needs a human with credentials. No amount of code
closes any of it, which is exactly why it is written out as steps rather than
as advice. Do them in order; each one is independently verifiable.

### 1. Run `supabase/schema.sql`

Supabase dashboard -> SQL Editor -> paste the whole file -> Run.

Every statement is `create ... if not exists` / `add column if not exists`, so
it is additive and safe to re-run as many times as you like. It carries the
three hot-path indexes (`raw->>'sender'`, `from_number`,
`wa_outbox.sender_key`) and the feedback-thread additions (`feedback_replies`,
`feedback.user_seen_at`, `feedback_reporter_idx`).

Until it runs the app does not crash - feedback threads read empty and replies
simply do not persist - so a missing migration is silent. Verify rather than
assume:

```sql
select to_regclass('public.feedback_replies') is not null as feedback_ok,
       to_regclass('public.wa_outbox')        is not null as outbox_ok;
```

Both must be `true`. The messaging-capacity redesign needs no migration; the
rolling window is counted from existing `whatsapp_messages` rows.

### 2. Move Evolution off the Render free tier, and watch the pinger

Render -> the Evolution service -> Starter (~$7/mo). The free tier sleeps, and
a sleeping Evolution is a WhatsApp link that silently stops delivering.

Then a **second, monitored** pinger on `/api/wa/ping` (UptimeRobot / Better
Stack / a GCP Cloud Scheduler job), with an alert to a phone. Today the whole
background pipeline leans on one free host and one unmonitored external cron:
if that cron dies, nothing drains and nothing tells anyone. The point of the
second pinger is not redundancy of the ping - it is that someone finds out.

Verify: stop the primary cron for five minutes and confirm an alert arrives.
An untested alert is not an alert.

### 3. Error tracking with alerts on the three kinds that already exist

Wire Sentry (or equivalent), then alert on these `agent_events` kinds, which
the code already writes and which nobody currently reads:

| kind | what it means | urgency |
|---|---|---|
| `wa-send-dropped` | a message was composed and never delivered | page someone |
| `wa-ban-risk` | the anti-ban guard saw a pattern that risks the number | page someone |
| `wa-send-expired` | a queued message aged out and was binned undelivered | daily digest |
| `host-geo-mismatch` | a number was linked on a host that declares other regions - a scored WhatsApp signal, meaning the right region is out of capacity | daily digest |
| `media-fetch-failed` | a price-list image could not be fetched, so an offer was missed | daily digest |

```sql
select kind, count(*) from agent_events
where created_at > now() - interval '24 hours'
  and kind in ('wa-send-dropped','wa-ban-risk','wa-send-expired',
                'host-geo-mismatch','media-fetch-failed')
group by kind;
```

Right now that query is the only way anyone finds out. That is the gap.

### 4. PayPal live mode

In Admin -> Keys, set: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, both plan
ids (`PAYPAL_PLAN_PRO`, `PAYPAL_PLAN_ULTRA`), `PAYPAL_WEBHOOK_ID`, and
`PAYPAL_ENV=live`.

Then buy something. One real purchase, on a real card, end to end:

1. Check out from the pricing page and complete payment.
2. Confirm the plan applies in Admin -> Users.
3. Confirm the webhook round-trip landed (`webhooks/paypal` wrote its row).
4. Cancel, and confirm the downgrade lands too.

Sandbox credentials that work prove nothing about live ones, and the webhook id
is environment-specific - a live webhook verified against a sandbox id fails
signature verification and every subscription event is silently discarded.

### 5. Size the Evolution pool before the invites go out

One host carries **25 users** (`EVOLUTION_MAX_PER_HOST`, and at the cap the
app refuses rather than overfilling). Add hosts to the pool *before* invites
outgrow it, not after: the failure mode is not a queue, it is a banned personal
WhatsApp number, and that is not reversible by adding capacity later.

### 6. Turn off TEST_MODE, and check it is actually off

`TEST_MODE=on` gives flagged testers Ultra free and applies plans at checkout
with no charge. Launching with it on means taking no money while believing you
are. Admin -> Keys (or Admin -> Users) -> off, then confirm the global test
banner is gone from the public pages.

## For hundreds of concurrent users (P2)

1. **Dedicated worker for draining** (the GCE `scheduler.worker` drains every
   minute) + adaptive batch size (5 → 25) so the queue
   drains independently of user traffic.
   **Partly addressed without the VM (owner report 4):** Cloud Scheduler is
   provisioned by the deploy workflow, and `wa/drain-armer.ts` gives the Next
   runtime exact-moment arming via an HTTP self-kick. The worker VM would still
   raise throughput; nothing depends on it any more.
2. ~~**Atomic counters for limits**~~ - **SHIPPED.** `reserveDailyUnit` in
   `src/lib/usage.ts` is an atomic Redis `INCR` on `usage:<kind>:<who>:<day>`,
   so concurrent callers get distinct totals and only one crosses the line; a
   refusal hands its unit back. Postgres stays authoritative and Redis can only
   ever refuse MORE, so it is strictly a tightening.
   **Caveat, deliberately not hidden: with no `REDIS_URL` this is a no-op** and
   the read-then-write window is exactly as wide as it always was. A deployment
   without Redis has not had this fixed. Tests: `src/lib/daily-cap-atomic.test.ts`.
   **Owner report 4 delivery fix:** `REDIS_URL` is now passed through the Cloud
   Run deploy's optional-env list, so the caveat is a matter of SETTING the
   secret rather than of shipping code. Until it is set the caveat stands in
   full - and it matters more than it did, because `--max-instances` is now 20.
   The WA volume caps were examined and did NOT need the same treatment -
   `claimSendSlots` already serialises sends per sender through an atomic
   unique-constraint insert, so two concurrent volume-cap reads cannot both
   proceed. The reasoning is recorded as executable assertions in that same file.
3. ~~**Queue inbound webhook work**~~ - **BOUNDED, not offloaded (owner report
   4).** Each shop reply still runs the AI pipeline inside the webhook
   invocation, but no longer without a ceiling: `wa/inbound-gate.ts` caps heavy
   turns at 4 in flight PER INSTANCE, which is what stops `--concurrency 32`
   from turning a reply burst into 32 concurrent LLM chains on one 1GB
   instance. It is a smoother, not a limiter - a waiter past its patience
   window proceeds ungated, because a gate must never eat a reply. Full BullMQ
   offload remains the workers-VM upgrade path.
4. ~~**Retention jobs**~~ - **SHIPPED as `supabase/retention.sql`** (owner
   report 4). A 90-day pg_cron prune of `whatsapp_messages`, `agent_events`,
   `agent_traces` and `api_usage`, which KEEPS priced/read message rows (a
   photographed board is cross-thread leverage and golden-case material) and
   rolls `api_usage` up into `api_usage_daily` before pruning so the cost
   tracker keeps its history at ~1/1000th the rows. Idempotent; degrades to a
   NOTICE when pg_cron is not installed. **Owner action: run it once.**
5. ~~**Debit background AI**~~ - **SHIPPED, and it was worse than this entry
   said.** `LIMIT_AI_PER_DAY` was enforced at exactly ONE call site
   (`api/extract-offer`) and *that site never debited* - nothing anywhere wrote
   `recordApi("ai", ...)` - so the counter was permanently 0 and the cap could
   never fire at all. The engine, where essentially all token spend happens, had
   no gate of any kind. `src/lib/ai-budget.ts` now opens an AsyncLocalStorage
   scope at each turn/request boundary; every `chat()` inherits it at the choke
   point with no signature change, reserving per model call and debiting once on
   close. Over-cap degrades to the deterministic composer (a frozen negotiation
   is worse than a template-driven one); interactive routes still return a real
   429. Tests: `src/lib/ai-budget.test.ts`.
6. ~~**Config cache-bust**~~ - **SHIPPED.** `getConfigFresh` in
   `src/lib/runtime-config.ts` reads the safety-gate key as a single row by
   exact key on a 3s window, so a `KILL_SWITCH` flip reaches a warm instance in
   seconds instead of thirty. Concurrent callers share one in-flight read, so
   the cost does not scale with traffic. The fail-CLOSED semantics are
   unchanged - unreadable still means KILLED. Tests:
   `src/lib/kill-switch-latency.test.ts`, `src/lib/fail-closed.test.ts`.

## The deaf-session detector (W-18)

`session_deaf` was a declared risk kind that the dashboard SUMS
(`deaf: sum(buckets, "session_deaf")`) and that **nothing ever wrote**. The
tile could only ever read zero - an absent sensor rendering as good news, inside
the machinery built to catch exactly that.

`looksDeaf` (`wa/fleet-truth.ts`) was written for the condition and never
called: an instance that says `open`, that Evolution still lists (so keepalives
are fine), whose message count has **not moved while we were actively sending**.
It needs a prior sample, so nothing on the dashboard's live read could have
called it. The hourly rollup now carries one forward in
`wa_risk_snapshots.fleet` and emits the events.

Three ways of not knowing each darken instead of reporting "no deaf sessions":
`deaf:fleet-unreadable`, `deaf:no-prior`, `deaf:sends-unreadable`. **Run the
`fleet jsonb` migration** (it is an `add column if not exists`, safe to re-run)
or the detector stays permanently dark - which is honest, but blind.

## Two corrections to the anti-ban review

Recorded because both were carried as findings and neither survives contact
with the code:

- **"Four protections are exported and never called"** - not true as written.
  The check that produced it excluded each module's own file, so intra-file
  callers were invisible; `wa/proxy.ts`'s four (`countryFor`,
  `renderProxyTemplate`, `mintProxySessionId`, `stickyProxySession`) are all
  called by `templateProxyUrl`, which `evolution.ts:parseProxy` uses on every
  link. A proper sweep found **one** genuinely uncalled protection - `looksDeaf`,
  now wired above. The rest of the uncalled exports are dashboard tile helpers.
- **The `poissonPause` gap** was already fixed in an earlier wave (it was gated
  on `fast`, which every drain caller set); `skipJitter` is now its own flag.

## The cold-intro dial - DECIDED (owner, this cycle)

`FAST_DISPATCH` now defaults **off**. Cold introductions respect the recipient's
business hours; the whole batch no longer fires at 03:00.

What this does NOT slow down: **agent replies**. They skip the business-hours
clamp entirely - the block is gated on `isNewContact`, which closed the stall
where a reply re-guarded more than 30 minutes after the shop's last inbound
parked until 08:00 local. Reciprocal traffic is the side WhatsApp does not
meter: a shop that writes to you is answered in seconds, at any hour.

An unreadable `FAST_DISPATCH` config now keeps the OFF default
(`parseFlag(fastRaw, DEFAULTS.fast_dispatch)`), rather than the old hardcoded
`true`. A failed config read must not hand cold outreach a 24/7 licence.

The traveller is told WHY, not just that they are waiting: `queueReasonWhy`
(`src/lib/queue-reason.ts`) renders under the queued badge on the shop card. It
says the shop is closed, that a 3am first message is read at 9am anyway, that
night sending is what gets numbers restricted - and, load-bearing, that shops
already talking to them are answered immediately. Without that last clause a
shop sitting untouched until morning reads as a broken app.

Set `FAST_DISPATCH=on` in Admin -> Keys to restore 24/7 cold dispatch.

## Still blocked on owner input (not skipped - waiting)

These are carried forward unchanged. None is code-blocked; each needs a
decision or a credential only the owner has.

- **F2 agency scanner** - see the note below; my recommendation is not to build
  it as specified.
- **Part 12 W7** - awaiting a decision on scope.
- **WhatsApp avatar extraction hardening + Places fallback** (task #230) - this
  is a STALE DUPLICATE of #237, already shipped in `b808059`. Closing it.
- **Purge the stale translation rows** after each deploy that changes user
  copy: `delete from app_config where key like 'I18N_%';` - they are regenerated
  on demand, and stale rows serve the old wording to non-English users. This
  cycle changed the rental-window panel, the mass-bargain sheet, the clamp
  notice and the queued-reason explanations, so it is worth re-running once the
  next deploy is live.

## Verifying the mobile rules

The repo rule is "mobile first, 320-430px, no horizontal overflow". That rule
was carried by review and by unit tests, and unit tests cannot see layout -
jsdom has no layout engine, which is how a clipped chevron shipped past a fully
green suite. `npm run check:mobile` renders the real production build in real
Chromium at 320 / 375 / 430px, in English and in a longer-labelled locale, and
asserts the funnel does not overflow and the status expander is reachable and
toggles.

It is deliberately NOT part of `npm test`: it needs a browser and a booted
server, and a unit suite that can fail on a missing browser download is a unit
suite people stop trusting. Run it before shipping anything that touches the
funnel's layout:

```
npm run build && npm run check:mobile
```

What it does not cover is stated in the script's own header - the transcript
follow-scroll needs a live message stream and keeps unit coverage only.

## Live verification after a deploy (owner, ~10 minutes)

Automated gates prove the code does what the tests say. These prove the LIVE
system does what this document says. Run them against production after a
deploy; each one names the surface that answers it.

1. **Providers** - Admin → Keys → *Test AI providers*. Every configured
   provider answers or names a real reason. A timeout now reads as
   `<provider> timed out after Nms`, never a bare platform abort.
2. **Language** - switch to Hebrew (globe), then open the FAQ and the pricing
   card. The FAQ translates (it rides its own `I18N_SHARED_<lang>` row) and the
   plan chrome translates. The marketing prose on `/welcome` and `/guides`
   stays English **by decision** - see the note below.
3. **A five-photo burst** - from a test shop, send 5 price-board photos at
   once. Expect ONE agent turn that references more than one board, not five
   turns. Ops → the thread shows a single reading; the coalesced frames leave
   `image-coalesced` traces rather than vanishing.
4. **Accented voice note, with a caption** - both halves must reach the turn
   (the caption used to silently discard the transcript).
5. **A short video** - expect either a real reading or the honest "I could not
   watch the video - could you send a photo of the price list?" Never silence.
6. **Reply speed** - Admin → Ops → 🚦 Launch readiness. `reply p50/p95` are the
   OBSERVED inbound→wire numbers. Compare against the WA doctor's
   `turn-latency`: a large gap is queue time, not compose time.
7. **Blue ticks** - the test shop should see its message marked read a few
   seconds before the agent's reply arrives. `wa-read-failed` events mean the
   receipt call is failing (check the Evolution build).
8. **Cluster risk** - the same launch card turns red when >=5 unproxied numbers
   share one Evolution host. **At a 25-tester beta on ONE host it will be
   permanently red, and that is correct rather than noise**: 25 personal numbers
   egressing from a single datacenter IP is precisely the shape WhatsApp's
   cluster heuristic targets. This section previously said "at the beta's size
   it should be silent", which was written when the beta was smaller and is now
   simply false. A tile that is always red trains the owner to ignore it, so
   treat it as a standing owner ACTION - set `EVOLUTION_PROXY_TEMPLATE`, or add
   a second Evolution host and let the numbers spread - not as a status to
   watch. What it now DOES see, and did not before: a number whose exit is
   configured but never confirmed (`proxy_verified_at` unset) counts as exposed,
   so pasting a proxy template no longer silences the banner for a fleet whose
   exits have not actually carried traffic. What the alarm still cannot see:
   it reads `wa_sessions.host_url`
   only, and that table has no phone column, so it counts how many numbers share
   a host and never which COUNTRIES they are from. The dial prefix lives on a
   different path entirely (`linkedNumberFor` -> `app_users.phone`, and the
   `host-geo-mismatch` event written at placement), and the two halves of the
   geo-cluster signal never meet.
9. **Retention + the RPC lockdown** - run `supabase/retention.sql` once, then
   confirm `select public.prune_old_rows(90);` returns a JSON summary and that
   `api_usage_daily` has rows. The same file revokes that function from
   `anon`/`authenticated` (PostgreSQL grants EXECUTE to PUBLIC by default, and
   Supabase publishes it over the Data API, so without the revoke the
   browser-side anon key could call it with `retain_days: 0`). It raises an
   exception instead of finishing quietly if the revoke did not take, and
   **Admin -> Keys -> Connection tests -> "Check anon RPC lockdown"** asks the
   live database whether the anon key is still able to call it. That probe is
   the only honest answer - the SQL sitting in the repo proves nothing about
   what your project actually has.
10. **Rate limiting identifies the caller from the RIGHT end of
    `X-Forwarded-For`.** Google's front end appends the address it saw rather
    than replacing the header, so hop 0 is attacker-written and the last hop is
    not. If a load balancer or CDN is ever placed in front of Cloud Run, set
    `TRUSTED_PROXY_HOPS` to the number of addresses it appends after the
    client's; until then it is 0. Fails closed: an unresolvable caller shares a
    single bucket with every other unresolvable caller.

## Deliberate scope notes (so they are not re-litigated as bugs)

### Storage objects and retention (audit F168)

The audit copies of inbound media live in the `wa-media` Supabase Storage
bucket (`src/lib/media/audit.ts`), not in a table. The erasure registry
declares the bucket (`USER_OBJECT_STORES` in `src/lib/privacy/user-tables.ts`)
and the erase walker deletes a person's objects by `wa_message_id` BEFORE it
deletes the `whatsapp_messages` rows that are the only index to them,
reporting the outcome under `purged["storage:wa-media"]`; the DSAR export
lists them by name. What SQL cannot do is age them out: `prune_old_rows` runs
inside Postgres and cannot reach Storage, so objects whose index rows were
pruned by the 90-day window stay in the bucket until the owner sweeps them.
Owner action: periodically delete objects older than the retention window
from the bucket (Supabase dashboard -> Storage -> wa-media, sort by created),
or add a Storage lifecycle rule if the plan offers one. The bucket must also
be PRIVATE - the media proxy (`/api/wa/media`) gates every read per
traveller, and a public bucket would bypass it.

- **The public marketing surface stays English.** `/welcome`, `/pricing` and
  the 20-guide corpus are server components, statically prerendered, and are
  the SEO/AdSense surface. Their CLIENT parts (trust panel, footer, plan cards)
  DO translate, so a Hebrew visitor sees a localized frame around English
  prose. Translating the guide corpus is ~1,500-2,500 strings *per language* -
  a real cost decision for the owner, not a default. The mechanism is ready if
  the owner wants it: a client island calling `tShared`, plus widening the
  translate route's shared allowlist to the copy module.
- **Outbound media is 100% text** - see `ANTI-BAN.md`; an accepted residual
  uniformity signal, not an oversight.
- **The workers VM is still unprovisioned** and nothing depends on it; it is a
  throughput upgrade, not a correctness one.

### Revocation latency across warm instances (W8 #27)

Every privilege decision is re-derived per request - the session cookie carries
only an email - but the DATA those decisions read is cached per instance, and
Cloud Run serves a revocation from ONE container out of N. Only that container
drops its copy. So "applies instantly" was true of the derivation and not of the
propagation.

Two windows existed. One is closed; one is accepted, and this is the honest
statement of it.

**Closed - the admin list (`ADMIN_EMAILS_EXTRA`).** It was read through the 30s
whole-vault cache, so a demoted admin kept full Key-Vault access on every warm
instance for up to half a minute. `adminEmails()` now reads it through
`getConfigFresh` - a single-row read on a 3-second TTL, the same mechanism
`KILL_SWITCH` uses and for the same reason - and fails CLOSED: an unreadable
vault yields owner + env admins only. Worst case is now ~3s, and it is 3s of a
list we could read rather than 30s of one we did not re-ask for.

Paired with this: only the OWNER can promote or demote (`/api/admin/users`).
Peer admins previously could, and a promotion is durable (it is a vault row), so
one compromised admin session could mint itself permanence and remove everyone
able to revoke it. That is the reason the propagation window mattered at all.

**Accepted - the user record (10s, `src/lib/access.ts`).** `status: "blocked"`,
the `test` tester flag and `plan` ride a 10-second per-instance cache. A blocked
account can therefore keep a session alive for up to ~10 seconds on a warm
instance, and a revoked tester keeps free Ultra for the same window.

Accepted deliberately, on these grounds:

- 10s is not 30s, and the blast radius is a normal user's own session - not
  administrative access to everyone else's data.
- Every WRITE path already uses `getUser(email, { fresh: true })`, so nothing
  makes a durable decision on a stale record; only the read-side session
  derivation can lag.
- Making it fresh would add a single-row Supabase read to EVERY authenticated
  request on the app's hottest path (the activity and replies polls run every
  6-8 seconds per open tab). That is a real, permanent cost to close a 10-second
  window on a non-privilege field.

If it ever needs closing, the mechanism is the same one used above: give
`getUser` a `getConfigFresh`-style short-TTL single-row read for the three
security-relevant columns only, not for the whole record.

## What is already right (do not re-solve)

- Atomic queue claims (`sbDeleteReturning`) - genuinely exactly-once.
- `wa_processed` PK-claim dedupe on inbound - burst-safe.
- Per-user scoping is consistent (`user_email`, `sender_key`,
  `raw->>'sender'`, `threadKey = email:digits`); the cross-user reads that do
  exist (global message-uniqueness check) are deliberate and content-only.
- Cost guards: global kill switch, per-user daily limits, LLM per-event
  budget with an 8s deadline reserve, request caching on paid lookups.
- Graceful degradation everywhere: no key → mock, no Supabase → in-memory,
  webhook never 500s.

## Owner actions outstanding (owner report 6, as of 2026-08-21)

One list, checked off as you go - everything below is a thing only you can do:

1. **Rotate the Evolution API key** (J1, security). The old
   `AUTHENTICATION_API_KEY` literal was committed to render.yaml and is
   burned. render.yaml now says `sync: false`, so the dashboard owns it:
   set a fresh random key on wd-evolution in the Render dashboard
   (Environment -> AUTHENTICATION_API_KEY), then paste the same value in
   the app under Admin -> Keys so the app's Evolution calls keep
   authenticating. Until rotated, anyone reading the repo history can
   control the WhatsApp fleet.
2. **Run `supabase/perf-indexes.sql` once** (L1) in the Supabase SQL
   editor - additive expression indexes for the hot poll/thread reads.
   Safe to re-run.
3. **Re-run `supabase/retention.sql` once** (L6) - the englishGloss
   keep-forever exemption is gone, so pruning finally works in localized
   markets. (Replaces the stored function; same file, run again.)
4. **Manual-Sync the Render blueprint** so the `wd-evo-prune` cron takes
   effect (owner report 8 wave E). It is no longer commented out or optional:
   it runs DAILY at 04:00 with 7-day retention, because Baileys persists every
   message row forever into a 256 MB database - roughly 9-15 MB/day at 50
   users, i.e. full in 17-28 days - and a full Postgres is not a slow queue, it
   is failing Prisma writes, which is the documented Evolution crash that drops
   every linked socket at once. The old monthly/30-day block would have fired
   for the first time after the disk was already full. The script is
   IF-EXISTS guarded throughout, so a renamed table is a logged no-op.
5. **wd-evolution sizing** (J2, unchanged decision): standard plan
   (~$25/mo) or cap occupancy at ~25-30 numbers per host.
6. **Disable AdSense Auto ads** (G3, unchanged): manual slots stay; Auto
   ads inject runtime styles on html/body that can re-break fixed chrome.
7. **Golden cases re-blessing** (K): thread-level meaning now comes from
   the model's durable comprehension, not FIRM_RX-style regexes. DB golden
   cases that asserted firm/deposit verdicts from raw text may drift -
   review them in Admin -> Ops after the K wave settles and re-bless.
