# RUNBOOK - disaster recovery + launch gate

The operator's document for the bad day and for the go-live decision. Written
Wave 10; keep it current - a runbook that describes last year's system is a
hazard, not a help.

## 1. What can go down, how you find out, what you do first

| Outage | How it shows | First move |
|---|---|---|
| Supabase (app DB) | Health panel goes dark-honest: counters show "-", panels show retry cards, `degraded[]` non-empty; sends HOLD (fail-closed claims) | Check status.supabase.com. Nothing to fix app-side: queues hold and drain on recovery. Do NOT relink WhatsApp. |
| Evolution host down | WA doctor shows host unreadable (distinct from unconfigured); no inbound; sends fail with sync-retry holds | Restart the container/service on that host. Sockets relink themselves; a QR relink is the LAST resort, not the first. |
| Webhook silent (403 storm) | Health panel `webhookSilent` alarm: outbound recent + session open + no inbound 30min | Almost always a stale token after a SESSION_SECRET or WEBHOOK_TOKEN_SALT change: the ping cycle re-arms via `reassertWebhook`; verify with Admin -> WA doctor. |
| AI providers exhausted | Turn latency panel shows provider errors; `ai-budget-exhausted` events; chain falls down the ladder | Nothing urgent - the ladder + RPM budgets degrade gracefully. Add a provider key or raise `AI_RPM_<PROVIDER>` if paid tier. |
| Redis down/unset | Per-instance budgets only (caps multiply by instance count) - silent otherwise | Restore `REDIS_URL`. Not user-visible short-term; anti-ban budgets are the concern at scale. |
| WhatsApp bans a traveller's number | Risk panel + `wa-ban-risk` events; the traveller loses the number (disclosed risk they accepted) | Suppress further sends for that sender (automatic via stop-loss); the person relinks a different number if they choose. There is no appeal path we control. |
| SESSION_SECRET changed | EVERY vault key unreadable ("all my keys are gone"), all sessions dead, webhook 403s | `node scripts/diagnose-vault.mjs` tells you which case you are in without printing secrets. Set `SESSION_SECRET_PREVIOUS` to the old value - the vault re-reads itself. Never "fix" by re-pasting keys first. |
| Owner locked out | Wrong password + lockout, or blocked by accident | `node scripts/admin-recover-owner.mjs` - sets a known scrypt password on `app_users`, unblocks, clears lockouts. Needs service-role env locally. |
| Retention never ran | Health panel Retention tile red ("NEVER RAN" / "STALE") | Run `supabase/retention.sql` in the SQL editor (idempotent); it schedules pg_cron nightly. The tile reads the heartbeat row the prune writes - green means it RAN, not that a file was pasted. |
| Render Blueprint 404 | Manual Sync fails `not found: render.yaml` | Known Render-side record corruption (see CLAUDE.md). Do not block on it - apply service changes by hand in the dashboard. |

## 2. Backups and what is actually recoverable

- **Supabase**: enable PITR (paid tier) or rely on daily backups (free tier -
  know which you are on BEFORE the bad day). Everything durable lives here:
  accounts, threads, transcripts, vault (encrypted), consents, bookings.
- **The Key Vault escrow is SESSION_SECRET.** The `app_config` rows are
  worthless without it and fully recoverable with it. Store SESSION_SECRET in
  GCP Secret Manager AND one offline copy. `SESSION_SECRET_PREVIOUS` is the
  rotation bridge; `scripts/diagnose-vault.mjs` is the proof tool.
- **Evolution's database** (dedicated, NOT the app's Supabase) holds Baileys
  auth state. Losing it means every traveller relinks by QR - annoying, not
  fatal. Snapshot the volume if the host provider supports it; do not build
  elaborate backup machinery around what a relink fixes.
- **The repo is the config of record** for everything else: schema,
  retention, indexes, workflows, render.yaml.

## 3. Launch gate - the checklist the owner signs

Every line is verifiable in-app or in one command. Do not launch with a red
line unless you write down why.

**Data + platform**
- [ ] `schema.sql`, `perf-indexes.sql`, `retention.sql` all run; Retention
      tile GREEN (a real prune ran, not just pasted SQL).
- [ ] Admin -> "Check anon RPC lockdown" answers LOCKED, and the table probe
      lists ZERO anon-visible relations.
- [ ] Evolution on its own database, `SAVE_DATA_NEW_MESSAGE/CONTACTS/CHATS`
      false on every host; `AUTHENTICATION_API_KEY` rotated if it ever
      appeared in a chat or screenshot.
- [ ] `REDIS_URL` set on Cloud Run (fleet-wide caps); exactly ONE primary
      drain scheduler enabled + the hourly backstop.
- [ ] `SESSION_SECRET` escrowed (Secret Manager + offline); `WEBHOOK_TOKEN_SALT`
      documented as the webhook rotation lever.

**Truth + legal**
- [ ] `OPERATOR_NAME` set (the Keys panel shows it red until then).
- [ ] Terms/Privacy (TERMS_VERSION 2026-08-30) reviewed by the owner; the
      re-acceptance gate will walk every user through it on next sign-in.
- [ ] TEST_MODE off for paid launch.
- [ ] The 18-problem reconciliation below reviewed and signed.

**Behavior under load**
- [ ] Staged 7-shop burst: first reply 15-25s, all seven inside ~60s
      (`hammer-queue.mjs` assists).

      THE OLD LINE SAID "< 10s" AND THE CODE CANNOT DO IT - deliberately.
      Roughly 11s of the wait is intentional anti-bot behaviour: SPTE's human
      pause (up to 10s, and it self-cancels when the turn was already slow) plus
      the Poisson send gap (~1.3s mean). Instant replies are the single
      strongest bot tell this product has, so the delay is the feature. On top
      of that sit the real costs - extraction, comprehension, one composer pass,
      the rails, the guard and the claims - which is where p50 lands at ~15-20s.
      A gate the product must fail to be safe is not a gate.

      The seven-shop figure is the FLEET GAP doing its job: replies take turns
      at ~6s each by design, so the seventh is ~36s out by construction. What
      Wave 8 was really about, and what this line now tests, is that none of
      them re-parks for minutes waiting on the next drain.
- [ ] Health panel all green with live checks run; heartbeat beating;
      guard counters readable.
- [ ] Golden suite green on the live baseline (Admin -> Ops -> replay).

**WABA lane (only if launching it)**
- [ ] WABA credentials pasted; MARKETING first-contact template approved by
      Meta; dry-run rehearsal shows the full funnel moving; ONE real opted-in
      test shop completes lead -> YES -> takeover; kill switch verified.

## 4. The 18 reported problems - final reconciliation

Signed off when the owner has spot-checked each in the product.

| # | Problem | Status | Where |
|---|---|---|---|
| 1 | Currency (bt/baht/bath -> USD, mixed display) | Fixed | W0 token map + ISO whitelist; W3 single-source, no-USD resolution chain |
| 2 | Greetings advancing to "pinning the price" | Fixed | W1/W4 replied-vs-understood split on the evidence ledger |
| 3 | Broken syntax ("27 to 1 the is 1250") | Fixed | W12e `wa/shop-date-range.ts` - the reader this row credited for a wave before it existed. A stated range is two facts: those digits are not money, and the total beside them divides by THAT span |
| 4 | Hallucinated prices on template replies | Fixed | W0 phantom guards; W3 ungrounded-price rail |
| 5 | Native-language price + promo ignored | Fixed | W3 native word tables, gloss-first, promo entities |
| 6 | Substitute vehicle shown as requested | Fixed | W3 trigger union + Similar tag; W4 alternativeOffer on the card |
| 7 | Green-button trap | Fixed | W0 muted-chip + "Reply received" |
| 8 | Silent blank UI on no-price reply | Fixed | W4 facts pass + replyUnparsed state + recovery actions |
| 9 | Free-text date/duration duplication | Fixed | W12e `request-window-conflict.ts` - this row credited "W4 conflict chips" and no such surface existed. The typed window is now a chip and is stripped from the accessories, so one message states one rental |
| 10 | Consent data layer / monetization | Fixed | W9d opt-in kinds, product_events projection, k>=20 rollup, legal rewrite |
| 11 | 7 shops stall | Fixed | W0 webhook scoping; W8 wait-not-repark + per-sender budgets |
| 12 | Language-setting enforcement | Fixed | W2 gloss-bound reads; W4 toggle reachability |
| 13 | Every message type analyzed | Fixed | W3 catalog/poll branches; W5 media handling |
| 14 | ONE engine, graph as failover | Fixed | W0 field persistence; W2 live judge/ladder, steps 7-9, legacy deleted |
| 15 | Management audit + architecture toggle | Fixed | W6 Architecture card; W7 honesty/egress/delivery-trail |
| 16 | Template/catalog mining + follow-up | Fixed | W3 ladder provenance + covered tiers |
| 17 | UI data speed | Fixed | W0 waiting predicate; W4 enqueue-first outreach |
| 18 | Strict vehicle matching / Similar tag | Fixed | W3 trigger union + digit fold |
| WBA | Company-WABA handoff + toggle | Built; needs owner go-live actions (section 3) | W5 contract; W6 anchor, dispatch, opt-in, suppression, card |

**Known deliberate deferrals** (each with its reason recorded at the site):
normalizeEvolutionEvents extraction; per-instance webhook token derivation
(webhook-token.ts); batched claim inserts + drain concurrency pool (Wave 8
commit); insights rollup scheduling (ops/insights.ts); CSP enforcement
(report-only first, next.config.mjs); the route-level funnel e2e - a faithful
harness means emulating PostgREST filter semantics across ~a dozen tables,
and a mocked-into-tautology version is exactly the fake-test class the audit
condemned; the seams are covered instead by funnel/wiring.test.ts (writer
pins), stages.test.ts (rules), route-execution.test.ts (executed handlers)
and the golden replay; the eslint-9 flat-config migration (import/no-cycle) -
the em-dash half of it ships as a vitest ban in docs-truth.test.ts; the
remaining source-grep test conversions to executed tests (the
route-execution.test.ts pattern is the template - convert opportunistically
when touching each surface); the discovery/linking/assistant/training
surfaces still need their own focused audit before outreach volume scales.
