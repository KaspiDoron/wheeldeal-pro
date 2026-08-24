# CLAUDE.md

Guidance for Claude (and humans) working in this repo.

## What this is

**WheelDeal** - a mobile-first web app that finds and negotiates the cheapest
car / motorbike / scooter rentals near a traveller's hotel. AI agents structure
the request, discover partner vendors within a radius, and run a live, gamified
negotiation funnel. Next.js 14 (App Router) + TypeScript + Tailwind, deployed on
GCP (Cloud Run) free tier. Runs fully in **demo mode** with zero external services.

## Golden rules

- **Never commit secrets.** All keys come from `process.env` or the Supabase-
  backed Key Vault. `.env*` is gitignored. `.env.example` holds placeholders only.
- **Everything degrades gracefully.** Every integration (LLM, Supabase, WhatsApp,
  Resend, PayPal) has a no-key fallback so the app always builds and runs.
- **Use only short hyphens `-`** in code and copy. No `-` or `-`.
- **Mobile first.** Test at 320-430px. No horizontal overflow. Respect safe-area
  insets (`pt-safe`, `pb-safe`). Keep form controls >= 16px to avoid iOS zoom.
- Validate before pushing: `npm run typecheck && npm run build`.

## Architecture

```
src/
  app/
    page.tsx                 Main app: search -> funnel -> offers -> booking
    login/ admin/            Passwordless login + management workspace
    icon.svg apple-icon.tsx  Brand mark (half motorbike / half car)
    opengraph-image.tsx      Social card (next/og, generated offline)
    manifest.ts              PWA manifest (standalone => App Store feel)
    api/
      profile   negotiate   safety   vendors      (core funnel)
      outreach                                     (WhatsApp send, safety-screened)
      feedback  feedback/assist                    (triaged feedback + AI writer)
      billing/checkout  billing/confirm            (PayPal, admin only)
      webhooks/whatsapp  webhooks/paypal           (inbound events)
      admin/config  admin/users  admin/analytics   (admin, session-gated)
      admin/ops/*                                  (OWNER-only AI Operations Center)
      auth/login|logout|me
  lib/
    agents.ts        Profiler, Bargaining, Market-Rate, Sentiment, Safety, Feedback agents
    ai.ts            LLM provider abstraction (Groq/Gemini/OpenRouter/Cerebras) + mock
    runtime-config.ts Key resolution: Supabase override -> process.env (+ AES encryption)
    config.ts        Admin Key Vault (masked, never leaks secrets to client)
    session.ts       HMAC-signed cookie sessions; admin via ADMIN_EMAILS allowlist
    whatsapp.ts email.ts paypal.ts   integrations (all optional)
    plans.ts                         plan catalogue (Pro/Ultra, provider-neutral)
    memory.ts access.ts vendors.ts geo.ts brand.ts types.ts
  components/        UI (VendorCard, MapView, Tracker, Filters, BookingSheet,
                    FeedbackModal, TabBar, BrandMark, icons, ...)
supabase/schema.sql  Run once; RLS on, service-role only
```

## Key mechanics

- **Runtime config**: integration secrets resolve as Supabase override ->
  `process.env`, cached 30s per instance. Admin-pasted keys are AES-256-GCM
  encrypted (key derived from `SESSION_SECRET`) and stored in `app_config`, so
  they persist on serverless and apply without a redeploy. Bootstrap secrets
  (Supabase connection, `SESSION_SECRET`) are env-only / read-only in the UI.
- **Admin gate**: `getSession().isAdmin` is derived from `ADMIN_EMAILS`, never
  from client input. All `/api/admin/*`, billing, and the admin page check it.
- **Negotiation** is simulated server-side (round-based price cuts bounded by the
  Market-Rate Analyst). Swap in real WhatsApp threads later via the webhook +
  `whatsapp_messages` table.

## AI Operations Center (Admin -> Ops, owner only)

Cross-user negotiation review + a REAL learning loop: owner ratings, branch
verdicts, corrections and bookmarks compile into `app_config.ops_learning`
(director priors + exemplars + judge calibration, kill switch `OPS_LEARNING`);
thresholds live in the clamped `policy_overlay`; every behavior change is a
`policy_versions` row gated by the deterministic golden replay suite
(`agent_golden_cases`, `replayConversation` in `src/lib/simulate.ts`) with
one-click rollback. Key libs: `src/lib/ops/*`, `src/lib/policy.ts`. Never
bypass `saveVersionedSpec` when writing the graph spec or overlay.

## Operations

`PRODUCTION-READINESS.md` is the living scale/ops review: queue mechanics,
anti-ban budgets, the honest TEST_MODE truth table, tester/host capacity and
the P1/P2 launch roadmap. Read it before changing wa-guard, usage limits or
the outbox/wakeup draining.

## Deploy

Bootstrap env vars in GCP Secret Manager: `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SESSION_SECRET`,
`ADMIN_EMAILS`, `APP_DOMAIN` (the public GCP gateway URL). Run
`supabase/schema.sql`. All other keys can be pasted in Admin -> Keys. See
`GUIDE.md` for the step-by-step. GCP (Cloud Run web + gateway + workers) is
the primary target; `render.yaml` + `deploy/*` remain the live Render half
and are NOT dead code.

## Working branch, and what deploys

Develop on `claude/rental-agents-legal-setup-o7rgcv`. Commit + push there, then
merge into `master` with `--no-ff`.

**`master` is the only thing that deploys, and BOTH deploy paths read it:**

| What | Reads | Triggered by |
|---|---|---|
| Cloud Run (the app) | `master` | push, via `.github/workflows/deploy-gcp.yml` |
| Render (Evolution + crons) | `master` | the Blueprint, on Manual Sync |

A change to `render.yaml` does nothing until it reaches `master` AND somebody
applies it - the Blueprint does not follow a feature branch.

> This section previously named `claude/rental-negotiation-app-pc33ux`, which
> stopped existing long ago. If you rename or retire a branch, grep the repo
> for its name before you delete it.

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

## Owner switches (Admin -> Keys / Users)

- `TEST_MODE` - "on": beta testers flagged `test` ride Ultra free, checkout
  applies plans instantly with no charge, a global banner shows. Toggle also
  lives in Admin -> Users. "off" (or unset): fully live.
- `SCALE_MODE` - "on": 3x per-user rate limits + relaxed client polling for
  high-concurrency periods (flip AFTER upgrading the backend plans).
- `APP_DOMAIN` - the public domain; drives SEO/share metadata, geocoder
  identity and push sender identity with no redeploy.
- `HUMAN_TAKEOVER` - "off" disables user-typed-message takeover detection.
