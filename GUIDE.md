# WheelDeal - simple setup guide

Plain-English steps. You do not need to touch code. The app already works with
nothing configured (demo mode); each section below switches on a real feature.

---

## 1. Deploy the app (get your live link)

The app deploys to **Google Cloud** only. The Next.js frontend runs as a
**Cloud Run** service (built from the root `Dockerfile`); the gateway + workers
+ Redis run on a small GCE VM. Follow the runbook in
[`infra/gcp/README.md`](./infra/gcp/README.md):

1. Create the bootstrap secret in **GCP Secret Manager** (Supabase keys,
   `SESSION_SECRET`, `ADMIN_EMAILS`, `APP_DOMAIN`).
2. Deploy the web image to Cloud Run from the root `Dockerfile`.
3. Provision the gateway/workers VM with `./infra/gcp/deploy.sh`.
4. You get a live URL like `https://rental-app-xxxx.run.app`.

That URL is your app. It works immediately in demo mode.

> Want it to feel like an App Store app (no browser bar)? On your phone open the
> link, tap the **Share** icon, then **Add to Home Screen**. It launches
> full-screen with the WheelDeal icon.

---

## 2. Turn on saving of keys (Supabase - do this once)

This lets you paste all other keys inside the app and have them stick.

1. Go to **supabase.com -> New project** (free). Pick any name/password.
2. Open **Project Settings -> API**. Copy these 3 values:
   - **Project URL**
   - **service_role** secret key
   - **anon** public key
3. In **GCP Secret Manager** (and your Cloud Run service env) add:
   | Name | Value |
   |---|---|
   | `SUPABASE_URL` | the Project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | the service_role key |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the anon key |
   | `SESSION_SECRET` | a long random string (see below) |
   | `OWNER_EMAIL` | `kaspidoron@gmail.com` (the owner - full control) |
   | `ADMIN_EMAILS` | `kaspidoron@gmail.com` |
   | `OWNER_BOOTSTRAP_PASSWORD` | a one-time secret (8+ characters) for the owner's FIRST sign-in on a fresh database; you are asked to change it right away, and it can be removed afterwards. There is no default - without it the owner cannot be created |
4. Make a `SESSION_SECRET`: on a Mac/Linux terminal run `openssl rand -hex 32`
   and paste the result. (Set it once and never change it - it protects your
   saved keys.)
5. In Supabase, open **SQL Editor**, paste the contents of
   `supabase/schema.sql` from this repo, and click **Run**.
6. In the same SQL Editor, run `supabase/retention.sql`. **This one is not
   optional and it is not only about disk space.** It creates the nightly prune
   job *and* revokes the `prune_old_rows` grant that PostgreSQL hands to
   PUBLIC by default - without it, anyone holding your public anon key (it ships
   inside every browser) can call `/rest/v1/rpc/prune_old_rows` with
   `retain_days: 0` and delete your operational history. The file is idempotent;
   re-run it any time. Verify from **Admin -> Keys -> Connection tests ->
   "Check anon RPC lockdown"**, which asks your real database. The health
   panel's **Retention tile stays red until the nightly prune has actually
   run once** - that is the tile telling the truth, not a bug.
7. Still in the SQL Editor, run `supabase/perf-indexes.sql` once. The app
   works without it, but every hot-path query (threads, outbox, messages by
   number) table-scans - at real usage that is the difference between a
   1-second and a 20-second screen.
8. **Optional, and safe to skip:** turn on semantic retrieval. In Supabase go
   to **Database -> Extensions**, search for `vector`, enable it, then re-run
   `supabase/schema.sql`. That creates the `corpus_embeddings` sidecar, and the
   app switches itself on within 60 seconds **with no redeploy** (the schema
   probe caches a "missing" answer for only a minute). Skipping this costs you
   nothing: the whole block sits inside an extension guard, so running
   `schema.sql` without pgvector prints one notice and the app behaves exactly
   as it does today. Watch it fill on **Admin -> Health -> corpus**: `queued`
   climbs as shops reply, then falls as the cron embeds them.
9. Redeploy the Cloud Run web service so the new variables load.

Now sign in to your live app with `kaspidoron@gmail.com` and the
`OWNER_BOOTSTRAP_PASSWORD` you set (the owner signs in with email + that
one-time secret - no phone or terms needed - and is asked to choose a real
password straight away), open **Admin -> Keys**, and you'll see a green
"Persistence is on" banner. Anything you paste here is saved securely.

---

## 3. Turn on the real map data (Google Maps - highly recommended)

This switches the app from demo vendors to REAL rental places, precise
addresses, and real Google reviews.

1. Go to **console.cloud.google.com** -> create a project (free).
2. Open **APIs & Services -> Library** and enable these 3 APIs:
   - **Places API**
   - **Geocoding API**
   - (optional) **Maps JavaScript API**
3. Open **APIs & Services -> Credentials -> Create credentials -> API key**.
   Copy the key.
4. Google asks for a billing card, but gives a large free monthly usage credit -
   normal app usage stays free.
5. In your app: **Admin -> Keys -> Google Maps API Key** -> paste -> Apply.

Done - searches now return real rental businesses near the hotel, with photos,
open-now status, phone-based WhatsApp links and live Google reviews.

**The map TILES are separate, and need nothing.** The Google Maps key above is
used server-side for Places, Geocoding and photos; it never reaches the browser
and it does not draw the map. The basemap under the pins is keyless
OpenStreetMap, so there is nothing to sign up for and nothing that can expire.

If you want nicer cartography (the Google-Maps-like Voyager style the app used
to ship), get a free CARTO basemaps key at **carto.com/basemaps/apikey** -
instant, no approval queue - restrict it to your domain in CARTO's dashboard,
and paste it into **Admin -> Keys -> `MAP_TILES_KEY`**. It applies on the next
page load with no redeploy. Any other provider fits through `MAP_TILE_URL` /
`MAP_TILE_URL_DARK` / `MAP_TILE_ATTRIBUTION` without a code change.

These four are deliberately NOT masked in the Keys panel. A map key rides in a
request the browser makes, so anyone can read it in devtools; the protection is
the domain restriction you set at the provider, not secrecy. Masking it would
imply a confidentiality the design cannot deliver.

Two things to avoid: the free tiers at Stadia Maps, MapTiler, Jawg and
Thunderforest all restrict use to non-commercial projects, and WheelDeal sells
subscriptions. And the keyless OpenStreetMap default is best-effort with no
SLA - if map traffic grows a lot, add the CARTO key or budget for a paid tile
plan.

## 3b. Turn on "Continue with Google" sign-in

If the login page says **"Google sign-in is not configured on this server yet -
use email below"**, exactly ONE thing is missing: the client ID. (The app picks
that wording only when the ID is blank; a missing `SESSION_SECRET` says
something else.)

**There is only one key, and no client secret.** WheelDeal uses the Google
Identity Services ID-token flow, not the redirect flow: the browser gets an ID
token and the server verifies it against Google's tokeninfo endpoint. So there
is no client secret to store, no callback route, and **the "Authorized redirect
URIs" box stays EMPTY**. Anything you put there is ignored.

1. In the same Google Cloud project: **APIs & Services -> OAuth consent
   screen** -> **External** -> fill app name, user support email and developer
   contact -> Save. Add your Privacy Policy and Terms URLs (the app serves
   both) so you can publish.
2. **Publishing status is the trap.** External + **Testing** means only emails
   you list under **Test users** can sign in (100 max), and their sessions
   expire after 7 days. Either add every tester there, or click **PUBLISH APP**.
   Publishing is safe here: the app requests only `openid`, `email` and
   `profile`, which are non-sensitive, so **no Google verification review is
   required**.
3. **Credentials -> Create credentials -> OAuth client ID -> Web application**.
4. Under **Authorized JavaScript origins** add EVERY origin the login page is
   served from - scheme included, no trailing slash, no path:
   - your live domain (e.g. `https://wheeldeal.pro`)
   - your `APP_DOMAIN` value, if different
   - the raw Cloud Run URL, if you ever sign in on it
   - `http://localhost:3000` for local development
5. Leave **Authorized redirect URIs** empty (see above).
6. Copy the **Client ID** (ends with `.apps.googleusercontent.com`). **Ignore
   the client secret** - this app never uses it.
7. In your app: **Admin -> Keys -> Google OAuth Client ID** -> paste -> Apply.
   It is stored encrypted in the Key Vault and takes effect with **no
   redeploy**. Do not also set an env var: a stale build-time
   `NEXT_PUBLIC_GOOGLE_CLIENT_ID` is how the two halves end up disagreeing.
8. Press **Test** on that row. It format-checks only - the real check happens on
   a live sign-in, and the button says so.

**Wait about a minute** before looking. Two 30-second caches have to expire (the
Key Vault, and the auth-methods response). Then open `/login` in a fresh private
tab: the "not configured" line should be gone and an **OR** divider should
appear above the Google pill. The divider is derived from the button, so seeing
it means the client ID resolved.

Two failures and what each one means:

- **The button paints but nothing happens, then "Google sign-in is not enabled
  for this domain yet"** - the page's origin is missing from **Authorized
  JavaScript origins** (step 4). This is the classic new-domain miss; the app
  detects it and says so rather than sitting there silently.
- **"Google credential audience mismatch"** - the client ID the button rendered
  with is not the one the server holds. Usually two different OAuth clients, or
  a stale `NEXT_PUBLIC_GOOGLE_CLIENT_ID` baked into the build. Make them
  identical.

**During the private beta, Google is a credential and not an invitation.** The
allowlist gate runs BEFORE any account is created, so a tester signing in with
Google whose email is not on the list gets a 403 and *"WheelDeal is in a
private, invite-only beta..."*, and no user row is created. Add them in
**Admin -> "Private beta - invite list"** first - see
[the tester runbook](./RUNBOOK.md#adding-a-beta-tester).

---

## 4. Turn on the AI agents

You can paste these in **Admin -> Keys** (recommended) or add them in GCP Secret Manager.

- `GROQ_TOKEN`, `GEMINI_TOKEN`, `OPENROUTER_TOKEN`, `CEREBRAS_TOKEN` - your AI
  gateway keys (use fresh ones; rotate any that were shared in chat).
- `AI_PROVIDER` - which to prefer, e.g. `groq`.

Without these the app still runs using built-in smart fallbacks.

---

## 5. Turn on WhatsApp (official Meta Cloud API)

This is optional. Without it, the app opens normal `wa.me` chat links instead.

1. Go to **developers.facebook.com -> My Apps -> Create App -> Business**.
2. Add the **WhatsApp** product. In the WhatsApp setup page you'll get:
   - a **Phone number ID**
   - a **temporary access token** (later create a permanent one)
3. In your app, **Admin -> Keys**, paste:
   - `WHATSAPP_PHONE_NUMBER_ID`
   - `WHATSAPP_ACCESS_TOKEN`
   - `WHATSAPP_VERIFY_TOKEN` - make up any phrase, e.g. `wheeldeal-verify-9f2`.
4. Set up the webhook so vendor replies come back:
   - In Meta's WhatsApp **Configuration -> Webhooks**, set **Callback URL** to
     `https://YOUR-APP-URL/api/webhooks/whatsapp`
   - **Verify token**: the exact same phrase you used for `WHATSAPP_VERIFY_TOKEN`.
   - Click **Verify and save**, then **Subscribe** to `messages`.
5. Only message vendors who have opted in. Agents identify themselves as
   automated assistants (this keeps you compliant and avoids bans).

---

## 6. Turn on feedback emails (Resend)

So real bug reports from users land in your inbox (spam is filtered out by AI).

1. Go to **resend.com** (free), create an API key.
2. In **Admin -> Keys**, paste:
   - `RESEND_API_KEY`
   - `FEEDBACK_FROM_EMAIL` - e.g. `WheelDeal <feedback@yourdomain.com>` (or leave
     blank to use Resend's test sender while trying it out).

Users tap the chat button in the bottom bar, pick a category, describe the issue
(optionally let AI write it), attach up to 5 screenshots, and submit. Only
genuine bugs get emailed to `ADMIN_EMAILS`; everything is also logged in Supabase.

---

## 7. Turn on payments (PayPal Subscriptions)

Visible only to management (Admin -> Billing). PayPal has no merchant-approval
gate, is free ($0/month), and pays out to Israeli bank accounts.

1. At **developer.paypal.com -> Apps & Credentials** (toggle **Live**), create a
   REST app and copy its **Client ID** + **Secret**.
2. At **paypal.com -> Pay & Get Paid -> Subscriptions -> Plans**, create two
   subscription plans (Pro and Ultra, billed every 3 months, priced in ILS to
   match the app) and copy each **Plan ID** (starts with `P-`).
3. Back in the developer app, add a **Webhook** with URL
   `https://<your-domain>/api/webhooks/paypal`, subscribe to the events
   `BILLING.SUBSCRIPTION.ACTIVATED / .CANCELLED / .EXPIRED / .SUSPENDED /
   .RE-ACTIVATED` (+ `PAYMENT.SALE.COMPLETED`), and copy the **Webhook ID**.
4. In **Admin -> Keys**, paste `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`,
   `PAYPAL_PLAN_PRO`, `PAYPAL_PLAN_ULTRA`, `PAYPAL_WEBHOOK_ID` (and
   `PAYPAL_ENV=sandbox` while testing). Use **Admin -> Keys -> Test** to verify.
5. Open **Admin -> Billing** and click **Subscribe** on a plan - it opens a real
   PayPal approval page; the plan is granted server-side from the signed webhook.

### 7a. Apple Pay / Google Pay (one-tap wallets)

WheelDeal sends buyers to **PayPal's own hosted approval page**, so the wallet
buttons a buyer sees there are controlled by your **PayPal Business account
settings, not by app code** - enabling them is a dashboard toggle, not a deploy.

**Track A - enable on the hosted page (no code, do this first):**

1. In your **PayPal Business** dashboard, open **Account Settings -> Payment
   preferences / Wallet & Alternative payment methods** and enable **Apple Pay**
   and **Google Pay** as funding sources for your Live app.
2. Approved wallet-funded subscriptions fire the **same** webhook events
   (`BILLING.SUBSCRIPTION.ACTIVATED`, `PAYMENT.SALE.COMPLETED`), so the grant
   path needs **zero changes** - a wallet payment is granted exactly like a card.

**Owner verification required (facts the app cannot check for you):**

- Confirm your PayPal Business account is **Israel-registered** and that PayPal
  currently offers Apple Pay / Google Pay as funding sources for Israeli
  merchants on the **Subscriptions** (recurring) approval flow - wallet support
  for recurring billing varies by region and is a known inconsistency in
  PayPal's own docs. If Subscriptions don't support wallets in your region,
  Track A alone won't show them; use Track B or keep card checkout.

**Track B - embedded wallet buttons on the app's own page (optional, later):**
Only if you want an Apple Pay / Google Pay button rendered **on WheelDeal's own
Upgrade sheet** (not PayPal's page). This needs real code + owner steps:
load the PayPal JS SDK with `components=buttons,applepay,googlepay` using a new,
deliberately-public `NEXT_PUBLIC_PAYPAL_CLIENT_ID` (client IDs are non-secret by
design), and serve the Apple-issued domain-association file at
`/.well-known/apple-developer-merchantid-domain-association` from your Live
domain (obtain it via PayPal's Apple Pay onboarding - do **not** invent one).
Adoption is measurable via the new `billing_events.funding_source` column.

---

## 8. Turn on ads for the free tier (Google AdSense)

Paid plans are 100% ad-free; the free tier shows one banner in three places
(below the results list, further down the list, and on the profile page). The
space is reserved whether or not an ad fills it, so turning this on never
shifts the layout.

**Two ids, and the second one is the one people forget.** The Publisher ID
says whose account this is. The **Ad Unit ID** says which unit to serve into.
Without the unit id nothing can ever fill, and the banner looks exactly like a
site still awaiting review - so if the placeholder says "no ad unit configured
yet", this is the step you have not done.

1. **Publisher ID** - already built in: `ca-pub-4965894186804157`. It is emitted
   as the `google-adsense-account` meta tag and used to load the SDK, so there
   is nothing to paste unless you move accounts (then set `ADSENSE_CLIENT` in
   Admin -> Keys).
2. **ads.txt** - already served at `https://<your-domain>/ads.txt` as
   `google.com, pub-4965894186804157, DIRECT, f08c47fec0942fa0`. In AdSense ->
   Sites, confirm it is found. (This file is how Google knows you are authorised
   to sell inventory on the domain; an unfound ads.txt suppresses fill.)
3. **Add the site** - AdSense -> Sites -> Add site -> `wheeldeal.pro`, then
   request review. The verification snippet is already on every page.
4. **Create ONE ad unit** - AdSense -> Ads -> By ad unit -> **Display ads**,
   responsive, any name. Copy the numeric **Ad Unit ID** it gives you (it is the
   `data-ad-slot` value in the sample code, not the `ca-pub-` line).
5. **Paste it** - Admin -> Keys -> `ADSENSE_SLOT`. It applies immediately, no
   redeploy. All three banners use the same unit.

Nothing here is required for the app to run: with no unit configured the banner
renders a labelled placeholder and everything else works normally.

---

## 9. First deploy after a long gap - the order that matters

Run this whenever the live site is several commits behind. Doing step 2 after
the merge instead of before is the one sequence that can half-land.

1. **Snapshot the database** (Supabase -> Database -> Backups). Re-running
   `schema.sql` deletes duplicate *pending* `wa_outbox` rows and recreates an
   index - expected, but it touches data, so do it at a quiet moment.
2. **Run `supabase/schema.sql`** in the Supabase SQL editor, whole file. There
   is no in-app way to do this; PostgREST cannot run DDL. **Then run
   `supabase/retention.sql`** - it re-applies the `prune_old_rows` lockdown
   (revoked from `anon`/`authenticated`, granted to `service_role`) as part of
   creating the function, and raises an exception rather than finishing quietly
   if the revoke did not take.
3. **Check the backlog before you wake the drain:**
   `select count(*), min(not_before) from wa_outbox where not_before <= now();`
   Anything older than a few hours would have been sent the moment the new
   scheduler starts. The app now bins rows older than 6h rather than sending
   them, but it is worth knowing what you are about to discard.
4. **Confirm the repo secret `APP_DOMAIN` or `CLOUD_RUN_URL` exists** - without
   one the GitHub Actions heartbeat exits green and pings nothing.
5. **Merge to master.** The deploy job runs only from `main` / `master`, and
   GitHub `schedule:` triggers fire only from the default branch - which is why
   a fix sitting on a feature branch is not live and its heartbeat never runs.
6. **Verify from your phone**, Admin -> the deploy-info card:
   - **Build** shows the commit you just merged (not "unknown").
   - **Schema** - all probes present. These can genuinely go red now.
   - **Heartbeat** - "live", under 3 minutes old, within ~5 minutes of deploy.
7. **If the heartbeat still says "never" after 5 minutes**, the deploy's
   scheduler step could not create the job. It prints an ACTION REQUIRED block
   with the exact command. Grant the deploying service account
   `roles/cloudscheduler.admin` and `roles/serviceusage.serviceUsageAdmin` and
   re-run the deploy, or run the printed `gcloud scheduler jobs create http`
   yourself.
8. **Sign in, accept the terms modal, then hard-reload.** It must not come back.
   If it does, `app_users.terms_version` is not being written - re-check step 2.

**Rolling back** is a traffic switch, not a git operation:
`gcloud run services update-traffic $SERVICE --to-revisions=<previous>=100
--region $REGION`. The schema additions are safe to leave in place.

---

## Quick reference: where each key goes

- **GCP Secret Manager env vars (once):** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SESSION_SECRET`, `OWNER_EMAIL`,
  `ADMIN_EMAILS`.
- **Admin -> Keys (in-app, any time):** `GOOGLE_MAPS_API_KEY`,
  `GOOGLE_OAUTH_CLIENT_ID`, all `GROQ/GEMINI/OPENROUTER/CEREBRAS` tokens,
  `AI_PROVIDER`, all `WHATSAPP_*`, `RESEND_API_KEY`, `FEEDBACK_FROM_EMAIL`,
  `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_PLAN_PRO`,
  `PAYPAL_PLAN_ULTRA`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_ENV`, `ADSENSE_SLOT`
  (and `ADSENSE_CLIENT` only if you move AdSense accounts).

Always use freshly rotated keys - never ones that were shared in plain text.

## v4 additions (July 2026)

- Payments: PayPal Subscriptions is the provider (no merchant-approval gate,
  $0/month, pays out to Israeli bank accounts). Create a REST app +  two
  Billing Plans (Pro / Ultra, billed every 3 months) + a Webhook, then paste
  PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_PLAN_PRO, PAYPAL_PLAN_ULTRA and
  PAYPAL_WEBHOOK_ID in Admin -> Keys. Webhook URL:
  https://<your-domain>/api/webhooks/paypal (events: BILLING.SUBSCRIPTION.* +
  PAYMENT.SALE.COMPLETED). See section 7.
- Personal WhatsApp: deploy Evolution API (self-hosted, free - see the
  step-by-step in the project chat/README), then paste EVOLUTION_API_URL and
  EVOLUTION_API_KEY in Admin -> Keys. Users connect their own number from
  Profile -> Your WhatsApp (QR scan). Strict anti-ban rate limits are
  enforced (15/hour, 60/day, 20s gap).
- Diagnostics: Admin -> Keys -> "Test Supabase" and "Test Google key" fire
  real requests and print the exact error + fix.
- Feedback: readable with zero setup in Admin -> Feedback (Supabase-backed).
  Resend email delivery stays optional.
- AdSense: wired out of the box (site tag, account meta tag and a static
  `ads.txt`, all unconditional so Google's anonymous reviewer sees them).
  Free-tier pages show labelled ad slots (placeholder until Google approves the
  site); paid plans are ad-free. Set ADSENSE_CLIENT only to point the app at a
  DIFFERENT AdSense account. Approval steps: `docs/LAUNCH-wheeldeal.pro.md`.

## v10: Multi-host WhatsApp pool - Oracle Always Free, no user left behind

WhatsApp is the heart of WheelDeal. A single free host sleeps after ~15 min and
drops the connection - bad. The fix is a POOL: run the SAME Evolution API server
on 8+ free services, all pointed at the SAME Supabase Postgres database. Because
every WhatsApp (Baileys) credential lives in that shared database, ANY host can
resume ANY user's session. If one host is asleep or slow, the app instantly
fails the user over to a healthy host - with NO re-scanning, NO re-linking.

### How the app spreads users (built in - nothing to configure)

- On every send/connect the app health-checks all hosts in parallel (cached 15s).
- Each user "sticks" to one host (saved in `wa_sessions.host_url`) so their
  session stays warm; if that host is down, they migrate to the least-loaded
  healthy host automatically.
- A per-host cap (Admin -> Keys -> `EVOLUTION_MAX_PER_HOST`, default **25**)
  stops any one server from being overloaded. At the cap the app **REFUSES** a
  new link with an honest "at capacity" message rather than placing the
  traveller on a full box - with several hosts configured, new users land on
  emptier ones first. The refusal is on the LINK path only: sends, media and
  connection reads to an already-placed user are never affected by capacity.
- Owner page -> Keys -> "WhatsApp host pool" shows a live green/red dot and the
  user count for every host. Tap "Test API" on `EVOLUTION_HOSTS` to ping them all.

### The ONE shared config every host needs (identical on all 8)

Set these environment variables the SAME on every host. The shared database +
shared API key is what makes failover seamless:

```
AUTHENTICATION_API_KEY   = <pick one long random string, SAME on all hosts>
DATABASE_ENABLED         = true
DATABASE_PROVIDER        = postgresql
DATABASE_CONNECTION_URI  = <a DEDICATED Evolution Postgres - NOT the app's Supabase>
DATABASE_SAVE_DATA_INSTANCE     = true
DATABASE_SAVE_DATA_NEW_MESSAGE  = true
DATABASE_SAVE_DATA_MESSAGE_UPDATE = false
DATABASE_SAVE_DATA_CONTACTS     = false
DATABASE_SAVE_DATA_CHATS        = true
CACHE_LOCAL_ENABLED      = true
CACHE_REDIS_ENABLED      = false
CONFIG_SESSION_PHONE_CLIENT = Mac OS
CONFIG_SESSION_PHONE_NAME   = Chrome
```

> **PRIVACY - do NOT point `DATABASE_CONNECTION_URI` at the app's Supabase.**
> Evolution's Baileys layer persists to whatever DB you give it, and a linked
> phone receives EVERY message the traveller gets - family, work, banking OTPs -
> not only the rental-shop threads. Two hard rules: (1) use a **dedicated**
> Evolution Postgres (the `wd-evo-db` in `render.yaml` is exactly this), never
> the app's Supabase - co-locating puts those private tables in a schema with no
> RLS, readable via the anon API key; (2) `SAVE_DATA_NEW_MESSAGE`/`CHATS` stay
> **true** (owner report 8) because the missed-reply recovery sweep reads a
> 10-row tail per chat via `/chat/findMessages` - and that endpoint serves FROM
> this store, so turning it off silently breaks the rescue of shop replies the
> webhook lost. The price is a transient copy of every message on the linked
> number (personal chats included), which is why the **7-day prune cron is
> MANDATORY on every host** (`wd-evo-prune` on Render, `deploy/prune` on fleet
> lanes) and the Privacy Policy discloses the transient store. `CONTACTS` and
> `MESSAGE_UPDATE` stay false - nothing reads them. `INSTANCE` stays true:
> that is the Baileys auth state (the link itself), not message content.

Docker image for every host: `evoapicloud/evolution-api:v2.3.7` (newest stable v2 is
`:v2.2.3`), internal port `8080`. Enter it WITHOUT a `docker.io/` prefix - Render
(and some others) treat `docker.io/...` as a private registry and error with "No
public image found". Just type `evoapicloud/evolution-api:v2.3.7`.

Where to get `DATABASE_CONNECTION_URI`: use a **dedicated** Postgres for
Evolution - the `wd-evo-db` service in `render.yaml` is provisioned for exactly
this, and its own connection string is what goes here. **Do NOT use the app's
Supabase connection string** (see the privacy box above). If you run Evolution
elsewhere, point it at any Postgres you control that is separate from the app
database; the connection string looks like:
`postgresql://user:[YOUR-PASSWORD]@host:5432/postgres`
Replace `[YOUR-PASSWORD]` with that database's password (URL-encode any
special characters, e.g. `@` -> `%40`). No `?pgbouncer=true` needed on 5432 -
that flag is only for the 6543 transaction port. Paste the SAME URI on every host.

### The honest 2026 reality on "free"

Most container hosts have killed their no-card free tiers (Koyeb, Railway) or now
require a card even at $0 (Fly, Northflank, Cloud Run). The ONE platform that
still gives real, always-on, never-sleeps servers for free FOREVER is **Oracle
Cloud Always Free** - and it gives you SEVERAL: up to 4 ARM cores + 24 GB RAM
(splittable into multiple VMs) PLUS 2 AMD micro VMs. So your whole pool can be
Oracle: 3-4 always-on hosts, $0/month, none sleeping. Oracle asks for a card ONCE
for identity - it is never charged while you stay on "Always Free eligible" shapes.

Everything below is doable 100% from an iPhone browser - no CLI, no Mac. A
cloud-init startup script installs Docker and launches Evolution automatically on
first boot, so you never open a terminal.

### Deploy Oracle Always Free VMs (iPhone, no terminal)

Startup script to paste in the create-VM form (set YOUR-DB-PASSWORD; keep the same
AUTHENTICATION_API_KEY on every VM):

Swap lines are included so the small 1 GB AMD micro shape does not OOM-kill
Evolution; they are harmless on the bigger ARM shape too, so use ONE script for
every VM:

```
#cloud-config
package_update: true
packages:
  - docker.io
  - iptables-persistent
runcmd:
  - bash -c 'fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048'
  - chmod 600 /swapfile
  - mkswap /swapfile
  - swapon /swapfile
  - bash -c 'echo "/swapfile none swap sw 0 0" >> /etc/fstab'
  - systemctl enable --now docker
  - iptables -I INPUT 6 -m state --state NEW -p tcp --dport 8080 -j ACCEPT
  - netfilter-persistent save
  - sleep 5
  - docker run -d --name evolution --restart always -p 8080:8080 -e AUTHENTICATION_API_KEY="wd-pool-KEY" -e DATABASE_ENABLED="true" -e DATABASE_PROVIDER="postgresql" -e DATABASE_CONNECTION_URI="postgresql://user:YOUR-DB-PASSWORD@your-dedicated-evo-db-host:5432/postgres" -e DATABASE_SAVE_DATA_INSTANCE="true" -e DATABASE_SAVE_DATA_NEW_MESSAGE="false" -e DATABASE_SAVE_DATA_MESSAGE_UPDATE="false" -e DATABASE_SAVE_DATA_CONTACTS="false" -e DATABASE_SAVE_DATA_CHATS="false" -e CACHE_LOCAL_ENABLED="true" -e CACHE_REDIS_ENABLED="false" -e CONFIG_SESSION_PHONE_CLIENT="Mac OS" -e CONFIG_SESSION_PHONE_NAME="Chrome" evoapicloud/evolution-api:v2.3.7
```

Shape choice (smooth WhatsApp, $0): the ARM VM.Standard.A1.Flex (up to 4 OCPU +
24 GB total, splittable) is the real powerhouse and is free. If it shows "Out of
host capacity" (common in small regions), either:
- Bridge now on TWO AMD VM.Standard.E2.1.Micro VMs (1 GB each, always available,
  both Always Free) with the swap script above - the pool fails over between them.
- Then land ARM in the background: ask for a SMALL ARM first (1 OCPU / 6 GB - more
  likely to have capacity), retry at off-peak hours, or use "Save as stack" in the
  create form and re-tap Apply in Resource Manager (one-tap retry) until it
  succeeds. Add the ARM to the pool when it comes up; keep the micros as backups.
The shared Supabase DB means adding/removing hosts never makes a user re-link.

1. **Account:** oracle.com/cloud/free -> Start for free -> verify email -> add card
   (identity only, never charged on Always Free).
2. **Create instance:** Menu -> Compute -> Instances -> Create instance. Name
   `wd-wa-1`.
3. **Image and shape -> Edit:** Image = Canonical Ubuntu; Shape = Change shape ->
   Ampere -> VM.Standard.A1.Flex (2 OCPU / 12 GB, shows "Always Free"). If you hit
   "Out of host capacity", try another Availability Domain, or use
   VM.Standard.E2.1.Micro (AMD, always available, also Always Free).
4. **Networking:** keep defaults; Assign public IPv4 = Yes.
5. **SSH keys:** "Generate a key pair for me" -> Save private key (to Files; you
   won't need it - cloud-init does everything).
6. **Show advanced options -> Management -> Initialization script -> Paste
   cloud-init script** -> paste the block above -> Create.
7. **Open port 8080:** instance page -> Virtual cloud network / subnet -> Security
   Lists -> Default Security List -> Add Ingress Rules -> Source `0.0.0.0/0`,
   Protocol TCP, Destination Port `8080` -> Add.
8. **Get URL:** copy the Public IPv4. Host = `http://<IP>:8080` (http, port 8080).
   Open it in Safari after ~3-4 min; a small JSON "Welcome to the Evolution API"
   means it's live.
9. **Repeat** for `wd-wa-2`, `wd-wa-3` (Always Free covers several VMs - 4 ARM
   cores + 24 GB total, plus 2 AMD micros). Each VM = one host line.

Note: hosts are `http://` (not https). That is fine - the app calls them
server-side from Cloud Run, so there is no browser mixed-content issue.

"Estimated cost EUR1.85/month" scare: Oracle's cost estimator IGNORES the free
tier (it literally says "does not reflect any tier unit pricing") and prices the
boot volume at pay-as-you-go rates. On an Always Free account the A1.Flex shape
is EUR0 and the boot volume is covered by the 200 GB free storage allowance, so
the real cost is EUR0. To guarantee it: keep the account as "Always Free" (do NOT
upgrade to Pay As You Go - a Free Tier account cannot be billed, it just stops
resources if you exceed a limit), and leave the boot volume at the ~47 GB default.

### Wire the pool into WheelDeal

1. Owner page -> Keys -> `EVOLUTION_HOSTS` (multi-line box). One `url|apikey` per
   line, same key everywhere:

   ```
   http://140.238.10.11:8080|wd-pool-KEY
   http://140.238.10.12:8080|wd-pool-KEY
   http://140.238.10.13:8080|wd-pool-KEY
   ```
   Leave single-host `EVOLUTION_API_URL`/`EVOLUTION_API_KEY` empty. Tap "Apply
   pool", then "Test API" to confirm `N/N host(s) healthy`.

2. Run once in Supabase SQL editor:
   `alter table public.wa_sessions add column if not exists host_url text;`

3. (Optional) `EVOLUTION_MAX_PER_HOST` - paired users per host (default
   **25**). With more than one host, new users spill to the emptiest; with one
   host, the next link is REFUSED rather than overfilling the box. Do not raise
   it above 25 on a 512MB Render `starter` - see SCALING.md.

4. The **WhatsApp host pool** panel (same Keys screen) shows every VM live:
   green/red dot, user count, and the reason if one is ever down. Add/remove hosts
   by editing the box. Keep-awake cron is optional on Oracle (it never sleeps),
   but leaving `/api/wa/ping` on cron-job.org does no harm.

### Reality check (honest)

Oracle Always Free VMs never sleep and you can run several for $0, so this is a
genuinely free, always-on, self-healing pool - the shared Supabase DB means any
VM can resume any user's session, so even a reboot never strands a traveller. If
a truly free provider ever re-appears with no card, add it to the pool the same
way (public image, port 8080, shared env + DB). A single ~$7/mo box running the
same image is always a drop-in if you want zero setup.

---

## Digraph negotiation engine (v2) - what changed

The AI reply pipeline is now a true **directed graph** of specialized agents
(sense -> Negotiation Director -> act -> tail gates), not a fixed ladder. It is
fully editable, testable and replayable from **Admin -> Agents (Pipeline
Studio)**.

**After deploying this build, run `supabase/schema.sql` once more** - it adds
the engine's tables/columns (idempotent `create table if not exists` /
`add column if not exists`, safe to re-run):
`negotiation_threads`, `graph_wakeups`, `agent_scores`,
`agent_traces.node_id/edge_id`, `offers.presentable/fulfillment`, and the
`app_users` consent columns (`wa_risk_accepted_at`,
`ai_responsibility_accepted_at`). Everything degrades gracefully before the
migration runs (the code retries writes without the new columns), but the
Studio replay, scores and deal-completeness chips need the tables.

**Config knobs (Admin -> Agents -> Pipeline Studio):**
- Add/rewire nodes and edges, edit each agent's instructions, add custom LLM
  nodes - all hot-applied, no redeploy.
- Settings: max bargain rounds/shop (default 3), strategic-wait cap, judge
  sample rate, warm-emoji tone.
- **Kill switch:** set `GRAPH_ENGINE=off` in Keys to fall back to the legacy
  inline pipeline for one release if needed.

**Voice notes:** shops' WhatsApp voice notes are transcribed with Groq
`whisper-large-v3` (heavy-accent primed) - add a **`GROQ_TOKEN`** in Keys.
Falls back to Gemini audio, then a polite "please type it" reply.

**Testing (Admin -> Agents):**
- *Simulator* - dry-run the real engine on any shop reply / preset scenario and
  see the exact traversed node path.
- *Replay* - real inbound decisions, each replaying its graph path + judge
  scores.
- *Media Lab* - upload a price-table / odometer / vehicle image OR a voice note
  and see exactly what the vision/transcription agent read + the coherence
  verdict.

**Email test (Admin -> Keys):** "Send live test email" fires a real message
through the Gmail -> Brevo -> Resend chain to your own address and reports which
provider handled it + the exact error/fix.

**Location:** the traveller now defaults to "My location" (GPS on load), and
address autocomplete uses Google Places (New) Autocomplete with session tokens.
Keep the `GOOGLE_MAPS_API_KEY` in Keys and enable "Places API (New)".

**Legal:** public `/terms` and `/privacy` pages, three mandatory signup
consents (enforced server-side), and disclaimers across the funnel. Set the real
legal entity name in `OPERATOR_NAME` (`src/lib/legal.ts`) when you have one.

## WhatsApp Business (WABA) go-live - the funded lane

**Nothing here is needed for the beta.** The app ships 100% on Evolution: with
`WABA_ENABLED` unset there is no reachable path to a Business-API send, and
`TRANSPORT_MODE` defaults to `evolution`. This section is the day-you-get-funding
checklist, and it is deliberately paste-and-flip: every value below is a vault
key in **Admin -> Keys**, so none of it needs a redeploy.

**Step 1 - get the two URLs.** Open **Admin -> WABA**. The "Paste these into
Meta" card shows them, resolved from your `APP_DOMAIN`:

- **Callback URL** - `https://<your-domain>/api/webhooks/waba`
- **Template button base** - `https://<your-domain>/h`. The approved template's
  button base must EQUAL this. The card turns red if `WABA_LINK_BASE` does not
  match, because a mismatch is rejected on every send with no other symptom.

**Step 2 - paste the keys** (Admin -> Keys, `messaging` scope):

| Key | What it is |
|---|---|
| `WABA_PROVIDER` | `meta` (direct) or `reseller` |
| `WABA_BASE_URL` | e.g. `https://graph.facebook.com/v20.0`, no trailing slash |
| `WABA_API_KEY` | system-user token |
| `WABA_SENDER_ID` | the phone-number id |
| `WABA_ACCOUNT_ID` | the WhatsApp Business ACCOUNT id - lets the key test verify the template before you send |
| `WABA_TEMPLATE_FIRST_CONTACT` | the approved template's NAME |
| `WABA_TEMPLATE_LANGUAGE` | its LANGUAGE code exactly as Meta lists it (`en`, `en_US`, `th`). A mismatch is error 132001 on every send |
| `WABA_LINK_BASE` | the button base from step 1 |
| `WABA_WEBHOOK_SECRET` | the signing secret - for Meta this is the **app secret** |
| `WABA_VERIFY_TOKEN` | any string you also type into Meta's callback form. Do NOT reuse the app secret: this value travels in a URL and lands in access logs |
| `WABA_TIER_UNIQUE_PER_DAY`, `WABA_QUALITY_RATING` | your live tier and rating - the key test reports drift against Meta |
| `WABA_DAILY_SPEND_CEILING_USD`, `WABA_TEMPLATE_COST_USD` | the spend governor |
| `WABA_AGENCY_COOLDOWN_HOURS`, `WABA_HOLD_TIMEOUT_MINUTES`, `WABA_EXPECTATION_TTL_HOURS` | lane pacing |

**Step 3 - press "Test" on the WABA keys.** The probe checks reachability, tier
and quality drift, AND (with `WABA_ACCOUNT_ID` set) that your template name and
language are actually APPROVED. Fix anything red before going further.

**Step 4 - opt your partner shops in.** A cold first-contact template may only
go to a shop that opted in. Use **Admin -> WABA -> "Opt a partner shop in"**;
a shop that messages your business number opts itself in automatically.

**Step 5 - rehearse.** Set `WABA_ENABLED=on` and leave `WABA_DRY_RUN=on` (its
default). The whole funnel runs and logs the exact wire text without spending a
single template. Watch the console.

**Step 6 - go live.** Turn `WABA_DRY_RUN` off, then set `TRANSPORT_MODE` to
`waba-fallback` (WABA only when the traveller has no Evolution link) or
`waba-first`. Both taps are red on the Architecture card because both start a
live sender.

`WABA_KILL=on` is the emergency stop and halts every company-number send,
first contact and service-window flush alike. Per-thread transport stamps always
win over the flag, so flipping back to `evolution` never reroutes a conversation
mid-flight - it only changes where the NEXT first contact goes. The reply leg is
always the traveller's own wire, in every mode.

`CLOUD_API_ENABLED` is the older, separate Cloud-API sender. It has no dry run
and no governor - leave it off unless you know you want it.

## Setting your domain (one key, everywhere)

The live domain is **`wheeldeal.pro`**, and the code default already matches it
(`SITE_DOMAIN` in `src/lib/site.ts` - the single owner of the site's identity).
Full launch checklist, including PayPal webhook events and the AdSense review:
see `docs/LAUNCH-wheeldeal.pro.md`.

To move to a different domain later:

1. Point the domain at your Cloud Run web service (map a custom domain).
2. In the app: **Admin -> Keys -> "Public app domain"** (`APP_DOMAIN`) - paste
   the full `https://...` URL. Takes effect within ~30 seconds, no redeploy.

That single key now drives the share-preview/SEO URLs (OpenGraph, canonical),
the geocoding fallback identity and the push-notification sender identity.
WhatsApp webhooks and billing redirect URLs need NO action - they derive from
the live request origin automatically.

## Reply alerts (Web Push) - zero setup

Nothing to configure. The first time a signed-in user opens the app, the server
mints its own Web Push (VAPID) keypair and stores it encrypted in the Key Vault
- no terminal, no key generation, no pasting. You can see both keys (masked) in
**Admin -> Keys** under Messaging. Paste your own pair there only if you want to
override the generated one - note that replacing keys disconnects devices that
already subscribed (they re-subscribe on their next visit; dead subscriptions
are pruned automatically).
