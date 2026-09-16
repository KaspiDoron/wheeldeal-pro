# 200 users - the findings

Date: 2026-09-16. Eight Opus review agents, one axis each, read-only, each
told to grep `docs/AUDIT-2026-09.md` Appendix R2 first so nothing already
reported is repeated (F-numbers cite it where an item is there). Every claim
carries file:line. Severities are AT 200 CONCURRENT USERS, which is why several
audit P2s appear here as P0/P1.

The short version is `docs/200-USERS-PLAN.md`. This file is the evidence the
execution session works from, verbatim from the agents, lightly formatted. One
finding (Evolution 2/3, host affinity) was verified by hand and fixed the same
day; the rest are unverified agent claims until the execution session confirms
each against the code before changing it - the repo's own rule.

Line numbers are as of master `bfcbfd2` (2026-09-16).

---

## 1. Supabase

Poll cadences (`src/lib/client/public-config.ts:49`): pulse 2.5s, activity
20s, replies 30s, peek 30s, deals 60s. SCALE_MODE relaxes to 5s/30s/45s.

1. **P0 - heavy polls re-fetch the entire hunt window every tick, not a
   delta.** `src/app/page.tsx:1154` sends `since=searchEpoch` (hunt start, 3h
   TTL) so `/api/activity` re-reads the whole session every 20s. Worst row:
   `src/app/api/activity/route.ts:241`, 40 `agent_traces` rows carrying
   `reasoning` (2000 chars) + `output` (1000 chars) = ~120 KB per poll.
   `/api/replies` (`route.ts:226`) pulls `negotiation_threads.fields` jsonb
   x40; peek (`src/app/api/thread/route.ts:354,368`) two 300-row reads.
   ~296 KB/activity poll, ~139 KB/replies, ~146 KB/peek = **~1.4 MB/min per
   active user**. 200 users = 16.8 GB/hour = the 5 GB free month in ~18 min.
   200 idle-but-open tabs burn it in ~8 hours. CODE (delta cursor, drop
   reasoning/output from the feed select) then OPS (Pro). Not in the audit.
2. **P0 - 500 MB free disk fills in ~2.4 days and the prune cannot help before
   day 90.** ~1.1 MB/user/day incl. indexes (`agent_traces` 5 KB/row at
   `src/lib/orchestrator.ts:322-326`, `whatsapp_messages.raw` at
   `src/lib/wa/ingest.ts:943`, `searches.snapshot` ~18 KB at
   `src/app/api/vendors/route.ts:173,210`). 200 x 30 days = 6.3 GB.
   `supabase/retention.sql:55-57` shortest window is 90 days
   (`RETENTION_RETAIN_DAYS`, `src/lib/retention.ts:36`). OPS (Pro, 8 GB) +
   CODE (~14-day window for traces/events).
3. **P0 - the retention prune can never complete once tables are big, and
   never records that it failed.** `prune_old_rows` is one plpgsql transaction
   of ~25 unbatched DELETEs (`supabase/retention.sql:66-262`) via `sbRpc`
   (`src/lib/retention.ts:83`) on the shared 8s abort
   (`src/lib/runtime-config.ts:261`). Most deletes have no usable index
   (`agent_events`/`api_usage` kind-leading only, `supabase/schema.sql:516,349`;
   `product_events`/`offers`/`vendor_replies`/`negotiation_threads`
   user_email-leading; `searches` none; `wa_processed`/`wa_inbound_seen` PK
   only). Heartbeat written at the END, so a timeout leaves no `retention-ran`
   row and the hourly ping (`src/app/api/wa/ping/route.ts:195`) re-attempts a
   multi-million-row transaction forever with the tile red. CODE (batch with
   LIMIT, commit per table, heartbeat first) + OPS (created_at indexes).
   Related F026.
4. **P0 - F001 becomes fatal: the recovery sweep seq-scans `whatsapp_messages`
   20-30x/second.** `src/lib/wa-sync.ts:211` filters `wa_message_id=in.(...)`;
   no index on `wa_message_id` (`whatsapp_messages_dedupe_uidx` at
   `supabase/schema.sql:1371` is on `dedupe_key`). Sweep runs from
   `/api/replies` on every poll, per-instance 12s throttle (`wa-sync.ts:22`),
   5 chats per pass. 200 boards = ~33 full scans/s. OPS (one index). **F001.**
5. **P1 - `/api/pulse` alone is ~320 PostgREST req/s; pool exhaustion fails
   silently.** `src/app/api/pulse/route.ts:48-76` 4 reads/call at 80 req/s.
   With activity (~16), replies (5), peek (2-3): ~530 req/s before any WhatsApp
   traffic, against a 10-connection pool (SCALING.md:264-270) - and `sbSelect`
   maps non-2xx to `[]` (`src/lib/runtime-config.ts:355`), so the first
   symptom is a blank but confident board. OPS (Pro + compute) + CODE (raise
   `pulseMs` or one RPC for the four `limit=1` reads).
6. **P1 - mass outreach makes ~600 sequential PostgREST round trips in one
   request.** `src/app/api/outreach/mass/route.ts:477` loops vendors
   sequentially, ~15 awaited calls each (`clearCancellation`,
   `resolveTransport`, `advanceThreadStage` 2-4, `introHoldIso`,
   `outboxToKeyPatch`, `sbInsert`, `guardOutbound`, `claimForSend`) x 40 shops.
   CODE (batch inserts, bounded parallelism).
7. **P1 - F003 critical: `searches` has no secondary index and is read on
   every reply turn.** `src/lib/search-session.ts:37` (`user_email=eq &
   order=created_at.desc & limit=1`) vs `supabase/schema.sql:164-181` PK only;
   called from `graph/engine.ts:1803,1817`, `bargain-draft`,
   `/api/deals/route.ts:327`. Rows carry ~18 KB `snapshot`, kept 360 days.
   OPS (index `(user_email, created_at desc)`), CODE (trim snapshot). **F003.**
8. **P1 - F005 critical: `ai_usage` is never pruned, and the admin read is
   `limit=100000`.** `supabase/retention.sql` prunes `api_usage` (line 74),
   never `ai_usage` (one row per provider call, `src/lib/ai.ts:512`); only a
   partial index (`schema.sql:1691`). `src/lib/ai.ts:370` reads a month with
   `limit=100000`. CODE (prune + roll up) + OPS (created_at index). **F005.**
9. **P2 - `select=*` on `app_users` on the session path and on
   `negotiation_threads` on the turn path.** `src/lib/access.ts:321` (27
   columns per `getSession`, 10s per-instance cache at `access.ts:77`);
   `src/lib/graph/state.ts:47,363,484`. CODE (column lists).
10. **P2 - the egress meter under-reports and SCALING.md never models the free
    tier.** `noteEgress` wired into `sbSelect`/`sbSelectStrict`
    (`runtime-config.ts:353,451`) but not `sbCount`/`sbCountDark`
    (`:375,525`) nor the vault read (`:1027`). SCALING.md:292-296 sizes egress
    against Pro's 250 GB only. CODE + doc. **F252, F088.**

Doc drift: CLAUDE.md says the prune runs hourly; `RETENTION_MIN_GAP_MS = 20h`
(`src/lib/retention.ts:31`) means at most once per 20 hours.

**Verdict:** no - 200 users cannot run on the free tier and it is not close.
Egress binds first (~18 min), disk second (~2.4 days), the pool third (~530
req/s vs 10 connections, failing as a blank board). Findings 1, 3, 4 and 6
must land regardless of the tier bought.

---

## 2. Client polling load

| Client site | Endpoint | Interval | SCALE_MODE | Hidden tab | Backoff | req/s @200 quiet | @200 active |
|---|---|---|---|---|---|---|---|
| `src/lib/client/pulse-store.ts:124` | `/api/pulse` | 2,500 ms | 5,000 | pauses | none | 80 | 80 |
| `src/app/page.tsx:1813` | `/api/activity` | 20,000 | 30,000 | pauses | none | 10 | ~80 (F-A) |
| `src/app/page.tsx:2205` | `/api/replies` | 30,000 | 45,000 | pauses | none | 6.7 | ~40 |
| `src/lib/client/thread-peek-store.ts:102` | `/api/thread?vendorIds=` | 30,000 | ignored | pauses | none | 6.7 | 6.7 |
| `src/components/ThreadDashboard.tsx:158`, `TranscriptSheet.tsx:96` | `/api/thread?full=1` | 5,000 hard-coded | ignored | pauses | none | 6 | 6 |
| `src/app/page.tsx:1844` | `/api/vendors/tags` | 120,000 | 300,000 | no check | none | 1.7 | 1.7 |
| `src/app/page.tsx:963`, `WaConnect.tsx:124` | `/api/wa/status` | mount + every focus | | | 3 attempts | burst | burst |
| | | | | | **total** | **~111** | **~214** |

Backend cost: `/api/pulse` 4 reads + ~0.8 getSession; `/api/activity` ~22
reads (+3 when drain-owning; its own header claims fourteen); `/api/replies`
~16 reads + 5-10 Evolution calls; peek ~3.5; full ~6. **~775 reads/s quiet,
~2,850 reads/s active; 33-200 Evolution calls/s.**

- **F-A P0 CODE `src/app/page.tsx:1768,1815,2215`** - `subscribePulse` bumps
  `syncNonce`, which is in the dependency array of BOTH heavy poll effects, and
  each effect calls `tick()` on re-creation; during a live hunt something moves
  on nearly every 2.5s pulse, so the 20s/30s intervals never fire.
  `/api/activity` runs at pulse cadence: 80 req/s x 22 reads. Not in the audit.
- **F-B P0 CODE/OPS `SCALING.md:265`, `src/lib/runtime-config.ts:261`** -
  every read shares PostgREST's default 10-connection pool and `sbSelect`
  maps the 8s abort to `[]`. Not in the audit.
- **F-C P0 CODE `src/app/page.tsx:1739-1743`, `pulse-store.ts:156-166`** -
  three degraded pulses TIGHTEN activity to 6s and replies to 8s, and
  `sbSelectDark` returns null on exactly the timeout a saturated PostgREST
  produces: all 200 tabs triple their heavy-poll rate at the store that just
  failed. Not in the audit.
- **F-D P1 CODE `src/lib/wa-sync.ts:22,24,80,358` from `replies/route.ts:56`**
  - the missed-reply sweep fires on every replies poll (12s per-instance
  throttle < 30s interval), up to 5 `/chat/findMessages` each. **F256** at 200
  is the second binding limit.
- **F-E P1 CODE `src/lib/wa-sync.ts:358` vs `src/lib/wa/inbound-gate.ts:16`**
  - the sweep calls `processVendorReply` (72s wall) and `fetchMediaBase64`
  directly; `withInboundSlot` is wired only at the webhook door
  (`ingest.ts:1583`). Up to 32 ungated LLM turns per 1 GiB instance.
- **F-F P1 CODE (or OPS `--session-affinity`) `src/lib/wa/drain-owner.ts:18,29-45`**
  - `claimDrainSlot` is a per-instance Map; ~60 drains/s fleet-wide instead of
  10. The atomic claims hold (`outbox-lifecycle.ts:132-143`,
  `graph/engine.ts:2605-2613`, pacing keyed by `sender_key`), so no double
  send - request-slot time and wasted selects.
- **F-G P1 CODE `src/app/api/thread/route.ts:89-91,115-117`** - `full=1`
  selects whole `raw` jsonb for 120 rows every 5s, ignoring SCALE_MODE; ~4.8
  MB/min per open transcript, ~20 GB/hour fleet.
- **F-H P1 CODE `src/middleware.ts:57`** - no rate limit on any polled
  endpoint (matcher is `/`, `/admin`, `/profile`, `/deals`).
- **F-I P2 CODE** - SCALE_MODE reaches only 4 of 6 loops (peek and transcript
  hard-coded); the lever cuts 111 -> 64 req/s, not 3x.
- **F-J P2 CODE `src/app/page.tsx:1826-1848`** - tags poll ignores tab
  visibility, no in-flight guard.

Cloud Run: quiet L~64 = 2-3 instances; active L~250 = 8; `--max-instances 20`
binds only when `/api/replies` blocks 8-14s on the sweep. No pagination; caps
are fixed but large (~1,270 rows per activity request for a 40-shop user).

**Verdict:** no - the binding limit is PostgREST's 10-connection pool, then
the single Evolution host's `findMessages` load, then egress. F-A, F-C, F-D,
F-G alone cut steady-state reads ~4x before any spend.

---

## 3. Process-local state across instances

**SAFE-BY-DB (every anti-ban constant):** 8s per-recipient floor
(`src/lib/wa/pacing.ts:419-469`), per-sender gap (`:480-573`), reply fleet
gap (`:582-626`), message idempotency (`:366-386`), intro/reply caps
(`src/lib/evolution.ts:217-238`), intro budget (`wa-guard.ts:1476` advisory
over a DB ledger), outbox and chain claims (`wa-guard.ts:3810`, `tick:63`,
`ping:60`), rfq-dedup (`wa-guard.ts:2544,2568`).

| # | Sev | file:line | Defect | Class | Fix |
|---|---|---|---|---|---|
| 1 | P1 | `src/lib/ai-rpm.ts:101,104` (fallback at `ai.ts:1216,1256`) | RPM/RPD buckets are module Maps without Redis; gemini's 250 RPD becomes 5,000 fleet-wide, spent discovering 429s | REDIS-REQUIRED | OPS (F213, F247) |
| 2 | P1 | `src/lib/evolution.ts:1099,1288,1321` | `bumpHostCount` is per-instance; a link burst places 20-40 numbers past the host cap inside one 10s cache window - the OOM/reconnect storm the file itself names | MEMORY-ONLY | CODE |
| 3 | P1 | `src/lib/graph/uniqueness.ts:253-282` | Cross-fleet copy uniqueness is a no-op without Redis, and the DB layer scores 0 by F113 | REDIS-REQUIRED | OPS |
| 4 | P1 | `src/lib/wa-guard.ts:2093-2130` | Stop-loss streak is per-process; 3 hard failures in 180s must land on ONE instance, so the fast breaker never trips at N instances | MEMORY-ONLY | CODE |
| 5 | P1 | `src/lib/usage.ts:284-309`, `ai-budget.ts:75` | `reserveDailyUnit` is a no-op without Redis; `LIMIT_AI_PER_DAY` exceeded by the concurrency factor | REDIS-REQUIRED | OPS |
| 6 | P1 | `src/lib/rate-limit.ts:31-33,222-238` | IP-keyed windows fall back to per-instance: every sessionless limit x20 | REDIS-REQUIRED | OPS (F188, F189, F206) |
| 7 | P1 | `src/lib/cooldown.ts:96-128` | Failed-auth counter per-instance; 6 x 20 = 120 guesses per 15 min before a durable lock | MEMORY-ONLY | CODE (M41) |
| 8 | P2 | `src/lib/memory.ts:142-168` | `recordOutcome` read-modify-writes absolute `uses`/`wins`; instances clobber each other | MEMORY-ONLY | CODE |
| 9 | P2 | `src/lib/wa-guard.ts:229-231` | Policy cache per-instance 60s; an owner's incident dial reaches other instances after up to ~90s | MEMORY-ONLY | CODE |
| 10 | P2 | `src/lib/wa-guard.ts:669-710` | Shop STOP: instance-local half + durable upsert; if the upsert fails, one instance refuses and 19 keep messaging | MEMORY-ONLY on failure | CODE |
| 11 | P2 | `src/lib/runtime-config.ts:302-333` | Egress meter buffers up to 16 MB / 15 min in-process; scale-down discards it | MEMORY-ONLY | CODE |
| 12 | P2 | `pacing.ts:23,658`, `ai.ts:452`, `wa-guard.ts:820`, `hold-events.ts:27`, `ai-budget.ts:172` | Six per-instance telemetry throttles x20 (e.g. `ai-chain-exhausted` 28,800 rows/day) | MEMORY-ONLY | CODE (F256 class) |

Also: `src/lib/memory.ts:173` `recordRun` has zero callers, so
`analytics().totalRuns` etc. render a permanent confident zero (P2, new).

Drain armer (`src/lib/wa/drain-armer.ts:30,63`): the only cross-request timer;
honest contract, HTTP self-kick only, lost on a killed instance; Cloud Scheduler
(`deploy-gcp.yml:588,597`) is the durable backstop. Lost arm = latency, not
work. `--no-cpu-throttling` is not set (`:452-464`).

`REDIS_URL` is wired and optional (`deploy-gcp.yml:343,411`;
`src/lib/deploy-env.test.ts` guards the pair). Commands at 200 users: ~4 per
model call x 18k-60k calls/day, ~40k/day copy signatures, ~30k/day hot state
= **~150k-340k/day = 4.5-10M/month**. Upstash free (500k/month) lasts 1.5-3
days. The fleet compose Redis (`deploy/fleet/docker-compose.yml:66-78`) is
expose-only, no password/TLS/persistence, `allkeys-lru` sharing 192 MB with
Evolution's cache - evicting a cap counter resets a safety cap to zero.

**Verdict:** `REDIS_URL` is mandatory at 200 users. Cheapest safe: Upstash
pay-as-you-go ~$10-20/mo (TLS, no VPC connector; Memorystore ~$45 + $8).

---

## 4. Inbound webhook path

Shape: `route.ts` authenticates (pure crypto) then `processEvolutionWebhook`
runs everything synchronously INCLUDING the LLM turn (`src/lib/wa/ingest.ts:1589`).
`maxDuration = 60` (`route.ts:64`) is inert on standalone (A13/F219); the real
ceiling is `--timeout 90` (`deploy-gcp.yml:464`).

1. **P0 - `--concurrency 32` and the gate's `MAX_INFLIGHT = 4` disagree, and
   the autoscaler obeys the 32.** `deploy-gcp.yml:459-464` vs
   `src/lib/wa/inbound-gate.ts:16`. Cloud Run packs 32 in-flight LLM turns on
   one 1 vCPU / 1 GiB instance before scaling; `acquire()`
   (`inbound-gate.ts:110-127`) resolves false after `MAX_WAIT_MS` and the turn
   proceeds UNGATED. `inboundInflight()` reports 4 to the KPI card
   (`launch-kpis/route.ts:26`). OPS (`--concurrency` ~6-8). Not in the audit.
2. **P0 - the media stage holds unbounded bytes upstream of the gate.**
   `ingest.ts:1330-1363` runs `assembleImageBurst` -> `budgetFrames` before the
   gate at `:1583`; `fetchMediaBase64` (`src/lib/evolution.ts:2642-2662`) has
   no byte ceiling; `image-burst.ts:40` holds up to 16 frames;
   `ingest.ts:1359` fires `storeMediaAudit` unawaited per frame. The 4 MB/18 MB
   caps (`media/frame-budget.ts:17-19`) run AFTER all 16 are resident. One
   16-frame burst at 16 MB each is ~340 MB base64 + ~250 MB Buffers on a 1 GiB
   box; four together OOM it with no 503. CODE. **F203, F204, F205** (P2).
3. **P0 - redelivery cannot rescue a killed turn.** `ingest.ts:931` takes the
   `wa_inbound_seen` claim before the media stage and the turn; released only
   if the `whatsapp_messages` insert fails (`:1045-1056`). A 90s kill mid-turn
   leaves the claim, so Evolution's redelivery hits `claimInboundStore` ->
   `continue` (`:936`). Recovery falls to the `wa_processed` dead-turn retake
   (10-min lease, `inbound-claim.ts:205`) via the sweep (finding 8). CODE. Not
   in the audit.
4. **P1 - the post-loop tail runs outside `REQUEST_WALL_MS`.** `ingest.ts:196`
   sets 85s; the tail at `:1665-1786` is unbudgeted: pushes 8s + read receipts
   9s + drains 3s+3s + kicks 1.2s = ~24s. 85 + 24 = 109s vs 90. CODE. (F062
   fixed the upstream half.)
5. **P1 - the reply-tick kick is ordered behind 17s of best-effort work.**
   `ingest.ts:1665-1684` awaits pushes then receipts; kicks at `:1767-1778`.
   A killed tail leaves the parked reply for the next cron minute. CODE.
6. **P1 - the turn-entry floor is 3.6x smaller than the turn wall it admits.**
   `ingest.ts:211` `TURN_ENTRY_FLOOR_MS = 20_000` vs `agent-loop.ts:450`
   `TURN_WALL_MS = 72_000`. CODE.
7. **P1 - Evolution's webhook timeout and retry policy are not configured.**
   `render.yaml:162-260`, `deploy/fleet/docker-compose.yml:96-140` set no
   `WEBHOOK_REQUEST_TIMEOUT_MS` / `WEBHOOK_RETRY_*` on `evolution-api:v2.3.7`;
   registration (`evolution.ts:850-854, 2251-2254`) sends only
   `{enabled,url,byEvents,events}`. A Supabase brownout makes
   `resolveInstanceEmail` (`evolution.ts:1550`) return retryable for every
   event (`ingest.ts:602-609`) - the whole fleet 503s at once into an
   unconfigured retry policy. OPS (pin envs; SCALING.md:492-497 recommends
   the RabbitMQ/SQS emitter). Not in the audit.
8. **P1 - the backstop's coverage cycle is hours.** `src/lib/wa/sweep.ts:28`
   caps at 10 senders/min; `wa-sync.ts:24` `MAX_THREADS = 5`; `:27`
   `RUN_BUDGET_MS = 8_000` vs 12s aborts -> full per-user coverage ~100 min
   nominal, several hours real. CODE. (F234, F235, M9 adjacent.)
9. **P2 - no rate limit or reserved capacity on the webhook; it shares 32
   slots with the poll storm.** `replies/route.ts:92` already notes ~40 slots
   held at 50 users. OPS/CODE.
10. **P2 - token gate is zero-DB and correct** (`evolution.ts:603-609`,
    `webhook-token.ts:41-52`, `timingSafeEqual`); a mismatch is pull-only
    (`webhook-trace.ts:17,37-48`, 1/5min/process). A missing `SESSION_SECRET`
    makes the whole fleet's inbound dark behind a breadcrumb. OWNER/OPS
    (F181, F175/F182).

Q4: **F019 fixed and verified** (`retention.sql:184-188`, `schema.sql:647,668`
PK covers the lookups). Residual: `inbound-claim.ts:138-144` permanent legacy
spelling read per message (P2).

**Verdict:** no. Binding limit is per-instance concurrency: 32 LLM turns and
their media buffers on one 1 GiB box before instance 2 is used; the gate can
add 12s of latency, never refuse. Failure is silent: a 90s kill or OOM returns
no 503, the claim tombstones the message, and recovery is hours.

---

## 5. AI providers

Ladder (`src/lib/ai.ts:137-315`, budgets `src/lib/ai-rpm.ts:45-99`; real order
is `allProviders()`, not `PROVIDER_NAMES`): groq 30 RPM/7000 RPD; together
60/1500 (one-time credit); openrouter 20/200 (comment says ~50/day); mistral
60/2000 (monthly tokens); huggingface 15/500 (monthly); gemini 15/250;
sambanova 10/300 (429 on both pools 2026-08-31); deepseek 60/none (PAID);
cerebras 30/none (free tier RETIRED 07/2026, 402); anthropic/openai/kimi
300/200/100, no RPD (PAID). Free totals: 240 RPM, 11,750 RPD; ~7,400
sustainable after deducting dead/non-daily rungs, ~95% groq.

1. **P0 - the free ladder is ~5x short at 200 users.** 7-9 passes per
   shop-reply turn, 280-450 per hunt (`usage.ts:129-137`); 200 hunts =
   60,000 passes/day vs 11,750. Funds ~39 users/day. OWNER.
2. **P0 - a pasted paid key has NO daily spend cap, and the exhausted free
   ladder aims the whole fleet at it.** No `DEFAULT_RPD` for
   anthropic/openai/kimi/deepseek (`ai-rpm.ts:90-99`); `tryConsumeDay` returns
   true for absent capacity (`:128`). `pickRoute` hoists the paid trio to rung 1
   for high-stakes (`spte/pass.ts:37-49`, `ai.ts:1160-1162`); comprehension
   passes `tier:"premium"` to three classifiers (`comprehension.ts:287,304-312`);
   and the last rung is never skipped (`ai.ts:1269,1277`). ~3,200 paid
   calls/hour at full load = ~$50-65/hour on Sonnet pricing. CODE. Not in the
   audit.
3. **P1 - without `REDIS_URL` both windows overshoot up to 20x.**
   `ai.ts:1201-1217, 1239-1257` fall to per-process Maps. Service degradation,
   not number safety: an empty bucket reorders, never refuses (`ai-rpm.ts:13-16`).
   OPS. (F213.)
4. **P1 - the never-skipped last rung is a rung the code knows is dead.**
   `ai.ts:1269,1277` exempt the last index; on free keys it is cerebras
   (`ai.ts:266-271`, documented 402). Every turn past exhaustion pays a
   guaranteed 402. CODE.
5. **P1 - exhaustion sends a deterministic English template.**
   `spte/pass.ts:1155-1166` breaks on `!raw`; `:1203` returns `fallbackArtifact`
   `reason:"quota-overflow"`. `engine-route.ts:87` fails over only on throw.
   Honest event exists (`ai-chain-exhausted`, `ai.ts:453-474`). CODE optional
   (hold + re-tick). (F075; F111 fixed.)
6. **P1 - a voice note can pin a slot past 90s.** `transcribeAudio` takes no
   deadline (`graph/transcribe.ts:103-108`); caller passes `mediaDeadlineAt`
   only to `fetchMediaWithRetry` (`ingest.ts:1452,1478`). 20+1.5+20s Whisper
   then `chatVision` with no `budgetMs` -> 45s (`ai.ts:1411,1954`) = 86.5s
   before the gate and a fresh 72s turn wall. CODE.
7. **P1 - telemetry writes are awaited inside the reply budget.** `ai.ts:1292`
   awaits `recordUsage` on every rung failure, `:1285` success, `:1000` sibling
   rescue - up to 8-10 `ai_usage` rows per logical call inside SPTE's 9s
   budget (`pass.ts:1152`). CODE. (F005 covers the read side.)
8. **P2 - budget constants contradict the file's own probe notes**
   (openrouter 200 vs "~50/day", sambanova 300 vs saturated, cerebras 30 RPM
   with no RPD against a retired tier). OWNER (re-probe, vault overrides).
9. **P2 - two sources of truth for chain order**; `wave2-providers.test.ts:31`
   pins the wrong one. CODE.
10. **P2 - exhaustion counter per-instance** (`ai.ts:452-457`); OpenRouter
    `/key` and DeepSeek `/user/balance` (`ai.ts:563,583`) have no AbortSignal
    (admin path, M19 class). CODE.

**Verdict:** no on free keys. Cheapest paid steps in order: `REDIS_URL`; a paid
Groq tier + `AI_RPM_GROQ`/`AI_RPD_GROQ` overrides (zero code); set
`AI_RPD_ANTHROPIC`/`_OPENAI`/`_KIMI` BEFORE pasting any paid key.

---

## 6. Auth, sessions, allowlist, limits

1. **P0 - an unreadable vault empties the beta allowlist and force-logs-out all
   200 testers.** `src/lib/allowlist.ts:99-119`: `getConfig("beta_allowlist")`
   returns undefined on a failed/timed-out read, the catch falls to
   `parseEnvList(process.env.BETA_ALLOWLIST)` - delivered nowhere
   (`deploy-gcp.yml:411`, `.env.example`) - so the list collapses to `[owner]`.
   `/api/auth/me/route.ts:15-18` then `clearSessionCookie()`
   (`session.ts:337-341`); login 403s until the vault recovers. The one place
   the "absent != unreadable" discipline (`runtime-config.ts:970-983`) was
   not applied, failing in the locking-out direction. CODE (read via
   `getConfigStrict`, fail OPEN for existing sessions on `unavailable`); OPS
   stopgap: set `BETA_ALLOWLIST`. Not in the audit.
2. **P0 - the "pulse went blind" fallback multiplies load 3-4x at the moment
   the database is failing.** `page.tsx:1735-1744`, `pulse-store.ts:56,160-166`,
   `pulse/route.ts:91-93`. (Same as client F-C.) CODE.
3. **P1 - session verification re-reads `app_users` per request and the 10s
   cache gets worse as Cloud Run scales out.** `session.ts:212,230`,
   `access.ts:290-335` (`select=*`, `CACHE_TTL_MS = 10_000`); no session
   affinity, so ~80 reads/s at 4 instances. `/api/auth/me` pays it twice
   (`route.ts:11,21`). CODE.
4. **P1 - Google sign-in's brute-force lock is keyed on IP alone, durably.**
   `auth/google/route.ts:62-69,77,106`, `cooldown.ts:107-131` (6 / 15 min).
   One hotel Wi-Fi locks Google sign-in for everyone behind it; `SHARED_BUCKET`
   (`rate-limit.ts:43,172,178`) locks the whole fleet. Email path keys
   `${email}|ip:` correctly (`login/route.ts:223`). CODE.
5. **P1 - per-IP caps sized for one person on a shared NAT.**
   `login/route.ts:106` (30/hour/IP), `photo/route.ts:75` (300/hour/IP). CODE
   or OWNER (raise).
6. **P1 - an unreadable user row silently downgrades a paid session to
   `free`.** `session.ts:230,254`, `access.ts:334`; consumed at
   `outreach/mass/route.ts:36,48,203`, `usage.ts:204-243`. CODE.
7. **P1 - `saveBetaAllowlist` revokes de-invited testers in a serial loop; at
   200 it can outlive the request.** `allowlist.ts:217-224`,
   `admin/beta/route.ts:87`; up to 200 sequential PATCHes; a failed
   `setConfig` pins the unsaved list in `s.mem` (`runtime-config.ts:1387`).
   CODE (batch `email=in.(...)`). New today.
8. **P1 - `scryptSync` blocks the 1-vCPU event loop per password check.**
   `access.ts:97-112`, ~41 ms/call; 32 logins on one instance = ~1.3s of
   blocked loop. CODE (async scrypt) / OPS (`--cpu 2`, `--min-instances 3`).
9. **P1 - admin block/unblock over an unreadable row wipes password, phone,
   name, plan, consent.** `access.ts:524-546` (fallback record `:529-536`,
   `mirror` `:538`, base payload `:197-208`). CODE (refuse on unavailable).
10. **P2 - `searches` unindexed, `/api/deals` scans 40 fat rows per poll.**
    `schema.sql:164`, `deals/route.ts:211,328`. OPS. **F003.**

Email: Gmail -> Brevo -> Resend (`email.ts:274-285`); `createTransport` per
send, no pool; 200 signups = 200 TLS+AUTH sessions from one egress IP; Resend
free is 100/day and sandboxed until a domain is verified (`email.ts:88-91`).
OWNER (Brevo or Gmail configured) + CODE (pool).

**Verdict:** nothing algorithmically wrong; three failure-direction choices
(allowlist fails closed, unreadable row reads as free, blind pulse polls
harder) turn any Supabase slowdown into a self-amplifying fleet-wide logout.

---

## 7. Outbox drain throughput

Documented "reply budget of 6" is false: `REPLY_PER_SENDER = 3`
(`wa-guard.ts:3661`) plus `max(8, min(24, dueReplySenders*3))` (`:3678`). The
number that binds and the doc omits: `wa-guard.ts:3637` `.slice(0, 30)` - 72
rows read, 30 considered, ~10-13 reached by the wall clock.

Per send ~3.5-5s median (`checkRateLimit`, `ensureConnected` 6s, presence +
900-1400ms, `poissonPause` mean 1.28s, sendText, 6-9 post-send writes, plus
4-7 round trips per candidate), 13-29s on a slow host, ~42s worst. Per
invocation 10-13 sends. Two single-runner streams (ping `__ping__` 45s bucket,
tick `__chain__` 30s claim) = **22-28 sends/min fleet-wide, independent of
user count**. Anti-ban floors permit 1,000-2,000/min (slots keyed by
`sender_key`, `pacing.ts:495-497, 585-589`). Demand at 200: ~133/min.
**Break-even: 33-42 simultaneously hunting users with apps closed.**

1. **P0 - the 30-row slice is sorted replies-first, so cold intros get zero
   slots at fleet scale.** `wa-guard.ts:3637` + `outbox-policy.ts:46-50,75-84`.
   Once >= 30 reply rows are due, intros are served only by the 6h expiry
   (`outbox-policy.ts:131`) as `wa-send-expired`. CODE.
2. **P0 - one sender can monopolise an invocation's entire slice.** Per-sender
   caps (`:3742-3745`) apply AFTER the slice; one user with 30 due replies
   fills all 30, sends 3, re-parks 27 at 10-16s (`:3771`) and re-monopolises.
   CODE.
3. **P1 - paid plan is an absolute precedence with no aging.**
   `outbox-policy.ts:67-71,75-84`; a free user's reply can be pushed out
   indefinitely and binned at 6h. CODE.
4. **P1 - the send loop is strictly sequential with no per-host isolation or
   breaker.** `wa-guard.ts:3690`; `evolution.ts:1380` 12s abort; one down host
   puts ~4 poison rows in each slice at up to 42s each - the invocation delivers
   zero for the other hosts' users. CODE.
5. **P1 - no metric can see the queue falling behind; the only alarm cannot
   fire.** `ops/vitals.ts:80-93`, `admin/health/route.ts:410-412`,
   `admin/command/route.ts:51,169-181` key on `not_before`, which the drain
   rewrites forward on every re-park (`wa-guard.ts:3766-3776, 3839`). The honest
   stamp `meta.firstDueAt` (`outbox-lifecycle.ts:56-68`) is read only by
   `outboxExpired`. Reads are `limit=500`/`limit=50` unflagged. CODE.
6. **P1 - the backlog self-truncates instead of growing.** Re-parks charge
   against `firstDueAt`; 5x over capacity ages rows past 6h and bins them.
   CODE + OWNER.
7. **P2 - the over-budget re-park has no lease predicate.**
   `wa-guard.ts:3766-3776` bare `sbUpdate` before `claimOutboxRow` (`:3810`)
   rewrites `not_before` + whole `meta` from a stale copy, resetting attempts.
   F021's class on a different write (F021 itself verified fixed,
   `park.ts:122-140`). CODE.
8. **P2 - the drain armer is per-instance on a CPU-throttled runtime.**
   `drain-armer.ts:25,30,56-73`. CODE (durable wakeup row) or OPS
   (`--no-cpu-throttling`).
9. **P2 - overlapping global drains are continuous at 200.** Every webhook
   fires a `hop=0` kick (`ingest.ts:1773-1777`), 50-130/min. **F065, F066.**
10. **P2 - the ping's budget only covers the inbound sweep.**
    `ping/route.ts:15-17` `INVOCATION_BUDGET_MS = 75_000` consulted only at
    `:129`; Cloud Scheduler `--attempt-deadline 60s` (`deploy-gcp.yml:599`)
    marks the job failed every minute; real sweep ~3 senders/min. **F234,
    F236, M9.**

**Verdict:** no. The drain's own selection and wall clock, not the safety
floors, cap it at 22-28 sends/min. It fails invisibly: rows are binned at 6h
while the only alarm measures a field the drain rewrites.

---

## 8. Evolution client and the host fleet

The host layer is not covered by the audit at all (zero hits for `resolveHost`,
`hostHealthy`, `hostUserCounts`, `fetchInstances`, `EVOLUTION_HOSTS`). F044/F045
verified fixed (`evolution.ts:2434-2442`, `:1813-1894`).

1. **P0 - the health probe is an unfiltered `fetchInstances` with no
   single-flight.** `evolution.ts:998` (probe), `:1028` (15s TTL per process),
   `:1284-1287` (fan-out on every multi-host resolve). 7 x 20 / 15s = 9.3
   probes/s fleet-wide, ~1.3/s per host, plus bursts of up to 224 on cache
   expiry; each probe returns every instance with `_count.Message/Chat`
   aggregates over a 7-day table. The 9s abort then flips hosts unhealthy,
   feeding finding 2. CODE. **Largely closed 2026-09-16 by the stored-host
   early return in `resolveHost`; single-flight + `?instanceName=` on the
   remaining placement-path probe still to do.**
2. **P0 - a transient probe failure re-routed a LINKED user off their host,
   and the send path registered a fresh instance there.**
   `host-placement.ts:120-135`, `evolution.ts:1318`, `:1853-1894` ("SHARED
   creds from the database" - the single-DB Render assumption; the fleet is
   per-host Postgres). Phantom instance uncounted by the cap; `conn.ok ===
   false` records `noteSendOutcome(email,"hard")` (`:3248-3251`), so three host
   timeouts trip the traveller's stop-loss. All hosts dark at once ranked all
   200 users onto one box. **VERIFIED AND FIXED 2026-09-16**
   (`src/lib/wa/host-affinity.test.ts`).
3. **P0 - a second device registration on another host.** The re-link path
   (`evolution.ts:1970`, `forPlacement: true`) went through the same branch;
   the old instance stayed in the dead host's store; on recovery two live
   sockets -> `connectionReplaced`. `fleetTruth().dualSockets`
   (`fleet-truth.ts:144-156`) sees it only via the hourly rollup
   (`risk-rollup.ts:154`). **FIXED with 2** (a configured host keeps its users;
   only removing its line releases them).
4. **P1 - the webhook re-arm reaches 50 of 200 instances, always the same
   50.** `evolution.ts:901-915` (`limit = 50`, `order=updated_at.desc`), every
   ~5 min at `ping/route.ts:147-151`; `markOpen` -> `saveSession` stamps
   `updated_at` (`:1618`) so active users pin the top; no cursor (contrast
   `recentActiveSenders`, `wa-sync.ts:44-49`). After a token rotation ~150
   instances keep the old token and every inbound is 403'd (not the 503 path).
   CODE. (F234 for the sequential half.)
5. **P1 - the fleet compose dropped the heap cap, memory limit and log
   rotation that render.yaml has.** `deploy/fleet/docker-compose.yml:80-141`
   vs `render.yaml:191-192`: no `NODE_OPTIONS`, no `mem_limit`/`cpus`, no
   `logging:` options; `setup.sh` creates no swap. On 1 GB lanes the kernel
   OOM-kills the largest RSS and `restart: unless-stopped` reconnects 25
   sockets at once. OPS (one compose edit, re-applied per host).
6. **P1 - two uncached Supabase reads on every Evolution call.**
   `evolution.ts:1260-1263` (`wa_sessions`, strict) and `:1289` ->
   `linkedNumberFor` (`app_users`, `:1184-1190`). **Second half closed
   2026-09-16** (the stored return skips `linkedNumberFor`); the `wa_sessions`
   read per `evo()` call remains. CODE.
7. **P1 - a geo-mismatched placement wrote an `agent_events` row on every
   serve call.** `evolution.ts:1304-1306`. **FIXED 2026-09-16** (gated on
   `forPlacement`).
8. **P1 - the recovery sweep is bounded per invocation and unbounded per
   fleet; its roster tops out at exactly 200.** `wa-sync.ts:50-53`
   (`status=eq.open&limit=200`), `:22,86-89` (12s per-process throttle),
   `:181`; `sweep.ts:29-31`. User-poll path: 15-20 sweeps/s at 200 users ->
   75-200 `/chat/findMessages`/s over 7 hosts. At 201 open sessions rows fall
   out in arbitrary order. CODE. (F256, F001 partly.)
9. **P2 - the choke-point panel reports occupancy on a dead host as healthy.**
   `admin/chokepoints/route.ts:47-48` reads `hostCapacity()`, which skips the
   probe (`evolution.ts:1132-1141`). CODE.
10. **P2 - the compose prune sleeps 24h before its first run and never touches
    `Chat`.** `docker-compose.yml:150-166`; `restart: unless-stopped` resets the
    timer; `DATABASE_SAVE_DATA_CHATS=true` (`:117`) accumulates unpruned. OPS.
    (F174 is the Render half.)

Checked and clean: `wa_suppressions` read only on `isNewContact`
(`wa-guard.ts:2690-2693`); `resolveTransport`'s stamp read only at outreach
admission; `hostUserCounts` cached 10s; `parseHostCap`/`splitHostLines` and
the fullness ranking correct.

**Verdict:** the binding item was 2 (now fixed). Cheapest order for the rest:
single-flight the placement probe, a round-robin cursor in
`rearmOpenWebhooks`, then `mem_limit` + `NODE_OPTIONS=--max-old-space-size=384`
+ `logging.max-size` in the compose before any host carries real numbers.
