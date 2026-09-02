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
| Retention never ran | Health panel Retention tile red | Read WHICH red it is. "NOT INSTALLED" means the app tried to run the prune itself and Supabase answered 404 - `prune_old_rows` was never created, so run `supabase/retention.sql` once in the SQL editor (idempotent). "NEVER RAN" / "STALE" with the function installed means the schedule stopped; the app now self-runs it hourly from `/api/wa/ping`, so check that the ping is firing. The tile reads the heartbeat row the prune writes - green means it RAN, not that a file was pasted. pg_cron is optional; the SQL file is not, because it also revokes the anon grant. |
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

## Adding a beta tester

`GUIDE.md` pointed here for this and the section did not exist. It does now.

**Where.** Admin -> the **"Private beta - invite list"** card. It is its own
panel, not under Admin -> Users (which manages accounts that already exist).

**What to paste.** One line per tester, split on `,` `:` or `|`:

```
alice@example.com, ultra, test
bob@example.com,   ultra
```

- **email** - lowercased for you.
- **plan** - `free` | `pro` | `ultra`. Defaults to `free` if omitted.
- **`test`** - optional third field. Combined with the `TEST_MODE` switch it
  gives that person Ultra free, applies checkout plans instantly with no charge,
  and exempts them from the number warm-up. Without `TEST_MODE` on, the flag
  does nothing.

Save writes the whole list at once. The ceiling is 100 entries; anything past it
is dropped and the response says how many.

**Pin testers to `ultra`.** On `free` a day-0 tester's first search contacts 10
of the 24 shops the app can reach, and the beta's whole point is the wide sweep.

**Being on the list is not a socket.** The allowlist gates SIGN-IN. WhatsApp
capacity is enforced separately, at link time, by the per-host cap - so a
25th tester can sign in happily and then be refused when they try to link. Watch
the invite tile in Admin -> Chokepoints: it goes red BEFORE the failure, and at
one host with the default cap of 25 the red starts at the 26th invite (the
owner's own linked number counts).

**Removing a tester** is deleting their line and saving. It blocks the next
sign-in; it does not sign out a live session or erase data - use Admin -> Users
for either.

**Order of operations for a cohort.**

1. Confirm host headroom first (Admin -> Chokepoints, the invite and occupancy
   tiles). Add an Evolution host before the invites if it is amber.
2. Paste the cohort with `ultra`.
3. Stagger the pairings over several days. Connect time is where a ban fires,
   and 25 numbers linking from one datacenter IP in one afternoon is the exact
   shape the cluster alarm exists to warn about.
4. Set `EVOLUTION_PROXY_TEMPLATE` if the numbers are not already spread across
   hosts.

## Turning the semantic corpus on (optional)

`docs/VECTOR-SPEC.md` is the design. Phase 1 - the corpus - is shipped; the
readers are not, so nothing about this can change a single outbound message.

**The one action no code can take:** Supabase -> **Database -> Extensions** ->
enable `vector`, then re-run `supabase/schema.sql`. Within 60 seconds the app
switches itself on with **no redeploy** (the schema probe caches a negative for
one minute and a positive for ever). Skipping it costs nothing at all: the whole
block sits inside an extension guard, so the file prints one notice and the app
behaves exactly as it does today.

**How to tell it is working** - Admin -> Health, the `corpus` tile:

| field | means |
|---|---|
| `state: "ready"` | pgvector is on and the table exists |
| `state: "missing"` | not enabled, or `schema.sql` was not re-run afterwards |
| `state: "unavailable"` | Supabase did not answer. NOT a migration signal |
| `queued` | rows enqueued, waiting for the cron to embed them |
| `neural` / `lexical` | rows embedded, per model - they are separate spaces |

A healthy corpus has `queued` rising as shops reply and falling every five
minutes as the `/api/wa/ping` backfill drains it, with `neural` climbing. A
`queued` that only grows means the embedder is failing: check `GEMINI_TOKEN` in
Admin -> Keys. `lexical` climbing instead of `neural` is the keyless fallback
doing its job - the corpus still fills, it is simply the weaker vector.

Any non-zero `corpus-gate-missing` in the events counters means exactly one
thing: enable the extension and re-run the schema. It is written ONCE and then
gates its own re-attempt, so it is a state, never a rate.

**Phase 2 starts only when** the tile shows a non-zero `neural` count and a
draining queue. Until then there is nothing worth retrieving.

## 4. The 18 reported problems - final reconciliation

Signed off when the owner has spot-checked each in the product.

| # | Problem | Status | Where |
|---|---|---|---|
| 1 | Currency (bt/baht/bath -> USD, mixed display) | Fixed | W0 token map + ISO whitelist; W3 no-USD chain; W12c `resolveLocalCurrency` on EVERY path (the tick path was still resolving USD and overwriting the thread), and a shared word like "peso"/"dollar"/"rupee" can no longer overrule the shop's own country |
| 2 | Greetings advancing to "pinning the price" | Fixed | W1 split the ledger correctly and it had NO READERS for two waves; W12a wires it to the card and adds the `replied` stage the vocabulary lacked; W13a found that stage was still UNREACHABLE - it was absent from the client's forward-only rank table, so the advance was refused for ever AND it shadowed the legacy rollup that used to work. The rank table is a shared module now and Tracker's own order derives from it |
| 3 | Broken syntax ("27 to 1 the is 1250") | Fixed | W12e `wa/shop-date-range.ts` - the reader this row credited for a wave before it existed. A stated range is two facts: those digits are not money, and the total beside them divides by THAT span |
| 4 | Hallucinated prices on template replies | Fixed | W0 phantom guards; W3 rail; W12b the rail's own exemptions were excusing the phantom classes it was built for (every division, and any reply with a photo even when vision failed), grounding accepted numbers WE typed, and `/api/replies` re-invented a price the writer had already dropped |
| 5 | Native-language price + promo ignored | Partly | W12c: native day/week/month and money words plus magnitude suffixes (150k, 70rb) - recall went 0/14 to 13/13 on real Thai, Vietnamese and Indonesian phrasings. W12g closes the gloss dead band that left Indonesian/Malay/Vietnamese/Spanish untranslated. NOT done: a promo/discount entity - there is still no PromotionTerms in the codebase |
| 6 | Substitute vehicle shown as requested | Fixed | W3 trigger union; W4 alternativeOffer on the card; W12d the verdict reaches the price label and the ranking (a substitute could win BEST PRICE), the pause fires on the union rather than the pre-union signal, and the read sees the gloss, the transcript and the OCR text |
| 7 | Green-button trap | Fixed | W0 muted-chip + "Reply received" |
| 8 | Silent blank UI on no-price reply | Fixed | W4 facts pass + replyUnparsed state + recovery actions |
| 9 | Free-text date/duration duplication | Fixed | W12e `request-window-conflict.ts` - this row credited "W4 conflict chips" and no such surface existed. The typed window is now a chip and is stripped from the accessories, so one message states one rental |
| 10 | Consent data layer / monetization | Fixed | W9d opt-in kinds, product_events projection, k>=20 rollup, legal rewrite |
| 11 | 7 shops stall | Fixed | W0 webhook scoping; W8 mechanism; W12h - the Wave-8 centrepiece was INERT (it advertised a retry instant the straddle guard then refused) and it LEAKED probe rows that later read as previous sends. Proven by an executed 7-shop burst, not a source grep |
| 12 | Language-setting enforcement | Fixed | W2 gloss-bound reads; W4 toggle reachability |
| 13 | Every message type analyzed | Fixed | W3 catalog/poll branches; W5 media handling |
| 14 | ONE engine, graph as failover | Fixed | W0 field persistence; W2 live judge/ladder, steps 7-9, legacy deleted |
| 15 | Management audit + architecture toggle | Fixed | W6 Architecture card; W7 honesty/egress/delivery-trail |
| 16 | Template/catalog mining + follow-up | Fixed | W3 ladder provenance + covered tiers |
| 17 | UI data speed | Partly - see below | W0 waiting predicate; W12g the turn wall clock and the duplicate send-hold; W13c `/api/pulse` - one integer from four indexed rows, polled every 2.5s, waking the heavy fetches on change instead of on their interval (a reply surfaces in ~3s, not ~20s), with the heavy intervals tightening straight back if the pulse goes blind. NOT done: enqueue-first outreach. This row credited it to W4 and no such change exists - the mass tap still blocks on an all-shop opener pre-pass and a live send |
| 18 | Strict vehicle matching / Similar tag | Fixed | W3 trigger union + digit fold; W12d the verdict finally reaches the label, the ranking and the thread pause, and the SIMILAR VEHICLE tag this row credited now exists |
| WBA | Company-WABA handoff + toggle | Built; needs owner go-live actions (section 3) | W5 contract; W6 anchor, dispatch, opt-in, suppression, card |

### What Wave 13 found, and what it cost to believe the ledger

The funnel ledger has been correct since Wave 1 and WRONG AT THE SURFACE for
three waves running, in a different place each time. W12a gave it a reader;
W13a found the reader could not act on it. Six independent mechanisms were
each enough on their own to show a shop under "AWAITING REPLY" minutes after
it had visibly answered on the traveller's phone:

- the `replied` stage was missing from the client's rank table, so the
  advance was refused for ever - and because a non-null ledger stage
  shadowed the legacy rollup, having the ledger was strictly worse than not
  having it;
- `thread_key` was raw digits, and the two writers hold different spellings
  of the same number (Google's national form, the JID's international one),
  so one shop became two rows - one holding the vendor id and frozen at
  `contacted`, one at `replied` that no card could join to;
- `/api/activity` joined inbound to vendors on raw digits too, the exact bug
  `identityKey` exists to prevent and whose own comment names it;
- `TEST_MODE` re-keyed real shops as drills, cutting the inbound window from
  14 days to 3 hours - almost certainly the bulk of the `vendor-gate` count
  on the owner's own account;
- one drill stamp poisoned a thread permanently, because the gate asked
  "any anchor" instead of "the newest anchor";
- a database blip was reported as `no-rfq-thread`, a reason that reads as a
  deliberate outcome, abandoning live negotiations over a transient failure.

The lesson worth keeping: **a vocabulary is not a feature until every layer
that must act on it can express it.** Two of the six were source-grep tests
pinning the defect rather than the fix.

### What the December audits found still open

Recorded here rather than quietly closed, because a reconciliation table
that only lists wins is the thing this section exists to stop being.

- **Enqueue-first outreach (problem 17).** The mass tap still blocks on an
  all-shop opener pre-pass, ~200 sequential round trips and a live send.
  Row 17 credited this to Wave 4 and no such change was ever made.
- **A promo / discount entity (problem 5).** Native prices read now; a
  "free helmet" or "10% off for a week" is still only an English regex
  behind a two-confirmation gate.
- **The graph failover has no cite-the-rival or beat-not-match rail.**
  Its ladder target is clamped below the rival now (W12f), but the rails
  themselves live only in SPTE, so a failover turn can cite leverage
  without the composition guarantees the primary engine has.
- **Six Evolution/Baileys subtypes are dropped with no turn**, and the
  "catalog/poll branches" credited under problem 13 are labels in
  `waMediaKind`, not readers in `waMessageText`.
- **`missedCallReply()` puts hardcoded English on the wire** in a thread
  the agent otherwise conducts in the local language.
- **A third search stamp.** A reply now files its offer under the search
  its own earlier rounds used (W12f); round ONE of a thread whose first
  reply arrives after a new hunt began still takes the newest search.
  Closing it needs a search id stamped on the thread at RFQ time.

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
