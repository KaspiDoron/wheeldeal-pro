# CLAUDE.md

Guidance for Claude (and humans) working in this repo.

## What this is

**WheelDeal** - a mobile-first web app that finds and negotiates the cheapest
car / motorbike / scooter rentals near a traveller's hotel. The negotiation is
REAL: AI agents message rental shops over live WhatsApp - by default from the
traveller's OWN linked number (Evolution API v2 / Baileys, a disclosed
ban-risk), with an optional company-WABA first-contact lane for opted-in
partner shops - read the replies (text, photos of price boards, voice notes,
any language), and bargain toward a market-grounded floor. Next.js 14 (App
Router) + TypeScript + Tailwind, deployed on GCP Cloud Run. Runs fully in
**demo mode** with zero external services.

## Golden rules

- **Never commit secrets.** All keys come from `process.env` or the Supabase-
  backed Key Vault. `.env*` is gitignored. `.env.example` holds placeholders only.
- **Everything degrades gracefully.** Every integration (LLM, Supabase,
  WhatsApp, email, PayPal) has a no-key fallback so the app always builds and
  runs - and every admin surface must render honest "unknown/unreadable"
  states over a dead store, never a confident zero (`sbSelectDark`,
  `sbCountDark`, `degraded[]`).
- **Honest writes.** A toggle or config write reports whether it PERSISTED
  (read-back echo, 502 on a failed durable write) - never optimistic success.
- **Anti-ban constants are DO-NOT-TOUCH** (pinned in `wave8-scale.test.ts`):
  the 8s hard per-recipient floor, the `max(5, min_gap/2)` fleet gap, the
  2-intros-per-sender cold cap. Read `ANTI-BAN.md` + `PRODUCTION-READINESS.md`
  before changing wa-guard, pacing, usage limits or outbox draining.
- **Use only short hyphens `-`** in code and copy. No em/en dashes.
- **Mobile first.** Test at 320-430px. No horizontal overflow. Respect
  safe-area insets (`pt-safe`, `pb-safe`). Form controls >= 16px (iOS zoom).
- Validate before pushing: `npm run typecheck && npx vitest run` (plus
  `npm run build && npm run check:mobile` for layout-touching changes).
- **Every user-visible string goes through `t("...")`** and must be in the
  generated catalogue: run `node scripts/gen-i18n-catalog.js` after adding
  copy. Computed copy is declared in `src/lib/i18n-extras.ts` - never hand-
  edit `i18n-catalog.ts`.

## Architecture

```
src/
  app/
    page.tsx                Main app: search -> outreach -> live negotiation -> booking
    login/ profile/ admin/  Password+Google auth, profile (DSAR: export/erase,
                            consent toggles, sign-out-everywhere), management
    api/
      outreach outreach/mass    start conversations (guard -> claims -> wire)
      activity replies thread   the traveller's live view of the funnel
      deals bookings            Trips: history, price re-check, lifecycle taps
      negotiate/close-deal      deal close (banks deal_memory, consent-stamped)
      webhooks/evolution        inbound WhatsApp (token-gated, 503 = redeliver)
      webhooks/whatsapp         Meta Cloud API lane (WABA) + signature check
      webhooks/paypal           billing events
      wa/ping wa/tick wa/reply-tick   the drain/sweep cron surface (token-gated)
      profile/export profile/erase profile/consent   DSAR + opt-in purposes
      admin/*                   management (session-gated; transcripts owner-only)
      admin/ops/*               OWNER-only AI Operations Center
      admin/waba                Architecture card (transport mode, WABA switches)
  lib/
    spte/            THE PRIMARY ENGINE (single-pass turn engine): live
                     negotiation turns, digest/thread-facts, deal memory
    graph/           the deterministic FAILOVER engine + golden replay target
    engine-route.ts  the single routing authority between them
    wa/              transport contract (transport.ts), Evolution adapter
                     (transports/evolution.ts), pacing/claims, ingest,
                     inbound-gate, suppression, webhook-token
    waba/            company-WABA lane: leads, dispatch, templates, governor
    funnel/stages.ts THE STAGE LEDGER: advanceThreadStage writes
                     negotiation_threads.stage + one funnel-stage event per
                     transition (evidence-based; the one source of truth the
                     client, admin and product_events all read)
    bookings.ts      booking lifecycle (advanceBooking; completed joins funnel)
    wa-guard.ts      outbound guard: budgets, dedupe, fairness, drain
    evolution.ts     Evolution API client (sessions, sends, webhook re-arm)
    privacy/         user-tables.ts (THE ERASURE REGISTRY), erase.ts,
                     product-events.ts (consent-gated projection)
    consent.ts       acceptance ledger + the two opt-in purposes (consentFor)
    ops/             Ops Center: golden gate, insights rollup (k>=20), vitals
    ai.ts ai-rpm.ts  LLM provider ladder + fleet RPM budgets
    runtime-config.ts  Key Vault + the honest PostgREST client family
    session.ts       HMAC cookie sessions: revocation horizon, 90d absolute
                     lifetime, blocked/erased checks; ADMIN_EMAILS role gate
supabase/schema.sql        run on setup, idempotent (RLS on, service-role only)
supabase/perf-indexes.sql  run once per database
supabase/retention.sql     run once; prune + de-identify + heartbeat + the
                           anon revoke. The app calls prune_old_rows itself
                           hourly (lib/retention.ts), so pg_cron is optional
```

## Key mechanics

- **Two engines, one router.** SPTE (`lib/spte`) answers shops in production;
  the graph engine is the deterministic failover and the golden-replay
  subject. `engine-route.ts` decides; `meta.engine` stamps every outbound.
  The golden gate (`lib/ops/golden.ts`) replays BOTH engines for every case.
- **Transport is a contract.** `resolveTransport` precedence: per-thread stamp
  (`negotiation_threads.fields.transport`, write-once at first DELIVERED
  contact) > `TRANSPORT_MODE` flag > `evolution`. The WABA lane does opt-in
  two-step first contact (number withheld until the shop replies YES); the
  reply leg is always the traveller's own wire. Fleet-wide shop suppression
  (`wa_suppressions`) is honored by every lane.
- **The funnel ledger is the truth.** Search -> selected -> contacted ->
  replied -> understood -> price_received/verified -> negotiating -> terms ->
  verifying -> shop_confirmed -> booked -> completed, each stage advanced only
  on evidence via `advanceThreadStage`. Client, admin and the consent-gated
  `product_events` projection all read the same rows - never recompute stage
  client-side.
- **Runtime config**: secrets resolve Supabase override -> `process.env`,
  cached 30s. Admin-pasted keys are AES-256-GCM encrypted (key derived from
  `SESSION_SECRET`). Bootstrap secrets are env-only.
- **Sessions**: password change / block / erase / sign-out-everywhere move
  `app_users.sessions_valid_from`; cookies carry issuedAt + firstIssuedAt
  (90-day absolute ceiling). Password reset is token-based (a request changes
  nothing; redemption proves the inbox).
- **Privacy is code**: `privacy/user-tables.ts` registers every user-keyed
  table; erase + export walk it, a schema-grep test refuses unregistered
  tables. Retention windows (90/180/360d + priced-transcript de-identify) run
  nightly with a heartbeat the health panel reads.

## AI Operations Center (Admin -> Ops, owner only)

Cross-user negotiation review + a REAL learning loop: owner ratings, branch
verdicts, corrections and bookmarks compile into `app_config.ops_learning`
(director priors + exemplars + judge calibration, kill switch `OPS_LEARNING`);
thresholds live in the clamped `policy_overlay`; every behavior change is a
`policy_versions` row gated by the deterministic golden replay suite
(`agent_golden_cases`; `replayConversation` + `replaySpteTurns` in
`src/lib/simulate.ts`) with one-click rollback. Key libs: `src/lib/ops/*`,
`src/lib/policy.ts`. Never bypass `saveVersionedSpec` when writing the graph
spec or overlay.

## Operations

`PRODUCTION-READINESS.md` is the living scale/ops review; `SCALING.md` covers
the drain/queue mechanics and their honest limits; `ANTI-BAN.md` the pacing
doctrine. Read them before changing wa-guard, usage limits or the
outbox/wakeup draining.

## Deploy

Bootstrap env vars in GCP Secret Manager: `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SESSION_SECRET`,
`ADMIN_EMAILS`, `APP_DOMAIN` (the public GCP gateway URL); optional
`WEBHOOK_TOKEN_SALT` (webhook-token rotation without touching
`SESSION_SECRET`), `REDIS_URL` (fleet-wide rate limits + AI RPM). Run ALL
THREE SQL files: `supabase/schema.sql`, `supabase/perf-indexes.sql`,
`supabase/retention.sql` (the health panel's retention tile stays red until
the prune has actually run; the app self-runs it hourly from the cron ping, so
pg_cron is optional - but the FILE is mandatory, because it also revokes the
anon grant on `prune_old_rows`). Evolution runs against its OWN database -
never the app's Supabase project. Its save-data posture (render.yaml, owner
report 8): `CONTACTS=false`, `MESSAGE_UPDATE=false`, but `NEW_MESSAGE=true` +
`CHATS=true` - the missed-reply recovery sweep reads a 10-row tail per chat
via `/chat/findMessages`, and turning the store off silently breaks that
rescue. The price is a transient copy of EVERY message on the linked number
(personal chats included) in the dedicated DB, so the 7-day `wd-evo-prune`
cron is MANDATORY, and the Privacy Policy discloses the transient store. The
admin anon-probe (`/api/admin/rpc-exposure`) alarms if foreign tables ever
appear in the app's own Supabase. All other
keys can be pasted in Admin -> Keys (`OPERATOR_NAME` renders red until set).
See `GUIDE.md` for the step-by-step. GCP (Cloud Run web + gateway + workers)
is the primary target; `render.yaml` + `deploy/*` remain the live Render half
and are NOT dead code.

## Working branch, and what deploys

Develop on `claude/wheeldeal-production-architecture-91hmfq`. Commit + push
there, then merge into `master` with `--no-ff`.

**`master` is the only thing that deploys, and BOTH deploy paths read it:**

| What | Reads | Triggered by |
|---|---|---|
| Cloud Run (the app) | `master` | push, via `.github/workflows/deploy-gcp.yml` |
| Render (Evolution + crons) | `master` | the Blueprint, on Manual Sync |

A change to `render.yaml` does nothing until it reaches `master` AND somebody
applies it - the Blueprint does not follow a feature branch.

> Earlier versions of this section named `claude/rental-negotiation-app-pc33ux`
> and then `claude/rental-agents-legal-setup-o7rgcv`, both retired. If you
> rename or retire a branch, grep the repo for its name before you delete it.

### The Render Blueprint is OPTIONAL - do not treat it as the deploy path

Manual Sync has been failing with `not found: file:
github.com/KaspiDoron/wheeldeal-pro/render.yaml` even though the Blueprint's
own Settings show Branch = `master` and Blueprint Path = `render.yaml`. **The
repo side is verified clean** - `render.yaml` is a normal committed file at the
repo root on `master`, it is not gitignored, it is the only root-level YAML,
and a GitHub **API** read of that exact path at `refs/heads/master` returns the
file. The 404 is produced inside Render, from state Render holds; its own UI
contradicts itself (Settings says `master`, the breadcrumb still shows a branch
deleted months ago), which is the signature of a record that did not fully
write. The repo rename `Rental-App` -> `wheeldeal-pro` is the likely trigger.

**So do not block on the Blueprint.** Every service it describes already
exists and runs. To apply a `render.yaml` change while Render is still in the
stack, do it by hand in the dashboard - which is also SAFER, because a
Blueprint sync restarts `wd-evolution` and drops every linked WhatsApp socket
at once, while editing one service or adding a cron does not.

If the Blueprint is worth repairing: **Disconnect Blueprint** (this does NOT
delete services), then create a new one from `master` - services are adopted by
name. If the repo is missing from the picker, Render's GitHub App lost it in
the rename (Render -> Settings -> GitHub -> Configure). If the Blueprint's Sync
Hook URL fails identically, the fault is Render-side and belongs in a support
ticket, not in this repo.

`AUTHENTICATION_API_KEY` is `sync: false` and is unaffected by any of this -
that is exactly what `sync: false` protects.

## MCP servers (tooling for AI-assisted development)

`.mcp.json` wires the official remote MCP servers for the external services
this app uses, so Claude Code (and other MCP clients) can inspect them
directly. All are HTTP + OAuth - authorize interactively via `/mcp` in a
Claude Code session; NO keys are stored in the repo.

| Service | MCP | Notes |
|---|---|---|
| Supabase | `https://mcp.supabase.com/mcp?project_ref=...` | DB, app_config vault, tables |
| GitHub | built into Claude Code remote sessions | PRs, issues, CI |

Services with NO official MCP server as of 2026-07 (use their REST APIs via
the code in `src/lib/`): Evolution API (WhatsApp), PayPal, Groq,
Gemini, OpenRouter, Cerebras, Mistral, DeepSeek, Together, SambaNova,
Hugging Face, Brevo, Resend, Gmail SMTP, Google Maps Platform, OSM Nominatim,
Google AdSense, Web Push/VAPID.

## Owner switches (Admin -> Keys / Users / Architecture card)

- `TEST_MODE` - "on": beta testers flagged `test` ride Ultra free, checkout
  applies plans instantly with no charge, a global banner shows. Toggle also
  lives in Admin -> Users. "off" (or unset): fully live.
- `SCALE_MODE` - "on": 3x per-user rate limits + relaxed client polling for
  high-concurrency periods (flip AFTER upgrading the backend plans).
- `TRANSPORT_MODE` - `evolution` (default) | `waba-first` | `waba-fallback`:
  first-contact routing (per-thread stamps always win). Flipped from the
  Architecture card (Admin -> WABA), which also holds `WABA_ENABLED`,
  `WABA_DRY_RUN`, `CLOUD_API_ENABLED` and `WABA_KILL`.
- `APP_DOMAIN` - the public domain; drives SEO/share metadata, geocoder
  identity and push sender identity with no redeploy.
- `HUMAN_TAKEOVER` - "off" disables user-typed-message takeover detection.
- `OPS_LEARNING` - kill switch for the Ops learning loop.
- `OPERATOR_NAME` - the legal entity the Terms/Privacy name. Red until set.
