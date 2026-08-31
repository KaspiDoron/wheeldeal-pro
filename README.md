# WheelDeal 🛵💨

**Hyper-local vehicle rental savings & negotiation engine.** Describe the ride
you want in plain English; WheelDeal's AI agents find rental shops near your
hotel, message them on WhatsApp, read every reply - text, price-board photos,
voice notes, any language - and bargain the price down in real time, all from
your phone.

> Built mobile-first (Next.js on GCP Cloud Run · OpenStreetMap · Supabase ·
> free-tier LLM gateways). Runs fully in **demo mode** with no keys or
> external services required.

---

## ✨ Features

- **Plain-text → structured RFQ.** _"125cc scooter with a phone mount, under
  20,000 km, 3 days"_ becomes a clean, shop-ready inquiry.
- **Real live negotiation.** The primary single-pass turn engine (SPTE) reads
  each shop reply, extracts prices (including from photos and voice notes, in
  the shop's own language), checks them against a market floor, and composes
  the next bargaining move - with a deterministic graph engine as failover
  and a golden replay suite gating every behavior change.
- **The 9-step funnel, tracked on evidence:** selected → contacted → replied →
  understood → price verified → negotiating → terms → shop confirmed →
  booked/completed - one stage ledger that the traveller's tracker, the
  management console and the analytics all read.
- **Dual view:** sortable **List** (closest / top-rated / biggest savings /
  active) + interactive **Leaflet map** with live, colour-coded shop pins.
- **Smart Bargain** one-tap counter-offers, plus a **safety-screened** custom
  chat (blocks harmful / unprofessional messages before they send).
- **Trips:** booking lifecycle (deposit, pickup, completed), price re-checks
  on past hunts, and honest history.
- **Management workspace** (allowlisted emails): live health vitals, key
  vault, queue/anti-ban panels, user administration - and an owner-only AI
  Operations Center with a real learning loop.

## 🔐 How the messaging actually works (read this)

- **The default lane sends from the traveller's OWN WhatsApp number**, linked
  by QR/pairing code through Evolution API (Baileys - an unofficial WhatsApp
  Web protocol). This keeps bargains authentic, and it carries a REAL,
  disclosed risk: WhatsApp can restrict or permanently ban a number used for
  automation. Every user accepts this risk explicitly at signup; human-pace
  limits, daily caps and anti-pattern controls reduce - but cannot eliminate -
  it. See the in-app Terms.
- **An optional company-WABA lane** (official Meta Cloud API) exists for
  first contact with **opted-in partner shops**: the first template withholds
  the traveller's number until the shop replies YES. It is off by default and
  flipped from the management Architecture card.
- Shops can opt out once, fleet-wide: a suppression is honored by every lane.
- **Secrets never reach the browser.** Keys live in `process.env` or the
  AES-encrypted Key Vault; the admin panel shows masked fingerprints only.
  `.env*` is gitignored - no credentials are committed to this repo.
- Privacy is machinery, not prose: in-app data export and account erasure
  driven by a registered table walk, nightly retention with de-identification,
  and opt-in (default-off) analytics/insights consents.

## 🚀 Quick start (local)

```bash
npm install
cp .env.example .env.local   # optional - app runs in demo mode without it
npm run dev                  # http://localhost:3000
```

Sign in from `/login`. To unlock the management workspace, sign in with an
email listed in `ADMIN_EMAILS` (default: `kaspidoron@gmail.com`, the owner).

## ☁️ Deploy to Google Cloud

1. Push this repo to GitHub (already done if you're reading this there).
2. Build the Next.js frontend into a **Cloud Run** service from the root
   `Dockerfile` (it emits a standalone image, listens on `$PORT`).
3. Run all three SQL files against your Supabase project:
   `supabase/schema.sql`, `supabase/perf-indexes.sql`,
   `supabase/retention.sql`.
4. Provision the gateway + workers + Redis VM with `./infra/gcp/deploy.sh`;
   Evolution API runs on its own host with its OWN database (never the app's
   Supabase project).
5. Full step-by-step: [`GUIDE.md`](./GUIDE.md) and
   [`infra/gcp/README.md`](./infra/gcp/README.md).

> The app is functional with zero env vars (demo mode). Add LLM / Supabase /
> WhatsApp keys to switch on live AI, persistence, and real messaging.

## ⚙️ Environment variables

See [`.env.example`](./.env.example). Bootstrap secrets are env-only
(`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SESSION_SECRET`,
`ADMIN_EMAILS`, `APP_DOMAIN`); everything else can be pasted at runtime in
Admin → Keys and survives redeploys encrypted.

| Group | Vars | Effect when set |
| --- | --- | --- |
| LLM | `GROQ_TOKEN`, `GEMINI_TOKEN`, `OPENROUTER_TOKEN`, `CEREBRAS_TOKEN`, … | Live AI negotiation ladder |
| Data | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, … | Durable accounts, threads, vault |
| WhatsApp | `EVOLUTION_HOSTS`, `AUTHENTICATION_API_KEY` (Evolution) / WABA keys | Live messaging lanes |
| Auth | `ADMIN_EMAILS`, `SESSION_SECRET`, `WEBHOOK_TOKEN_SALT` | Roles, signed sessions, token rotation |
| Scale | `REDIS_URL` | Fleet-wide rate limits + AI RPM budgets |

> **Rotate any key that has ever been shared in plaintext** (chat, email,
> screenshots) before using it in production.

## 🧱 Tech

Next.js 14 (App Router) · TypeScript · Tailwind CSS · React-Leaflet /
OpenStreetMap · Supabase (PostgREST, service-role only, RLS everywhere) ·
Evolution API v2 · a provider-neutral LLM ladder.

## 📁 Structure

```
src/
  app/            routes + API handlers (outreach, activity, deals, webhooks, admin, auth, profile)
  components/     UI (VendorCard, MapView, Tracker, Filters, BookingSheet, …)
  lib/            spte (primary engine), graph (failover), wa (transport+guard),
                  waba, funnel, privacy, ops, ai providers, session, config
supabase/         schema.sql · perf-indexes.sql · retention.sql
```

See [`CLAUDE.md`](./CLAUDE.md) for the working architecture map.

---

Made for travellers who'd rather negotiate from the pool than the front desk.
