# Scale, latency and agent pipeline - what production actually shows

Date: 2026-09-21. Every number here was read from the live database (project
`Wheel Deal`, read-only, aggregates only - no message bodies were read) or
measured on a local run of the real pipeline against simulated shops. Nothing
in production was changed.

This exists because the brief asked for "200 concurrent users x 12 shops,
sub-10-second AI replies, 100% safe from bans, 100% free". Those four cannot all
be true at once, and the honest way to say so is with the measurements.

## 1. Where production is today

- **6 users. 53 negotiation threads. 1 booking. 4 linked WhatsApp sessions.**
  129 distinct shops messaged in 90 days, 1,805 inbound and 2,098 outbound
  messages.
- Database: 124 MB of a 500 MB free tier. 63 MB of that is orphaned data (see
  section 6).

The 200-user target is about 30 times today's usage. It is a plan, not a load.

## 2. Reply latency: 97 seconds, and why

Measured from the shop's message to our next outbound message to that shop,
counting only the last message of a burst, over 90 days (140 answered turns):

- median **97 s**, 90th percentile **8.4 min**, 99th percentile 22 min
- **12.1%** of replies within 10 s
- by month: Jul 157 s, Aug 79 s, Sep 98 s

The app's own `turn-latency` events agree: `composeMs` **45,513 - 56,388** with
`plannedDelayS: 0`, and `outcome: "parked"` on 8 of 8. `reply-latency`
(`inboundToWireMs`): median 80.8 s.

**The AI is not the slow part.** `agent_traces.ms`, median per stage: director
0.8 s, ladder 1.6 s, style validator 1.1 s, deliver 0.4 s. A whole turn needs
roughly 3 to 5 seconds of thinking. The ladder's 90th percentile is 22.6 s -
that tail is the clue.

**The provider ladder is.** `ai_usage`, last 30 days:

- cerebras: 274 calls, **100% failed** - HTTP 402 "payment required". Its free
  tier ended in July 2026.
- sambanova: 32 calls, **100% failed** - 429.
- openrouter: 112 calls, 74% failed - 429, and 404 on `gpt-oss-20b:free`, which
  was delisted.
- mistral: 38 calls, 68% failed - 429.
- deepseek: 117 calls, 44% failed - timeouts at about 3.4 s.
- groq: 325 calls, 22.5% failed - 429. This is the workhorse.

`lib/ai.ts` had predictive budgets (`ai-rpm`: "this minute is probably spent")
and **no memory of a real refusal**. A rung that answered 402 was tried again on
the very next call, with up to 14 s of ceiling, and a turn makes several AI
calls. The turn ran into its wall, was parked, and the reply waited for the
once-a-minute drain cron. `provider-health.ts` even carried a comment claiming
"the chain skips the provider" for a paywalled rung. Nothing did.

**Fixed on this branch:** `lib/ai-breaker.ts`. A refusal opens that rung's
breaker for as long as that kind of refusal lasts (payment required or a bad
key: hours; a delisted model: 30 min; a rate limit: a minute, doubling, capped
at 15; two timeouts in a row: 30 s). It can only make the ladder faster, never
emptier, and `AI_BREAKER=off` removes it. An integration test drives the real
ladder against a stubbed network: breaker off, the dead rung is called again on
the second request (the production bug, reproduced); breaker on, never.

**Expected effect:** compose time falls from about 50 s toward the 3-5 s the AI
needs. It has NOT been measured in production, because it is not deployed.

## 3. "Sub-10 seconds" against "safe from bans"

These pull in opposite directions, and the code already knows it.

After composing, a reply is **deliberately parked 10 to 40 seconds ahead** and
delivered by a per-sender dispatcher. That is anti-ban humanisation: in the
code's own words, "an instant answer is a real ban vector". CLAUDE.md marks the
pacing constants do-not-touch, and they were not touched.

The balance already exists, unmerged: commit `24b9d97` (2026-09-18) measures the
pause from the SHOP'S message, tops it up to a human floor, and never overshoots
ten seconds when compose is fast. Once compose is 3-5 s (section 2), a
10-second reply becomes reachable on the reply lane. It is not reachable while
compose takes 50.

**"100% safe from WhatsApp bans" is not achievable.** The personal-number lane
is an unofficial WhatsApp Web connection (Evolution / Baileys); WhatsApp does
not permit it, and the app's own Terms say so. Risk can be reduced - and is,
with real enforcement (section 4) - never removed. The only ban-proof lane is
the official Business API (WABA), which the app already supports for first
contact and which has no pacing at all inside its 24-hour window.

## 4. Anti-ban: observed working, not assumed

A real hunt was driven through the real guard against simulated shops.

- Six openers to Thai numbers at 21:15 Bangkok time were **all held** -
  `wa-hold: outside recipient business hours` - and scheduled for the next
  morning at **08:03, 08:12, 08:14, 08:19, 08:27 and 08:36** local. Six
  different jittered minutes, not one batch.
- Against an open market: 1 sent immediately, 3 paced behind it
  (`batchGapSeconds: 12`, `batchWindowMinutes: 15`), with the intro budget
  reported (cap 24 per 3 hours).
- The business-hours window is read from the `whatsapp_security_policies`
  table, not hardcoded.

## 5. Bargaining leverage: works, but only on this branch

In the same run: a six-round negotiation took one shop from 270 to 210; **a
rival's price was used as leverage against another shop** ("someone else here is
at 250/day. Any chance..."); an out-of-stock shop was closed politely; two silent
shops were left alone.

This is commit `24b9d97` again. Before it, the re-bargain trigger compared an
arriving quote against a figure that already contained it, so
`new < lowest * 0.95` could never be true and a cheaper shop never woke the
dearer ones. **Production still runs the old code.** The highest-impact action
for bargaining is merging, not writing anything new.

## 6. Data and storage findings

- **37 orphaned Evolution tables** sit in the production app database with RLS
  off: `Message` 65,511 rows dated 2024-06-03 to 2026-07-05, `Contact` 1,712,
  `Chat` 899, `Session`, `Instance`. The newest row is 2026-07-05: Evolution
  moved to its own database and nothing prunes these. **Verified not an active
  leak** - `has_table_privilege` shows `anon` and `authenticated` hold no
  SELECT, INSERT or DELETE, so Supabase's "fully exposed" advisory is a false
  alarm here. It is still two years of personal messages kept with no purpose,
  against a Privacy Policy that says seven days, and it is half the database.
  Dropping them is destructive: the owner's call.
- **`agent_golden_cases`: 0 rows. `policy_versions`: 0 rows.** CLAUDE.md says
  every behaviour change is gated by the golden replay suite. With zero cases
  the gate passes anything. This matters for section 7.
- 50 of 53 threads carry no `stage`: the funnel stage ledger postdates them.
- `ops_learning` is 189 characters - the learning loop has barely been used.

## 7. "Zero hardcoded prompts" - what is true, and the safe way there

- Already database-driven: `graph_spec` (24,785 characters, versioned),
  `orchestrator_config`, the policy overlay, the security policies, every
  provider model id, the pacing mode, the transport mode.
- Still in code: **34 `role: "system"` call sites across 22 files** (9 in
  `agents.ts`, 3 in `graph/nodes.ts`, 2 each in `orchestrator.ts` and the
  assistant route, 1 each elsewhere), plus the deterministic reply templates.

A big-bang move of all 34 into the database was **not done, deliberately**. With
zero golden cases there is no way to tell whether the agents got worse, and many
of the 8,000 tests pin prompt wording. The safe order:

1. Seed golden cases from the 53 real threads (Admin -> Ops).
2. Add a prompt registry: code default, database override, versioned through
   `saveVersionedSpec` like the graph spec - the repo's own pattern.
3. Migrate the negotiation-critical prompts first (`spte/pass.ts`,
   `graph/director.ts`, `graph/nodes.ts`), one per gated change.

## 8. Redis vector database - evaluated, not built

`corpus_embeddings`: **17 rows, 288 kB**, pgvector 0.8.0, **an HNSW index
already in place**. A Redis vector store would add an account, a second store to
keep consistent, and nothing else at this size.

The real gap is different: `embed_model` on every row is **`lexical:v1`**, a
hashing fallback. Semantic retrieval in production is not semantic yet. A real
embedding model is the improvement worth making, and no vector store changes it.

## 9. "100% free" at 200 users

The free LLM tiers are rate-limiting at SIX users (section 2). The repo's own
plan (`docs/200-USERS-PLAN.md`) put the free ladder at about 39 users a day and
Supabase's 5 GB monthly egress at about 18 minutes of 200-user load. Those
estimates now have production evidence behind them.

Free is a reasonable constraint for today's load. It is not compatible with 200
concurrent negotiating users, and no code change makes it so. The cheapest real
step is one paid LLM key with a daily cap - the ladder already orders paid rungs
last so routine turns never bill while a free rung answers.

## 10. Users - dry run only, nothing deleted

`app_users` has 6 rows. The brief asked to keep only the owner "via Google
OAuth". Two facts make a literal reading dangerous:

- **The owner's row is `provider: dev`**, with a password hash - not Google
  OAuth. Any cleanup keyed on provider would delete the account holding 190
  searches and 52 threads.
- One of the other five has **1 real booking and a live linked WhatsApp session
  (`open`)**. Erasing them deletes a rental record the app deliberately never
  prunes and tears down a third party's WhatsApp link. The other four have 0-2
  searches and nothing else.

The "beta artifacts" are not leftover code. `allowlist.ts` is the product's
access control, enforced at every session-issuing entry point and re-checked on
every `/me` poll; `BETA_LOCK=off` already opens it, and Admin -> Users edits the
list. `TEST_MODE` governs billing: off means real charges. Both are one-switch
decisions. Deleting the code would remove the ability to close the door again.

## 11. Infrastructure, from the GCP inventory

- The production gateway VM runs code from before 2026-07-26 (`/readyz`, added
  that day, answers 404). It only redeploys when its startup script re-runs.
- Cloud Run `evolution-api` has been dead since 2026-08-17: its image no longer
  exists. Cloud Run is the wrong home for Evolution anyway.
- Firewall: RDP 3389 and SSH 22 are open to 0.0.0.0/0 on a Linux-only project.
- GCP's one Always Free VM is already in use, so 200 WhatsApp sockets at $0
  inside GCP is not possible. `deploy/fleet/gcp-lane.sh` provisions a paid lane
  in one command (about $34 a month per 50 numbers) and defaults to a dry run.
