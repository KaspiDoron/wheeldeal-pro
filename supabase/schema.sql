-- =============================================================================
-- WheelDeal - Supabase schema
-- =============================================================================
-- Run this once in your Supabase project: SQL Editor → paste → Run.
-- Only the service role (used server-side by the app) touches these tables, so
-- Row Level Security is enabled with NO public policies - the anon key can read
-- nothing here. Secrets are additionally encrypted at the app layer before they
-- are ever written to app_config.
-- =============================================================================

-- ---- Runtime config / Key Vault ---------------------------------------------
-- Stores admin-managed integration secrets (AES-256-GCM encrypted app-side).
create table if not exists public.app_config (
  key         text primary key,
  value       text not null,          -- ciphertext: v1:<iv>:<tag>:<data>
  updated_at  timestamptz not null default now()
);

-- ---- WhatsApp message log ---------------------------------------------------
-- Inbound vendor replies (from the webhook) + outbound agent messages.
create table if not exists public.whatsapp_messages (
  id            bigint generated always as identity primary key,
  wa_message_id text,
  from_number   text,
  to_number     text,
  body          text,
  type          text default 'text',
  direction     text not null check (direction in ('inbound','outbound')),
  raw           jsonb,
  received_at   timestamptz not null default now()
);
create index if not exists whatsapp_messages_received_idx
  on public.whatsapp_messages (received_at desc);
-- Thread lookup: match an inbound vendor reply to the last outbound message we
-- sent that number (powers the fully automatic in-app reply loop).
create index if not exists whatsapp_messages_thread_idx
  on public.whatsapp_messages (to_number, received_at desc);
-- Hot paths at scale: nearly every outbound guard/feed query filters by the
-- sender email stored in raw->>'sender', and the engagement check filters by
-- from_number - without these two, both become sequential scans as the table
-- grows (this is the app's hottest table).
create index if not exists whatsapp_messages_sender_idx
  on public.whatsapp_messages ((raw->>'sender'), received_at desc);
create index if not exists whatsapp_messages_from_idx
  on public.whatsapp_messages (from_number, received_at desc);

-- ---- App users (access control + signup details) -----------------------------
create table if not exists public.app_users (
  email                text primary key,
  phone                text,
  name                 text,
  provider             text default 'email',
  status               text not null default 'active' check (status in ('active','blocked')),
  plan                 text not null default 'free' check (plan in ('free','pro','business')),
  password_hash        text,
  must_change_password boolean default false,
  terms_accepted_at    timestamptz,
  added_at             timestamptz not null default now(),
  last_seen            timestamptz not null default now()
);
-- If you already ran an older schema, run these once:
alter table public.app_users add column if not exists plan text not null default 'free';
alter table public.app_users add column if not exists password_hash text;
alter table public.app_users add column if not exists must_change_password boolean default false;
-- The top tier is now "Ultra" (stored as 'business' for compatibility, but
-- allow both values):
alter table public.app_users drop constraint if exists app_users_plan_check;
alter table public.app_users add constraint app_users_plan_check
  check (plan in ('free','pro','business','ultra'));

-- ---- Auth events (every login/signup is recorded) -----------------------------
create table if not exists public.auth_events (
  id         bigint generated always as identity primary key,
  email      text,
  event      text,
  provider   text,
  created_at timestamptz not null default now()
);

-- ---- Email-ownership verification (pending signups) ----------------------------
-- Holds a hashed 6-digit code + the encrypted pending signup until the user
-- proves they control the email. Rows are deleted on success/expiry.
create table if not exists public.email_verifications (
  email       text primary key,
  code_hash   text not null,
  payload     text,
  expires_at  timestamptz not null,
  sent_at     timestamptz not null default now(),
  created_at  timestamptz not null default now()
);
alter table public.email_verifications enable row level security;

-- ---- Shop response-time samples (first reply speed, for the fast-responder tag)
create table if not exists public.response_times (
  id         bigint generated always as identity primary key,
  phone      text not null,
  ms         bigint not null,
  created_at timestamptz not null default now()
);
alter table public.response_times enable row level security;

-- ---- AI provider usage log -----------------------------------------------------
create table if not exists public.ai_usage (
  id         bigint generated always as identity primary key,
  provider   text,
  tokens     int default 0,
  failed     boolean default false,
  created_at timestamptz not null default now()
);

-- ---- Owner-taught bargaining transcripts ---------------------------------------
create table if not exists public.agent_training (
  id         bigint generated always as identity primary key,
  text       text not null,
  note       text,
  added_by   text,
  source     text default 'text',   -- 'text' | 'photo'
  created_at timestamptz not null default now()
);
-- If you already ran an older schema, run this once:
alter table public.agent_training add column if not exists source text default 'text';

-- ---- Vendor replies (raw) + composed bargain drafts ----------------------------
create table if not exists public.vendor_replies (
  id            bigint generated always as identity primary key,
  user_email    text,
  vendor_id     text,
  vendor_name   text,
  reply_text    text,
  image_count   int default 0,
  found         boolean default false,
  price_per_day numeric,
  matches_spec  boolean default false,
  confidence    text,
  auto          boolean default false,   -- true = ingested by the webhook agent
  created_at    timestamptz not null default now()
);
-- If you already ran an older schema, run these once:
alter table public.vendor_replies add column if not exists auto boolean default false;
-- The traveller-readable ENGLISH GLOSS of a local-language shop reply (W1.5:
-- the gloss is visible everywhere). Stamped best-effort by the agent loop from
-- the SAME translation it writes onto whatsapp_messages.raw.english, so every
-- reply-fed surface (status panel excerpt, activity feed, trips timeline) can
-- show the translation without a JSON join. Null = English reply / pre-gloss row.
alter table public.vendor_replies add column if not exists english_gloss text;
create index if not exists vendor_replies_user_idx
  on public.vendor_replies (user_email, created_at desc);

create table if not exists public.bargain_drafts (
  id         bigint generated always as identity primary key,
  user_email text,
  vendor_id  text,
  tactic     text,
  message    text,
  created_at timestamptz not null default now()
);

-- ---- Search history (agent memory) -------------------------------------------
create table if not exists public.searches (
  id            bigint generated always as identity primary key,
  user_email    text,
  query_text    text,
  lat           double precision,
  lng           double precision,
  radius_km     numeric,
  vehicle_class text,
  source        text,
  results       int,
  -- Snapshot-forward (Trips restore): the exact RFQ this search ran and a
  -- compact list of the shops it discovered, so a past hunt can be re-opened
  -- with its full Find-Deals state instead of only the shops that were messaged.
  rfq           jsonb,
  snapshot      jsonb,
  created_at    timestamptz not null default now()
);
-- Additive for existing deploys (safe to re-run):
alter table public.searches add column if not exists rfq jsonb;
alter table public.searches add column if not exists snapshot jsonb;
-- THE PLACE THE TRAVELLER NAMED, not just its coordinates.
--
-- lat/lng were stored and the LABEL was not, so a restored hunt came back with
-- `origin.label = ""` - and that label is the app's `region`. Everything
-- downstream that takes a region silently fell back to its no-region default:
-- /api/bargain-draft resolves currency to USD (a Thai shop asked for a price in
-- dollars) and drops the market floor entirely, because a floor is only adopted
-- when its currency matches. Re-opening a hunt therefore disarmed the two
-- levers the whole negotiation runs on, with nothing on screen to show it.
alter table public.searches add column if not exists origin_label text;

-- ---- Offers (real + simulated, flagged) ---------------------------------------
create table if not exists public.offers (
  id                 bigint generated always as identity primary key,
  user_email         text,
  vendor_id          text,
  vendor_name        text,
  price_per_day      numeric,
  list_price_per_day numeric,
  currency           text default 'USD',
  round              int default 0,
  simulated          boolean default true,
  verified           boolean default false,
  created_at         timestamptz not null default now()
);

-- ---- Agent learning memory (negotiation playbook) ---------------------------
create table if not exists public.agent_tactics (
  id               text primary key,
  label            text not null,
  script           text not null,
  uses             int  not null default 0,
  wins             int  not null default 0,
  avg_discount_pct numeric not null default 0,
  updated_at       timestamptz not null default now()
);

-- ---- Partner vendor directory (opted-in) ------------------------------------
create table if not exists public.vendors (
  id               text primary key,
  name             text not null,
  lat              double precision not null,
  lng              double precision not null,
  rating           numeric default 4.0,
  reviews          int default 0,
  vehicle_classes  text[] default '{}',
  fulfillment      text[] default '{}',
  whatsapp         text not null,      -- E.164, opted-in
  base_price_per_day numeric,
  partner          boolean default true,
  created_at       timestamptz not null default now()
);

-- ---- Personal WhatsApp sessions (Evolution API instances per user) -----------
create table if not exists public.wa_sessions (
  email         text primary key,
  instance_name text not null,
  status        text default 'connecting',
  host_url      text,
  updated_at    timestamptz not null default now()
);
create index if not exists wa_sessions_instance_idx
  on public.wa_sessions (instance_name);
-- If you already ran an older schema, run this once:
alter table public.wa_sessions add column if not exists host_url text;
-- Pairing-code freshness (B1): when the code shown to the user was minted, so
-- the app can enforce a real ~55s TTL instead of guessing from updated_at.
alter table public.wa_sessions add column if not exists pairing_code_issued_at timestamptz;
-- Proxy stickiness (Tier 2.3): the per-user residential-gateway session token,
-- minted ONCE and never rotated automatically. Lives here rather than in
-- Evolution's own Proxy row because /instance/delete cascades that row away on
-- every "Try again" - so the exit would silently change on each retry. There
-- is no pool to resize, so no mod-hash remap.
alter table public.wa_sessions add column if not exists proxy_session_id text;
-- Proxy verification (Tier 2.2): when /proxy/set last CONFIRMED the exit was
-- carrying traffic (it fetches icanhazip.com direct AND through the proxy and
-- requires them to differ). Null = asserted-but-unverified. The transport
-- tiles read this so "asserted" and "verified" stop being the same colour.
alter table public.wa_sessions add column if not exists proxy_verified_at timestamptz;

-- ---- Bookings ---------------------------------------------------------------
create table if not exists public.bookings (
  id           bigint generated always as identity primary key,
  user_email   text,
  vendor_id    text,
  vendor_name  text,
  price_per_day numeric,
  total_price  numeric,
  fulfillment  text,
  scheduled_at timestamptz,
  status       text not null default 'confirmed',
  created_at   timestamptz not null default now()
);

-- ---- Feedback (triaged) -----------------------------------------------------
create table if not exists public.feedback (
  id             bigint generated always as identity primary key,
  category       text,
  body           text not null,
  reporter_email text,
  is_real_issue  boolean default false,
  severity       text,
  summary        text,
  triage_reason  text,
  image_count    int default 0,
  created_at     timestamptz not null default now()
);
create index if not exists feedback_created_idx on public.feedback (created_at desc);

-- ---- Billing events (PayPal webhook) ----------------------------------------
create table if not exists public.billing_events (
  id                bigint generated always as identity primary key,
  provider_event_id text,
  type              text,
  verified          boolean default false,
  created_at        timestamptz not null default now()
);
-- Migration: earlier deployments had the column named stripe_event_id.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'billing_events'
      and column_name = 'stripe_event_id'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'billing_events'
      and column_name = 'provider_event_id'
  ) then
    alter table public.billing_events rename column stripe_event_id to provider_event_id;
  end if;
end $$;
-- Wallet adoption tracking (V2-6): funding source of the payment (card /
-- apple_pay / google_pay / paypal_balance) when the webhook reports it, so
-- Apple Pay / Google Pay uptake is measurable after they are enabled.
alter table public.billing_events add column if not exists funding_source text;

-- ---- Lock everything to the service role ------------------------------------
alter table public.app_config       enable row level security;
alter table public.whatsapp_messages enable row level security;
alter table public.app_users        enable row level security;
alter table public.agent_tactics    enable row level security;
alter table public.vendors          enable row level security;
alter table public.bookings         enable row level security;
alter table public.feedback         enable row level security;
alter table public.billing_events   enable row level security;
alter table public.searches         enable row level security;
alter table public.offers           enable row level security;
alter table public.auth_events      enable row level security;
alter table public.ai_usage         enable row level security;
alter table public.agent_training   enable row level security;
alter table public.vendor_replies   enable row level security;
alter table public.bargain_drafts   enable row level security;
alter table public.wa_sessions      enable row level security;
-- No policies are created on purpose: the anon/public key gets zero access;
-- the server uses the service role key, which bypasses RLS.

-- ---- API usage log (cost tracker + per-user daily limits) --------------------
create table if not exists public.api_usage (
  id         bigint generated always as identity primary key,
  kind       text not null,
  count      int not null default 1,
  user_email text,
  created_at timestamptz not null default now()
);
create index if not exists api_usage_kind_idx on public.api_usage (kind, created_at desc);
create index if not exists api_usage_user_idx on public.api_usage (user_email, kind, created_at desc);
alter table public.api_usage enable row level security;

-- ---- Feedback screenshots (viewable in the management workspace) ------------
create table if not exists public.feedback_images (
  id          bigint generated always as identity primary key,
  feedback_id bigint,
  data_url    text not null,
  created_at  timestamptz not null default now()
);
create index if not exists feedback_images_fid_idx on public.feedback_images (feedback_id);
alter table public.feedback_images enable row level security;

-- ---- Market floor prices (owner + AI weekly research) ------------------------
-- Lowest realistic daily rental price per area + vehicle bucket. Keyed at the
-- AREA level ("koh samui, thailand") with a COUNTRY fallback row - never one
-- row per town. The bargaining agent anchors its single ask to these floors.
create table if not exists public.market_floor_prices (
  id              bigint generated always as identity primary key,
  region_key      text not null,
  vehicle_key     text not null,
  currency        text not null default 'USD',
  floor_per_day   numeric not null,
  typical_per_day numeric,
  source          text not null default 'ai', -- 'ai' | 'owner'
  updated_at      timestamptz not null default now(),
  unique (region_key, vehicle_key)
);
create index if not exists market_floor_region_idx
  on public.market_floor_prices (region_key, vehicle_key);
alter table public.market_floor_prices enable row level security;
-- Grounded-benchmark provenance (F5 anti-hallucination): only a number backed
-- by a real web source may ever be shown to a user or cited to a shop as
-- leverage. `grounded` distinguishes a Google-Search-grounded figure from an
-- ungrounded model estimate; `source_url` is the citation.
alter table public.market_floor_prices add column if not exists grounded boolean not null default false;
alter table public.market_floor_prices add column if not exists source_url text;

-- ---- WhatsApp number reputation (Anti-Ban engine) -----------------------------
-- Dynamic Trust Score per connected sender. Replies build trust and relax the
-- hourly budget; pure outbound decays it. New numbers warm up on half budget.
create table if not exists public.whatsapp_number_reputation (
  id            bigint generated always as identity primary key,
  sender_key    text not null unique,   -- user email (one WA number per user)
  trust_score   int not null default 20,
  sent_total    int not null default 0,
  replies_total int not null default 0,
  last_send_at  timestamptz,
  -- WHICH NUMBER THIS REPUTATION IS ABOUT.
  -- Everything here keys on the EMAIL, and `created_at` is what the warm-up
  -- ramp reads as "how old is this number". So a tester who linked number A,
  -- sent for a week, unlinked and linked a brand-new burner B inherited A's
  -- age (ramp factor 1.0), A's trust score and A's counters - the genuinely
  -- cold number got a fully-warmed budget on its first day, which is the most
  -- bannable pattern there is. Nothing anywhere reset this row. Storing the
  -- last four digits lets a swap be detected and the warm-up restarted.
  phone_tail    text,
  created_at    timestamptz not null default now()
);
alter table public.whatsapp_number_reputation add column if not exists phone_tail text;
alter table public.whatsapp_number_reputation enable row level security;

-- ---- WhatsApp security policies (owner control panel) -------------------------
-- Every anti-ban knob lives here so the owner tunes the engine from the DB /
-- admin UI without a redeploy. Missing keys fall back to safe code defaults.
create table if not exists public.whatsapp_security_policies (
  id    bigint generated always as identity primary key,
  key   text not null unique,
  value text not null
);
alter table public.whatsapp_security_policies enable row level security;

-- ---- WhatsApp outbox (business-hours + pacing queue) --------------------------
-- Automated messages blocked by recipient night hours or pacing gaps park here
-- and are drained opportunistically by the webhook / status poll.
create table if not exists public.wa_outbox (
  id         bigint generated always as identity primary key,
  sender_key text not null,
  to_number  text not null,
  body       text not null,
  not_before timestamptz not null,
  meta       jsonb,
  created_at timestamptz not null default now()
);
create index if not exists wa_outbox_due_idx on public.wa_outbox (not_before asc);
-- The per-sender pending-count check in the outbound guard runs on every send.
create index if not exists wa_outbox_sender_idx on public.wa_outbox (sender_key);
alter table public.wa_outbox enable row level security;

-- B4 SEND-INTEGRITY: enforce at most ONE pending automated row per
-- (sender, shop, kind) at the DATABASE level - the only guarantee that survives
-- the 7 concurrent drain/enqueue trigger points (app-level SELECT-then-INSERT
-- checks all race). Scoped to automated kinds; user-typed ('custom',
-- 'human-manual') may coexist, mirroring parkOutboxOnce's own exception list.
--
-- The key list is deliberately wider than the original (sender_key, to_number).
-- Two independent defects shared this one index, so they are corrected together
-- rather than in two passes that would each redefine it:
--   * to_number is matched as an EXACT string, but one shop is legitimately
--     stored as both "639661952196" and "09661952196" (which is why every READ
--     path uses the tolerant numberFilter). Two spellings therefore satisfied
--     the index as two pending rows for one shop, and a single drain sent both
--     inside the same wall-clock second. `to_key` carries the canonical form
--     (nationalTail || waDigits) so one shop is one key whatever the spelling.
--   * the index was kind-BLIND while parkOutboxOnce deliberately spares a
--     pending 'rfq' row, so a shop replying while its RFQ was still queued
--     collided on insert and the reply was never sent. Keying on the kind lets
--     an rfq and a reply coexist as separate pending rows, which is exactly
--     what the park code already intends.
-- coalesce(to_key, to_number) keeps rows written before the app learned to
-- stamp to_key under today's exact-string semantics, so this DDL is correct
-- whether it runs before or after the deploy that starts writing the column.
--
-- Run the de-dup cleanup FIRST (a plain CREATE UNIQUE INDEX fails if duplicates
-- already exist) - and note it now requires the kinds to MATCH, because the new
-- index permits the cross-kind pair the old one collapsed. The DROP is the one
-- destructive statement in this file and is unavoidable: an index cannot be
-- redefined in place, and CREATE INDEX IF NOT EXISTS would silently keep the
-- stale, too-narrow key list on every already-migrated project. It destroys no
-- row - only the derived structure rebuilt on the next line.
alter table public.wa_outbox add column if not exists to_key text;
delete from public.wa_outbox a using public.wa_outbox b
  where a.id > b.id
    and a.sender_key = b.sender_key
    and coalesce(a.to_key, a.to_number) = coalesce(b.to_key, b.to_number)
    and coalesce(a.meta->>'kind','') = coalesce(b.meta->>'kind','')
    and coalesce(a.meta->>'kind','') not in ('custom','human-manual')
    and coalesce(b.meta->>'kind','') not in ('custom','human-manual');
drop index if exists public.wa_outbox_pending_auto_uidx;
create unique index if not exists wa_outbox_pending_auto_uidx
  on public.wa_outbox (sender_key, coalesce(to_key, to_number), coalesce(meta->>'kind',''))
  where coalesce(meta->>'kind','') not in ('custom','human-manual');
-- parkOutboxOnce's delete-then-insert scope moves off to_number=eq. and onto
-- to_key, so give that lookup its own plain index - the unique index above is
-- an EXPRESSION index and cannot serve a to_key=eq. filter.
create index if not exists wa_outbox_to_key_idx
  on public.wa_outbox (sender_key, to_key);

-- ---- WA idle pause (session quiets down while the app is not in use) ----------
alter table public.wa_sessions add column if not exists last_active timestamptz;
alter table public.wa_sessions add column if not exists idle_paused boolean default false;

-- ---- Sponsored rental shops (owner-managed, paid placement) -------------------
-- Shops that pay to appear at the top of results with a glowing card and a
-- "Recommended" tag. Matched against Google results by phone digits or name.
create table if not exists public.sponsored_shops (
  id          bigint generated always as identity primary key,
  name        text not null,          -- shop name exactly as on Google Maps
  place_query text,                   -- optional "name, area" hint for matching
  phone       text,                   -- digits-only phone for exact matching
  active      boolean not null default true,
  notes       text,                   -- deal terms, contact, price paid...
  created_at  timestamptz not null default now()
);
alter table public.sponsored_shops enable row level security;

-- ---- Agent events (owner notifications: vague replies, funnel anomalies) ------
create table if not exists public.agent_events (
  id          bigint generated always as identity primary key,
  kind        text not null,           -- 'vague-reply' | 'funnel-gap' | ...
  vendor_id   text,
  vendor_name text,
  detail      text,
  handled     boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists agent_events_kind_idx on public.agent_events (kind, created_at desc);
alter table public.agent_events enable row level security;

-- ---- Anti-Ban v2: deeper reputation + risk signals ---------------------------
-- Extra columns tracked per connected number so the risk engine can score ban
-- likelihood from real behaviour (cold-contact volume, block/read rates, etc.).
alter table public.whatsapp_number_reputation add column if not exists blocks_total       int default 0;
alter table public.whatsapp_number_reputation add column if not exists fails_total        int default 0;
alter table public.whatsapp_number_reputation add column if not exists reads_total        int default 0;
alter table public.whatsapp_number_reputation add column if not exists delivered_total    int default 0;
alter table public.whatsapp_number_reputation add column if not exists new_contacts_today int default 0;
alter table public.whatsapp_number_reputation add column if not exists new_contacts_date  text;
alter table public.whatsapp_number_reputation add column if not exists last_reply_at      timestamptz;
alter table public.whatsapp_number_reputation add column if not exists paused_until       timestamptz;
alter table public.whatsapp_number_reputation add column if not exists risk_score         int default 0;

-- Per-recipient delivery state (read receipts + block detection) so the
-- engagement halt can require a blue tick OR a reply before any follow-up,
-- and so we can measure delivered-but-never-read (a strong bot signal).
create table if not exists public.wa_recipient_state (
  id            bigint generated always as identity primary key,
  sender_key    text not null,
  to_number     text not null,
  last_sent_at  timestamptz,
  last_read_at  timestamptz,
  last_reply_at timestamptz,
  delivered     boolean default false,
  read          boolean default false,
  blocked       boolean default false,
  unique (sender_key, to_number)
);
create index if not exists wa_recipient_state_idx on public.wa_recipient_state (sender_key, to_number);
alter table public.wa_recipient_state enable row level security;

-- ---- User cooldowns (free-tier pickup-bypass enforcement, etc.) ---------------
-- Temporary per-user blocks. Free users who try to arrange a next-day pickup
-- (bypassing the today-only limit) are blocked from sending for 6 hours.
create table if not exists public.user_cooldowns (
  email      text not null,
  kind       text not null,
  until      timestamptz not null,
  reason     text,
  created_at timestamptz not null default now(),
  primary key (email, kind)
);
alter table public.user_cooldowns enable row level security;

-- ---- Feedback workflow (owner triage: status + notes) ------------------------
alter table public.feedback add column if not exists status     text default 'open';
alter table public.feedback add column if not exists owner_note text;
alter table public.feedback add column if not exists resolved_at timestamptz;

-- ---- Feedback threads (user <-> owner/admin conversation per report) ----------
-- Each report becomes a real, two-way thread the reporter can see and reply to.
-- `user_seen_at` powers the unread badge (a reply newer than this is unread).
alter table public.feedback add column if not exists user_seen_at timestamptz;
create index if not exists feedback_reporter_idx
  on public.feedback (reporter_email, created_at desc);
create table if not exists public.feedback_replies (
  id           bigint generated always as identity primary key,
  feedback_id  bigint not null,
  author_email text,
  author_role  text not null default 'user',  -- 'user' | 'admin' | 'owner'
  body         text not null,
  created_at   timestamptz not null default now()
);
create index if not exists feedback_replies_fid_idx
  on public.feedback_replies (feedback_id, created_at);
alter table public.feedback_replies enable row level security;

-- ---- Shop intelligence (New#18): tag offers with area + vehicle bucket ---------
-- So we can aggregate real market data by area and vehicle type (lowest /
-- highest / typical price, rental duration, delivery signal) for the owner.
alter table public.offers add column if not exists region_key   text;
alter table public.offers add column if not exists vehicle_key  text;
alter table public.offers add column if not exists duration_days int;
alter table public.offers add column if not exists delivers      boolean;
create index if not exists offers_intel_idx on public.offers (region_key, vehicle_key);

-- ---- Honest local pricing + confirmed conditions (Wave 35) --------------------
-- vendor_replies carries the shop's OWN currency and any explicitly-confirmed
-- deposit / delivery terms, so the app never silently defaults to USD and can
-- show truthful tags ("Passport deposit", "Delivers") on the cards.
alter table public.vendor_replies add column if not exists currency text;
alter table public.vendor_replies add column if not exists deposit  text;
alter table public.vendor_replies add column if not exists delivers boolean;
alter table public.offers         add column if not exists deposit_note text;
alter table public.bookings add column if not exists currency text;

-- ---- Verified reply-based shop tags (item #13) --------------------------------
-- One row per (reply, tag) fact a shop explicitly stated. A tag is shown to
-- travellers only after >= 2 DISTINCT replies (reply_hash) confirmed it.
create table if not exists public.vendor_tag_signals (
  id         bigint generated always as identity primary key,
  vendor_id  text not null,
  tag        text not null,
  user_email text,
  reply_hash text,
  created_at timestamptz not null default now()
);
create index if not exists vendor_tag_signals_idx
  on public.vendor_tag_signals (vendor_id, tag);
alter table public.vendor_tag_signals enable row level security;

-- ---- Agent orchestrator traces (full decision visibility) ---------------------
-- One row per pipeline stage per decision: input -> reasoning -> output, plus
-- validator verdicts and strategist wait choices. Powers the owner's live
-- decisions viewer in Admin -> Agents.
create table if not exists public.agent_traces (
  id          bigint generated always as identity primary key,
  decision_id text not null,
  user_email  text,
  vendor_id   text,
  vendor_name text,
  stage       text not null,
  input       text,
  reasoning   text,
  output      text,
  verdict     text,
  created_at  timestamptz not null default now()
);
create index if not exists agent_traces_created_idx
  on public.agent_traces (created_at desc);
create index if not exists agent_traces_decision_idx
  on public.agent_traces (decision_id);
alter table public.agent_traces enable row level security;

-- ---- Inbound webhook dedupe claim (exactly-once processing) --------------------
-- One row per processed inbound WhatsApp message id. processVendorReply claims
-- a message by inserting here; the primary key makes the claim atomic so two
-- concurrent webhook deliveries can never both reply (or both bail).
create table if not exists public.wa_processed (
  wa_message_id text primary key,
  created_at    timestamptz not null default now(),
  -- THE CLAIM IS A LEASE, NOT A TOMBSTONE.
  -- A turn that fails DELETES its claim, so a surviving row was meant to mean
  -- "answered". But an instance killed mid-turn (Cloud Run recycles freely)
  -- deletes nothing - the claim outlives the turn that owned it, and the
  -- recovery sweep then skips that message forever as already-answered. The
  -- shop's reply is stored, silent and unrecoverable.
  -- settled_at is stamped only when a reply actually went out, which makes the
  -- two cases distinguishable: an unsettled claim past its lease is a dead
  -- turn and may be retaken.
  settled_at    timestamptz
);
alter table public.wa_processed add column if not exists settled_at timestamptz;

-- STORE-level inbound idempotency (distinct from wa_processed, which guards the
-- agent REPLY). Evolution redelivers webhooks and the recovery sync re-pulls the
-- same window; without this claim one shop photo became two "[photo]" rows in
-- the transcript. Kept separate so a message dropped before its reply (e.g. an
-- unresolved thread) stays replayable once the thread is repaired.
create table if not exists public.wa_inbound_seen (
  wa_message_id text primary key,
  created_at    timestamptz not null default now()
);
alter table public.wa_inbound_seen enable row level security;
alter table public.wa_processed enable row level security;

-- ---- Rental funnel build-out: richer booking + offer terms ---------------------
alter table public.bookings add column if not exists duration_days   int;
alter table public.bookings add column if not exists start_date      date;
alter table public.bookings add column if not exists return_date     date;
alter table public.bookings add column if not exists delivery_address text;
alter table public.bookings add column if not exists one_way_dropoff text;
alter table public.bookings add column if not exists driver_age      int;
alter table public.bookings add column if not exists scheduled_tz    text;
-- A BOOKED TRIP MUST OUTLIVE THE SEARCH THAT FOUND IT.
--
-- Everything a traveller needs after the deal is closed - the shop's WhatsApp
-- number to ask a question, its coordinates to walk there, what they saved -
-- lived only in the live search session, which expires. So a rental they are
-- standing next to could stop being reachable from the app. One additive JSONB
-- snapshot, written at close time, keeps the trip self-contained.
alter table public.bookings add column if not exists meta jsonb;
alter table public.offers   add column if not exists delivery_fee     numeric;
alter table public.offers   add column if not exists insurance_included boolean;
alter table public.offers   add column if not exists km_limit_per_day text;
alter table public.offers   add column if not exists fuel_policy      text;
alter table public.offers   add column if not exists effective_daily_rate numeric;
-- PROVENANCE FOR A DERIVED PER-DAY (owner report 5 #2, the "167" screenshot).
-- The span the shop's amount actually covered when we DIVIDED it into a daily
-- figure ("500 for 3 days" -> 167/day, quote_basis_days = 3). NULL = the shop
-- stated a per-day rate. A rival whose basis exceeds the traveller's rental is
-- not a like-for-like daily price and must never be quoted at another shop as
-- one - see pickCheapestRival.
alter table public.offers   add column if not exists quote_basis_days int;
alter table public.vendor_replies add column if not exists insurance_included boolean;
alter table public.vendor_replies add column if not exists delivery_fee        numeric;

-- Structured deposit (from lib/deposit.ts): the KIND the shop wants held plus a
-- cash figure + its currency, so the app shows a precise deposit tag next to the
-- price ("Passport", "THB 3,000 cash") and can filter by deposit kind.
alter table public.offers         add column if not exists deposit_type     text;
alter table public.offers         add column if not exists deposit_amount   numeric;
alter table public.offers         add column if not exists deposit_currency text;
alter table public.vendor_replies add column if not exists deposit_type     text;
alter table public.vendor_replies add column if not exists deposit_amount   numeric;
alter table public.vendor_replies add column if not exists deposit_currency text;

-- Market floors gained a 'web' source (live web research) alongside 'ai'/'owner'.
-- (source is already a free-text column; no migration needed - noted for clarity.)

-- ---- Web Push subscriptions (shop-reply alerts, all plans) --------------------
-- One row per browser/device a user opted in from. The reply webhook sends a
-- push to every row for that user so alerts arrive even when the app is closed.
create table if not exists public.push_subscriptions (
  id         bigint generated always as identity primary key,
  user_email text not null,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);
create index if not exists push_subs_user_idx on public.push_subscriptions (user_email);
alter table public.push_subscriptions enable row level security;

-- ================================================================================
-- DIGRAPH NEGOTIATION ENGINE (graph orchestration v2)
-- ================================================================================

-- ---- Per-thread durable negotiation state (the engine's checkpoint) -----------
-- One row per user<->shop WhatsApp thread. The graph engine loads it on every
-- event, mutates phase/fields/node_runs, and writes it back with an optimistic
-- version check - serverless-safe resume between webhook invocations.
create table if not exists public.negotiation_threads (
  thread_key       text primary key,            -- user_email:to_digits
  user_email       text not null,
  vendor_id        text,
  vendor_name      text,
  to_number        text not null,
  phase            text not null default 'opening',
  version          int  not null default 0,
  fields           jsonb not null default '{}'::jsonb,
  node_runs        jsonb not null default '{}'::jsonb,
  waiting_until    timestamptz,
  last_decision_id text,
  updated_at       timestamptz not null default now()
);
create index if not exists negotiation_threads_user_idx
  on public.negotiation_threads (user_email, updated_at desc);
alter table public.negotiation_threads enable row level security;

-- =============================================================================
-- SPTE (Single-Pass Turn Engine) - the Blackboard + single-pass agent (V2-4)
-- =============================================================================
-- One user search = one session = the durable twin of the Redis "blackboard".
-- Replaces the marker-row inference of "session" with a real, queryable row.
create table if not exists public.search_sessions (
  id           uuid primary key default gen_random_uuid(),
  user_email   text not null,
  rfq          jsonb not null,
  region_key   text,
  currency     text,
  status       text not null default 'active',   -- active | closed | completed
  benchmark    jsonb,      -- {pricePerDay,currency,sourceUrl,grounded,fetchedAt}
  lowest       jsonb,      -- {vendorId,shop,pricePerDay,at} - denormalized cross-thread best
  created_at   timestamptz not null default now(),
  closed_at    timestamptz
);
create index if not exists search_sessions_user_idx
  on public.search_sessions (user_email, status, created_at desc);
alter table public.search_sessions enable row level security;

-- negotiation_threads joins a session + carries a rolling digest and the
-- denormalized last-in/out message (the batch status panel + SPTE snapshot).
alter table public.negotiation_threads add column if not exists session_id uuid;
alter table public.negotiation_threads add column if not exists digest jsonb;
alter table public.negotiation_threads add column if not exists last_inbound_text text;
alter table public.negotiation_threads add column if not exists last_inbound_at timestamptz;
alter table public.negotiation_threads add column if not exists last_outbound_text text;
alter table public.negotiation_threads add column if not exists last_outbound_at timestamptz;
create index if not exists negotiation_threads_session_idx
  on public.negotiation_threads (session_id);

-- The single-query context fetch: ONE round-trip per turn (kind to the pg pool
-- max:5). Returns the session, this thread, its last 6 messages, and the top-3
-- live rival offers from sibling threads - everything the single pass needs.
create or replace function public.get_turn_context(p_thread text)
returns jsonb language sql stable as $$
  with t as (
    select * from public.negotiation_threads where thread_key = p_thread
  )
  select jsonb_build_object(
    'thread', (select to_jsonb(t) from t),
    'session', (select to_jsonb(s) from public.search_sessions s, t
                where s.id = t.session_id),
    'tail', (select coalesce(jsonb_agg(m order by m.received_at desc), '[]'::jsonb)
             from (select direction, body, raw, received_at
                   from public.whatsapp_messages, t
                   where whatsapp_messages.to_number = t.to_number
                     and whatsapp_messages.raw->>'sender' = t.user_email
                   order by received_at desc limit 6) m),
    'rivals', (select coalesce(jsonb_agg(r), '[]'::jsonb)
               from (select jsonb_build_object(
                       'vendorId', t2.vendor_id, 'shop', t2.vendor_name,
                       'pricePerDay', (t2.fields->>'pricePerDay')::numeric,
                       'currency', t2.fields->>'currency') r
                     from public.negotiation_threads t2, t
                     where t2.session_id = t.session_id
                       and t2.thread_key <> t.thread_key
                       and (t2.fields->>'pricePerDay') is not null
                     order by (t2.fields->>'pricePerDay')::numeric asc
                     limit 3) x)
  );
$$;

-- ATOMIC REPUTATION COUNTERS (owner report 8, M3).
--
-- Every safety counter on whatsapp_number_reputation was written read-modify-
-- write: the app read `sent_total`, added one, and PATCHed the absolute value
-- back. Two writers for the same sender - an inbound reply landing while an
-- outbound send completes, which is precisely what a 50-user beta produces -
-- both read N and both write N+1. One increment is simply lost.
--
-- These counters are not decoration. They are the numerator and denominator of
-- `computeRisk`, which auto-pauses a number at the risk threshold. A gauge that
-- silently under-counts is worse than no gauge: it reads healthy while the
-- thing it measures is not.
--
-- So the increments happen IN THE DATABASE, where `col = col + delta` is atomic
-- under the row lock. `p_bumps` is a flat jsonb object of column -> integer
-- delta; `p_set` is the ordinary last-write-wins fields (timestamps, scores)
-- which have no accumulation semantics and are correct to overwrite.
--
-- The column allow-list is CLOSED and spelled out. This function is reachable
-- over PostgREST, so a dynamic `format('%I', key)` would let any caller who can
-- call it increment any integer column on the table. Naming the six is not
-- verbosity, it is the security boundary.
create or replace function public.wa_rep_bump(
  p_sender text,
  p_bumps  jsonb default '{}'::jsonb,
  p_set    jsonb default '{}'::jsonb
)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.whatsapp_number_reputation set
    sent_total            = coalesce(sent_total, 0)            + coalesce((p_bumps->>'sent_total')::int, 0),
    replies_total         = coalesce(replies_total, 0)         + coalesce((p_bumps->>'replies_total')::int, 0),
    blocks_total          = coalesce(blocks_total, 0)          + coalesce((p_bumps->>'blocks_total')::int, 0),
    fails_total           = coalesce(fails_total, 0)           + coalesce((p_bumps->>'fails_total')::int, 0),
    reads_total           = coalesce(reads_total, 0)           + coalesce((p_bumps->>'reads_total')::int, 0),
    delivered_total       = coalesce(delivered_total, 0)       + coalesce((p_bumps->>'delivered_total')::int, 0),
    invalid_numbers_total = coalesce(invalid_numbers_total, 0) + coalesce((p_bumps->>'invalid_numbers_total')::int, 0),
    -- NEW CONTACTS RESET WITH THE DAY, not by accumulating forever. The date is
    -- carried in p_set; when it differs from the stored one the counter starts
    -- from this bump instead of adding to yesterday's.
    new_contacts_today =
      case
        when p_bumps ? 'new_contacts_today' and p_set ? 'new_contacts_date'
             and coalesce(new_contacts_date, '') is distinct from (p_set->>'new_contacts_date')
          then (p_bumps->>'new_contacts_today')::int
        else coalesce(new_contacts_today, 0) + coalesce((p_bumps->>'new_contacts_today')::int, 0)
      end,
    -- Last-write-wins fields. `?` is jsonb key-existence, so an absent key
    -- leaves the column untouched while an explicit JSON null clears it.
    new_contacts_date         = case when p_set ? 'new_contacts_date'         then p_set->>'new_contacts_date'                 else new_contacts_date end,
    -- ROUNDED, NOT CAST. `'22.5'::int` does not truncate in Postgres, it raises
    -- "invalid input syntax for type integer" and aborts the WHOLE update - so
    -- one fractional value would take every counter in the same call down with
    -- it, and the app would silently fall back to the racy path this function
    -- exists to replace. And fractional IS reachable: policy-values validates
    -- trust_reply_gain / trust_send_decay as `number`, not integer, so an owner
    -- typing 2.5 in the WA-security panel makes every subsequent trust write a
    -- non-integer. Rounding through numeric accepts both shapes.
    trust_score               = case when p_set ? 'trust_score'               then round((p_set->>'trust_score')::numeric)::int else trust_score end,
    risk_score                = case when p_set ? 'risk_score'                then round((p_set->>'risk_score')::numeric)::int  else risk_score end,
    last_send_at              = case when p_set ? 'last_send_at'              then (p_set->>'last_send_at')::timestamptz       else last_send_at end,
    last_reply_at             = case when p_set ? 'last_reply_at'             then (p_set->>'last_reply_at')::timestamptz      else last_reply_at end,
    paused_until              = case when p_set ? 'paused_until'              then (p_set->>'paused_until')::timestamptz       else paused_until end,
    cold_hold_until           = case when p_set ? 'cold_hold_until'           then (p_set->>'cold_hold_until')::timestamptz    else cold_hold_until end,
    last_delivery_receipt_at  = case when p_set ? 'last_delivery_receipt_at'  then (p_set->>'last_delivery_receipt_at')::timestamptz else last_delivery_receipt_at end,
    last_read_receipt_at      = case when p_set ? 'last_read_receipt_at'      then (p_set->>'last_read_receipt_at')::timestamptz     else last_read_receipt_at end,
    phone_tail                = case when p_set ? 'phone_tail'                then p_set->>'phone_tail'                        else phone_tail end,
    created_at                = case when p_set ? 'created_at'                then (p_set->>'created_at')::timestamptz         else created_at end
  where sender_key = p_sender;
end;
$$;

-- SECURITY DEFINER + PostgREST means "callable with the anon key" unless it is
-- revoked, and this one writes the anti-ban gauge. Same treatment
-- prune_old_rows gets below, for the same reason.
revoke all on function public.wa_rep_bump(text, jsonb, jsonb) from public;
revoke all on function public.wa_rep_bump(text, jsonb, jsonb) from anon;
revoke all on function public.wa_rep_bump(text, jsonb, jsonb) from authenticated;
grant execute on function public.wa_rep_bump(text, jsonb, jsonb) to service_role;

-- SELF-IMPROVEMENT LOOP (the owner's "experience & continuous learning"): every
-- successful deal and every grounded benchmark is banked here, so future
-- sessions in the same region/vehicle start from a real prior instead of cold.
create table if not exists public.deal_memory (
  id            bigint generated always as identity primary key,
  region_key    text not null,
  vehicle_key   text not null,
  currency      text,
  price_per_day numeric not null,       -- the price actually achieved
  list_price    numeric,                -- the shop's first quote (discount signal)
  duration_days int,
  tactic        text,                   -- the move/leverage that won it
  source        text not null default 'deal',  -- deal | benchmark
  created_at    timestamptz not null default now()
);
create index if not exists deal_memory_lookup_idx
  on public.deal_memory (region_key, vehicle_key, created_at desc);
alter table public.deal_memory enable row level security;

-- ---- Deferred-decision wakeups (strategic waits + judge jobs) ------------------
-- The engine parks a "decide again later" marker here; every opportunistic
-- drain site (webhook, wa/status poll, replies poll, queue, ping) claims due
-- rows atomically (delete-returning) and re-runs the graph with FRESH context,
-- so a rival offer that arrived during the wait changes the leverage math.
create table if not exists public.graph_wakeups (
  id         bigint generated always as identity primary key,
  kind       text not null default 'tick',      -- 'tick' | 'judge' | 'session-judge'
  thread_key text not null,
  not_before timestamptz not null,
  payload    jsonb,
  created_at timestamptz not null default now()
);
create index if not exists graph_wakeups_due_idx on public.graph_wakeups (not_before asc);
alter table public.graph_wakeups enable row level security;

-- ---- Judge team scores ----------------------------------------------------------
-- Move judges grade every automated outbound (tactic fit / tone / uniqueness,
-- 1-5 each); the chief judge aggregates per thread with the hard outcome math
-- (discount %, floor gap, deal complete). Feeds tactic learning + the Studio.
create table if not exists public.agent_scores (
  id             bigint generated always as identity primary key,
  decision_id    text,
  thread_key     text,
  node_id        text,
  scorer         text not null,                 -- 'move-judge' | 'chief-judge' | 'deterministic'
  rubric_version text not null default 'v1',
  scores         jsonb not null,                -- {tacticFit,tone,uniqueness,outcomeDelta}
  tactic_id      text,
  provider       text,                          -- which LLM judged (family-bias audit)
  verdict        text,                          -- one-line justification
  created_at     timestamptz not null default now()
);
create index if not exists agent_scores_thread_idx
  on public.agent_scores (thread_key, created_at desc);
create index if not exists agent_scores_decision_idx
  on public.agent_scores (decision_id);
alter table public.agent_scores enable row level security;

-- ---- Trace path stamps: which graph node/edge produced each trace row ----------
alter table public.agent_traces add column if not exists node_id text;
alter table public.agent_traces add column if not exists edge_id text;

-- ---- Deal completeness gating on offers ----------------------------------------
-- An offer is PRESENTED to the traveller only once price + deposit + how to
-- get the vehicle (pickup/delivery/on-shop) are known (or probing timed out).
alter table public.offers add column if not exists presentable boolean default false;
alter table public.offers add column if not exists fulfillment text;   -- pickup|delivery|on-shop

-- ---- Terms acceptance (legal shield) --------------------------------------------
alter table public.app_users add column if not exists terms_version text;
alter table public.app_users add column if not exists terms_accepted_at timestamptz;
alter table public.app_users add column if not exists wa_risk_accepted_at timestamptz;
alter table public.app_users add column if not exists ai_responsibility_accepted_at timestamptz;
-- Where the traveller is staying (for delivery). Coordinates are shared with
-- shops ONLY when stay_share_consent_at is set (explicit per-user opt-in).
alter table public.app_users add column if not exists stay_label text;
alter table public.app_users add column if not exists stay_lat double precision;
alter table public.app_users add column if not exists stay_lng double precision;
alter table public.app_users add column if not exists stay_share_consent_at timestamptz;

-- ================================================================================
-- AI OPERATIONS CENTER - owner review console + learning loop
-- ================================================================================

-- ---- Owner reviews of agent decisions -------------------------------------------
-- One row per reviewed decision (decision_id null = a thread-level review, e.g.
-- an auto-flag from the weak-conversation detector). Powers the Ops inbox,
-- the exemplar channel, edge priors and judge calibration.
create table if not exists public.agent_reviews (
  id              bigint generated always as identity primary key,
  decision_id     text,                           -- null = thread-level review
  thread_key      text not null,
  user_email      text,
  vendor_id       text,
  vendor_name     text,
  node_id         text,                           -- denormalized from the trace
  edge_id         text,                           -- chosen edge (priors/heatmap)
  rating          int,                            -- 1..5
  verdict         text,                           -- 'approve' | 'reject'
  branch_correct  boolean,
  outcome_impact  text,                           -- 'improved'|'worsened'|'neutral'
  better_response text,                           -- what SHOULD have been sent
  feedback        text,
  tags            text[] not null default '{}',   -- failure-pattern labels
  bookmark        boolean not null default false, -- exemplar negotiation
  status          text not null default 'open',   -- open|flagged|auto_flagged|resolved
  source          text not null default 'owner',  -- 'owner' | 'auto'
  auto_reason     text,                           -- detector explanation
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists agent_reviews_decision_idx
  on public.agent_reviews (decision_id);
create index if not exists agent_reviews_thread_idx
  on public.agent_reviews (thread_key, created_at desc);
create index if not exists agent_reviews_status_idx
  on public.agent_reviews (status, created_at desc);
alter table public.agent_reviews enable row level security;

-- ---- Versioned behavior changes (audit trail + one-click rollback) ---------------
-- Every graph-spec or policy-overlay write lands here as a full snapshot; the
-- active row is what production runs, and rollback re-activates an old row.
create table if not exists public.policy_versions (
  id           bigint generated always as identity primary key,
  kind         text not null,          -- 'graph_spec' | 'policy_overlay' | 'ops_learning'
  version      int  not null,          -- monotonic per kind
  spec         jsonb not null,         -- full snapshot
  note         text,                   -- why (audit trail)
  author       text,
  replay_score jsonb,                  -- golden replay report at activation
  active       boolean not null default false,
  created_at   timestamptz not null default now()
);
create index if not exists policy_versions_kind_idx
  on public.policy_versions (kind, version desc);
alter table public.policy_versions enable row level security;

-- ---- Golden replay cases ----------------------------------------------------------
-- Deterministic regression suite snapshotted from REAL conversations: frozen
-- extraction stubs + floor make each case bit-stable, so spec/policy changes
-- can be gated on "every golden case still passes".
create table if not exists public.agent_golden_cases (
  id         bigint generated always as identity primary key,
  name       text not null,
  thread_key text,                     -- provenance (real conversation source)
  rfq        jsonb not null,
  region     text,
  floor      jsonb,                    -- frozen {floor, typical, currency}
  turns      jsonb not null,           -- [{shopSays, stubExtraction, rival...}]
  expects    jsonb not null,           -- [{action?, edgeId?, pathContains?...}]
  enabled    boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.agent_golden_cases enable row level security;

-- ---- Latency + attribution stamps on decisions ------------------------------------
alter table public.agent_traces add column if not exists ms int;
alter table public.agent_traces add column if not exists spec_rev int;
alter table public.agent_scores add column if not exists spec_rev int;

-- ---- Cancellation tombstones (absolute queue deletion) ----------------------------
-- When a user removes queued messages for a shop (or clears/closes a search
-- session), a tombstone is written here. guardOutbound refuses AUTOMATED sends
-- to a tombstoned recipient - across the outbox drain, wakeup re-compositions
-- and retries - until the user explicitly re-initiates contact (which deletes
-- the tombstone). This is what makes "remove" permanent on serverless.
create table if not exists public.wa_cancellations (
  id         bigint generated always as identity primary key,
  sender_key text not null,
  to_number  text not null,
  reason     text,                     -- 'user-removed' | 'session-closed' | 'deal-closed'
  created_at timestamptz not null default now(),
  unique (sender_key, to_number)
);
create index if not exists wa_cancellations_sender_idx
  on public.wa_cancellations (sender_key);
alter table public.wa_cancellations enable row level security;

-- Exact-match owner scoping for wakeup purges (replaces fragile LIKE patterns
-- where '_' in an email is itself a wildcard).
alter table public.graph_wakeups add column if not exists user_email text;
create index if not exists graph_wakeups_user_idx
  on public.graph_wakeups (user_email);

-- ---- Send-slot claims (lock-free concurrency control for sends) -------------------
-- Serverless runtimes have no shared locks: 5+ concurrent drain callers each read the
-- same pacing state and could all pass the min-gap/caps together. A claim row
-- with a PRIMARY KEY makes the decision atomic: the invocation whose INSERT
-- succeeds owns the slot; a 409 conflict means another invocation won.
-- Slot kinds: "gap:<bucket>" (one send per min-gap window per sender) and
-- "msg:<digits>:<hash>" (idempotency - one delivery per unique message).
-- Rows are garbage-collected after 24h by the outbox drain.
create table if not exists public.wa_send_claims (
  sender_key text not null,
  slot_key   text not null,
  created_at timestamptz not null default now(),
  primary key (sender_key, slot_key)
);
alter table public.wa_send_claims enable row level security;
-- The GC's two ranged deletes (gcSendClaims) scan on created_at; without this
-- index each one is a full table scan on every run.
create index if not exists wa_send_claims_created_idx on public.wa_send_claims (created_at);

-- Exact ownership scoping for the risk feed (replaces a LIKE substring
-- filter on detail that could match across users).
alter table public.agent_events add column if not exists user_email text;

-- Message-path observability (owner report 3, items 4+8): join a delivery
-- back to the decision that composed it, and index the shop's number so
-- "where is this message stuck?" is one query. Writers degrade without these
-- columns (retry-without-columns), so an un-migrated database loses only the
-- join, never the event.
alter table public.agent_events add column if not exists decision_id text;
alter table public.agent_events add column if not exists to_number text;
create index if not exists agent_events_to_number_idx
  on public.agent_events (to_number, created_at desc);
create index if not exists agent_events_user_idx
  on public.agent_events (user_email, kind, created_at desc);

-- Session attribution on offers (exact rival grouping per search session).
alter table public.offers add column if not exists search_id bigint;
create index if not exists offers_search_idx on public.offers (search_id);

-- ---- Scooter Dash leaderboard -----------------------------------------------------
-- Scores publish ONLY with explicit consent: display_name is set when the
-- player chose to publish under a name; null = anonymous ("Traveller").
-- Private scores are never inserted at all (localStorage keeps them).
create table if not exists public.game_scores (
  id           bigint generated always as identity primary key,
  user_email   text not null,
  display_name text,
  score        int not null check (score >= 0 and score <= 99999),
  created_at   timestamptz not null default now()
);
create index if not exists game_scores_top_idx
  on public.game_scores (score desc, created_at asc);
alter table public.game_scores enable row level security;

-- ---------------------------------------------------------------------------
-- Hot-path indexes (launch scale). The two most-polled endpoints - /api/deals
-- and /api/activity - filter offers/traces/bookings by (user_email, created_at)
-- on every poll while a user has the app open. Without these, each poll forces
-- a sequential scan + sort of tables that grow with every quote from every
-- user. Additive + idempotent; safe to re-run.
-- ---------------------------------------------------------------------------
create index if not exists offers_user_created_idx
  on public.offers (user_email, created_at desc);
create index if not exists agent_traces_user_created_idx
  on public.agent_traces (user_email, created_at desc);
create index if not exists bookings_user_created_idx
  on public.bookings (user_email, created_at desc);
create index if not exists vendor_replies_user_created_idx
  on public.vendor_replies (user_email, created_at desc);

-- ---- Defense-in-depth RLS (Module 3.1) ----------------------------------------
-- HONEST NOTE: the app reads/writes EVERYTHING with the service_role key, which
-- BYPASSES RLS - so this changes nothing for the running app. The real tenant
-- isolation is the app-level query scoping (receiver/sender_key/user_email/
-- search_id), which is thorough and tested. This block is belt-and-suspenders:
-- it enables RLS (with NO policy = deny-all for anon/authenticated) on the
-- remaining sensitive tables that lacked it, so if an anon/authenticated key is
-- ever pointed at this project it can never read them. Idempotent - safe to
-- re-run. (whatsapp_messages / wa_outbox / wa_send_claims / wa_recipient_state
-- and most others already enable RLS above.)
alter table public.offers    enable row level security;
alter table public.searches  enable row level security;
alter table public.bookings  enable row level security;
alter table public.app_users enable row level security;

-- ================================================================================
-- TURN INTEGRITY, THREAD LOCKING, SESSION FACTS AND COMPOSITE DEPOSITS
-- ================================================================================
-- EVERY TABLE, COLUMN AND INDEX BELOW IS OPTIONAL TO THE APPLICATION. Each one
-- is consumed by code that PROBES for it and degrades to today's exact
-- behaviour when it is absent - the pattern claimSendSlots already uses: read
-- through sbSelectStrict, treat error === 'missing' as degraded-but-allowed,
-- and only treat a genuine outage as an outage. That is deliberate rather than
-- defensive: the app deploys continuously while this file is re-run by hand, so
-- the code always ships FIRST and has to be correct against a database that has
-- never seen this block. No consumer may ever hard-require one of these
-- objects, and no read path may treat a missing table as an empty result.
-- Additive and idempotent: safe to re-run, and nothing here drops or rewrites a
-- row. The legacy columns these sit beside are all retained and still written.
-- ================================================================================

-- ---- Composite deposit (offers + vendor_replies) --------------------------------
-- The flat (deposit_type, deposit_amount, deposit_currency) triple above can
-- hold exactly ONE component, so a shop that says "5000 baht AND your passport"
-- loses half its own terms the moment it is stored - and which half survived
-- depended on parse order, which is why the same reply could show a friendly
-- deposit tag on one surface and a scam warning on another. deposit_json holds
-- the full Deposit value object (components[], combinator, stated, raw) so a
-- composite survives the round trip intact; deposit_variant is the denormalized
-- discriminator the card/filter surfaces read without parsing the blob.
-- The scalar triple stays populated by toLegacy() for the whole migration
-- window: /api/replies degrades through three progressively narrower selects,
-- and an unknown column in the richest one silently blanks the entire feed.
alter table public.offers         add column if not exists deposit_json    jsonb;
alter table public.offers         add column if not exists deposit_variant text;
alter table public.vendor_replies add column if not exists deposit_json    jsonb;
alter table public.vendor_replies add column if not exists deposit_variant text;
-- Deposit is a first-class filter on the offers board (travellers screen out
-- document-surrender shops), so the discriminator needs its own index.
create index if not exists offers_deposit_variant_idx
  on public.offers (deposit_variant);

-- ---- Immutable session facts ----------------------------------------------------
-- search_sessions and negotiation_threads.session_id were designed above and
-- never written to: not one TypeScript reference. With no durable anchor the
-- de-facto session identity became the newest outbound row's blob, which every
-- turn rewrites - so the outbound fact-check guard was validating each message
-- against a target that drifted with it, amplifying drift instead of catching
-- it. digest is the sha256 of the frozen request scalars (duration, class, cc,
-- transmission, seats), which makes a silent mutation of a live session cheap
-- to detect rather than something only a human reading the transcript notices.
alter table public.search_sessions add column if not exists digest text;

-- A thread's facts are WRITE-ONCE. bindThread already filters on
-- `session_id is null` so a second, different binding simply matches no row and
-- reports a conflict - but that is an app-level convention, and the entire
-- class of bug being fixed here is an anchor that some other code path was free
-- to move. The trigger makes re-pointing a bound thread at a different session
-- unrepresentable at the storage layer, so no future writer can reintroduce it.
-- Two transitions stay legal on purpose: null -> a session (the bind), and a
-- session -> null (the unbind /api/session/close performs so that a re-contact
-- after the search is closed opens a FRESH session instead of resuming the old
-- one's price, round and firmness state).
create or replace function public.negotiation_threads_session_write_once()
returns trigger language plpgsql as $$
begin
  if old.session_id is not null
     and new.session_id is not null
     and new.session_id <> old.session_id then
    raise exception
      'negotiation_threads.session_id is write-once: thread % is already bound to session %',
      old.thread_key, old.session_id
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end;
$$;
-- Guarded creation rather than CREATE OR REPLACE TRIGGER: the replace form
-- needs PG 14+, and an existence probe drops nothing on a re-run. The rule
-- itself lives in the function body above, which IS replaced every run, so the
-- behaviour stays current even though the binding is only ever created once.
do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'negotiation_threads_session_write_once_trg'
      and tgrelid = 'public.negotiation_threads'::regclass
  ) then
    create trigger negotiation_threads_session_write_once_trg
      before update of session_id on public.negotiation_threads
      for each row execute function public.negotiation_threads_session_write_once();
  end if;
end $$;

-- ---- Turn ledger (wa_turns) -----------------------------------------------------
-- wa_processed claims an inbound message id at the TOP of the turn and nothing
-- anywhere deletes the row, so every early return or throw after the claim -
-- including one caused by a slow Supabase read collapsing to "no thread" - burns
-- that provider message id permanently. The reply is stored, claimed,
-- unanswered and structurally unrecoverable, because the recovery sweep dedupes
-- on the message EXISTING rather than on whether anyone answered it.
-- A ledger row records the whole turn instead of just its start: `state` +
-- `lease_until` mean an abandoned turn is a re-acquirable orphan rather than a
-- tombstone, and `outcome` records WHY a turn ended so deliberate silence is
-- distinguishable from infrastructure failure. wa_processed and wa_inbound_seen
-- stay for now - both are still load-bearing for concurrent-delivery dedupe.
create table if not exists public.wa_turns (
  wa_message_id  text primary key,
  user_email     text not null,
  from_number    text not null,
  trace_id       text not null,          -- correlation id, gateway -> send
  state          text not null,          -- 'claimed' | 'terminal'
  outcome        text,                   -- replied | deliberate-silence | vetoed
                                         -- | gate-dropped | infra-failed; null
                                         -- while still claimed
  outcome_detail text,
  attempts       int  not null default 0,
  lease_until    timestamptz not null,   -- expired + state='claimed' = orphan
  first_seen_at  timestamptz not null default now(),
  closed_at      timestamptz
);
-- The reconciler's only query: claimed turns whose lease lapsed, oldest first.
-- Partial so it stays small no matter how many turns have completed.
create index if not exists wa_turns_orphan_idx
  on public.wa_turns (lease_until) where state = 'claimed';
-- Owner-facing per-user turn history (the "did this shop ever get an answer"
-- question the doctor and the sweep both ask).
create index if not exists wa_turns_user_idx
  on public.wa_turns (user_email, first_seen_at desc);
alter table public.wa_turns enable row level security;

-- ---- Per-thread mutual exclusion (wa_thread_locks) ------------------------------
-- Nine claim mechanisms already exist and every one is keyed on something other
-- than the thread: the message id, the exact message text, a pacing bucket, a
-- tick window, an outbox row id. So two deliveries for one shop, or a wakeup
-- racing an inbound turn, both pass every existing gate and two messages go out
-- to the same shop seconds apart. This is the missing key.
-- `holder` is a per-acquire uuid and `fence` a monotonic token, so a stale
-- holder can neither release nor renew the current lease. Stealing requires
-- BOTH expires_at < now AND fence < now, which makes a backwards-skewed clock
-- fail to steal rather than issue a non-monotonic token - fail-closed by
-- construction. Postgres is the sole authority; Redis is only ever an advisory
-- negative cache, so the Cloud Run web tier (no REDIS_URL) still contends
-- correctly with the VM workers.
create table if not exists public.wa_thread_locks (
  thread_key  text primary key,          -- user_email:nationalTail (coarser than
                                         -- graph thread_key on purpose)
  holder      text not null,             -- randomUUID() per acquire
  fence       bigint not null,           -- epoch ms of acquire, monotonic
  acquired_at timestamptz not null default now(),
  expires_at  timestamptz not null,
  reason      text
);
-- Sweeping expired leases is the only scan this table ever takes.
create index if not exists wa_thread_locks_exp_idx
  on public.wa_thread_locks (expires_at);
alter table public.wa_thread_locks enable row level security;

-- ---- STATUS NOTE (added after a live audit) -------------------------------------
-- THE FOUR OBJECTS BELOW AND ABOVE SHIPPED AHEAD OF THEIR CODE, AND THE CODE
-- NEVER FOLLOWED. An audit of the live system found them created, indexed,
-- documented - and referenced by nothing in src/. Written down here because a
-- migration that looks applied is the least debuggable kind of dead code: the
-- DDL runs clean, the index exists, and the bug it describes stays fixed only
-- in the comment.
--
--   * wa_outbox.to_key       - NOW WRITTEN. Stamped at every insert site and
--                              used as parkOutboxOnce's scope (wa/park.ts,
--                              wa/phone-key.ts outboxKey). This is the one that
--                              was silently degrading the unique index back to
--                              exact-string matching.
--   * whatsapp_messages.dedupe_key - SUPERSEDED, not implemented. The race it
--                              describes is closed upstream by the atomic
--                              message-slot claim in wa_send_claims, which is
--                              taken BEFORE the network send rather than after
--                              it. A second mechanism keyed on the same event
--                              would be two sources of truth for one invariant.
--   * wa_turns               - SUPERSEDED by wa_processed + the thread turn
--                              claim (wa/turn-lock.ts).
--   * wa_thread_locks        - SUPERSEDED by the same claim namespace in
--                              wa_send_claims (turn:/umove:/to:/gap:).
--   * search_sessions        - already flagged dead above; the live SPTE takes
--                              a code-only approach.
--
-- Nothing is dropped: the columns are harmless, and dropping them is a
-- destructive migration for zero benefit. But no future reader should mistake
-- them for live mechanisms.

-- ---- Cause-keyed outbound dedupe (whatsapp_messages.dedupe_key) -----------------
-- whatsapp_messages has no unique constraint of any kind, and the outbound row
-- is written only AFTER the network send - so the guard's own dedup preflight
-- reads a table the concurrent writer has not written yet, and a duplicate
-- outbound row is physically legal. dedupe_key closes that gap by identifying
-- the CAUSE of a message rather than its text: "out:<threadLockKey>:<turnId>",
-- where turnId is the inbound message id, the wakeup id, the decision id, the
-- outbox row id or the RFQ batch+vendor. Keying on the cause is what makes it
-- correct - two humanized re-varations of one turn collide (they are the same
-- message), while two genuinely different causes never do (which content
-- hashing gets exactly backwards).
-- The row is inserted BEFORE the send with raw.state='sending'; a 409 here means
-- another turn already owns this cause and this one must abort without sending.
alter table public.whatsapp_messages add column if not exists dedupe_key text;
-- Partial so every historical row - and every row written by a send path not
-- yet migrated - stays legal with a null key.
create unique index if not exists whatsapp_messages_dedupe_uidx
  on public.whatsapp_messages (dedupe_key) where dedupe_key is not null;

-- ---- Consent ledger (consent_events) -------------------------------------------
-- A consent nobody recorded is a consent you cannot rely on when it matters.
-- The legal text and the mandatory checkboxes both existed; the PROOF did not.
-- app_users carries one timestamp per signup consent, which cannot answer the
-- three questions that actually come up: which VERSION did they agree to, did
-- they accept the WhatsApp release each time they linked a number, and did they
-- confirm the deal terms on THIS booking. Those are per-event facts and they
-- need rows, not columns.
--
-- Append-only by construction: nothing in the app updates or deletes a row here.
create table if not exists public.consent_events (
  id          bigint generated always as identity primary key,
  email       text not null,
  kind        text not null,          -- terms | wa_risk | ai_responsibility | wa_link | deal_terms
  version     text,                   -- the TERMS_VERSION in force at acceptance
  context     jsonb,                  -- vendor, number, booking - what was accepted ABOUT
  accepted_at timestamptz not null default now()
);
create index if not exists consent_events_email_idx
  on public.consent_events (email, accepted_at desc);
create index if not exists consent_events_kind_idx
  on public.consent_events (kind, accepted_at desc);
alter table public.consent_events enable row level security;

-- ---------------------------------------------------------------------------
-- OUTBOUND ERROR ACKS AND THE COLD HOLD (Tier 0.2)
--
-- WhatsApp's new-chat restriction arrives as a messages.update carrying
-- status:"ERROR" on a fromMe key. That signal was reaching our webhook and
-- being discarded, because the ingest only ever read READ and DELIVERY.
--
-- last_error_at records the refusal per recipient. cold_hold_until parks the
-- COLD lane only - replies keep flowing, because a reply is the one thing that
-- clears the unanswered-thread counter the restriction actually meters, and
-- halting it would deepen the exact condition being punished.
alter table public.wa_recipient_state
  add column if not exists last_error_at timestamptz;
alter table public.whatsapp_number_reputation
  add column if not exists cold_hold_until timestamptz;

-- ---------------------------------------------------------------------------
-- BLOCKS THAT ARE ACTUALLY BLOCKS, AND RECEIPT LIVENESS (Tier 0.75)
--
-- recordSendFailure classified "this number is not on WhatsApp" as a recipient
-- BLOCK. blocks_total scores +12 each toward a +30 ceiling on a 100-point risk
-- score that auto-pauses the account at 70, so three stale scraped numbers in
-- one batch could pause a perfectly healthy traveller's number for something no
-- recipient ever did. invalid_numbers_total gives that outcome its own home.
--
-- The receipt timestamps exist because delivered_total is a monotonic scalar
-- with no clock: 0 conflated "the MESSAGES_UPDATE webhook is dead" with "this
-- account is idle", so the meter could not go dark through the exact outage it
-- exists to catch.
alter table public.whatsapp_number_reputation
  add column if not exists invalid_numbers_total integer not null default 0;
alter table public.whatsapp_number_reputation
  add column if not exists last_delivery_receipt_at timestamptz;
alter table public.whatsapp_number_reputation
  add column if not exists last_read_receipt_at timestamptz;

-- ---------------------------------------------------------------------------
-- ONE ROW PER SHOP, WHATEVER SPELLING IT ARRIVES IN (Tier 1.0)
--
-- wa_recipient_state was keyed on the raw `to_number`, but the two sides of a
-- conversation spell the same shop differently: our send carries discovery's
-- form ("+66 81 234 5678" -> 66812345678) while the shop's reply carries
-- WhatsApp's. So a reply frequently landed on a DIFFERENT row than the send it
-- answered, and every reply-clearing rule wrote to a row nobody read.
--
-- `to_tail` is nationalTail() - country code and trunk prefix stripped, last 9
-- subscriber digits. Two spellings of one shop always agree on it; two
-- different shops effectively never do inside one traveller's threads. Same key
-- the tolerant numberFilter() already uses for reads.
alter table public.wa_recipient_state
  add column if not exists to_tail text;
create index if not exists wa_recipient_state_tail_idx
  on public.wa_recipient_state (sender_key, to_tail);

-- WRITE-ONCE conversation milestones. These are what make "unanswered" a fact
-- rather than a derivation over an unindexed JSON scan of whatsapp_messages,
-- and they are the denominator the introduction budget should have been using
-- all along: WhatsApp meters introductions that never got a reply, not
-- introductions sent.
alter table public.wa_recipient_state
  add column if not exists first_intro_at timestamptz;
alter table public.wa_recipient_state
  add column if not exists first_reply_at timestamptz;

-- "STOP MESSAGING ME" IS PERMANENT. Once stamped, guardOutbound refuses every
-- future send to this number from this sender - automated, manual, and any
-- later hunt that rediscovers the same shop. There is deliberately no unset
-- path in the product: a shop that asked to be left alone stays left alone.
alter table public.wa_recipient_state
  add column if not exists opted_out_at timestamptz;

-- The open-thread query: this sender's introductions that have not been
-- answered. Partial, so it stays small no matter how much history accrues.
create index if not exists wa_recipient_state_unanswered_idx
  on public.wa_recipient_state (sender_key, first_intro_at desc)
  where first_reply_at is null;

-- ---- The warm-up gate -------------------------------------------------------
-- A paid plan cannot be BOUGHT until the account has done enough real work for
-- us to know Premium fits (src/lib/warmup.ts). These two columns are the only
-- storage it needs; every term of the predicate is computed from tables that
-- already exist (search_sessions, wa_recipient_state, wa_sessions).
--
-- `warmed_up_at` is WRITE-ONCE. Moving a threshold later must not un-warm
-- somebody who already crossed the line, and re-stamping would destroy
-- time-to-warm - the one measure that says whether the thresholds are set
-- correctly. The write filters on `warmed_up_at is null` so the database
-- enforces that rather than the caller remembering to.
alter table public.app_users add column if not exists warmed_up_at timestamptz;

-- The predicate AS IT STOOD at unlock, so a later threshold change does not
-- silently rewrite history on the cohort charts.
alter table public.app_users add column if not exists warmup_snapshot jsonb;

-- The monetization dashboard's spine: "who warmed up, and when". Partial, so it
-- indexes the converted population rather than every signup.
create index if not exists app_users_warmed_idx
  on public.app_users (warmed_up_at desc)
  where warmed_up_at is not null;

-- ---- The business-number handoff (plan Part 12) -----------------------------
-- Our official WhatsApp Business number sends the FIRST message to an agency;
-- the agency then messages the traveller directly; our ingest detects that
-- inbound and the AI agents take over from the traveller's own number.
--
-- Nothing below is read while WABA_ENABLED is off, which is the default. These
-- tables exist so the pipeline is buildable and testable ahead of credentials.

-- One row per handoff attempt: the state machine, both parties, and every
-- timestamp the console renders. `link_tapped_at` is the most valuable column
-- here - it is the only per-agency engagement signal in the whole product that
-- does not depend on someone replying.
create table if not exists public.waba_leads (
  id             bigint generated always as identity primary key,
  state          text not null default 'draft',
  user_email     text not null,
  agency_tail    text not null,          -- nationalTail(), same key as wa_recipient_state
  agency_number  text not null,
  agency_name    text,
  session_id     uuid,
  lane           text,                   -- template | freeform
  template_name  text,
  link_token     text unique,
  created_at     timestamptz not null default now(),
  sent_at        timestamptz,
  delivered_at   timestamptz,
  read_at        timestamptz,
  link_tapped_at timestamptz,
  agency_replied_at   timestamptz,       -- to US, on the business number
  traveller_inbound_at timestamptz,      -- the agency messaged the TRAVELLER
  handed_off_at  timestamptz,            -- terminal: agents take over
  terminal_reason text,
  error_code     int,
  preview        text                    -- exact wire text, for diagnosis later
);
-- The provider's message id, so a delivery/read/failed status can find its lead.
alter table public.waba_leads add column if not exists provider_message_id text;
create index if not exists waba_leads_msgid_idx on public.waba_leads (provider_message_id);
create index if not exists waba_leads_user_idx on public.waba_leads (user_email, created_at desc);
create index if not exists waba_leads_agency_idx on public.waba_leads (agency_tail, created_at desc);
-- The hold queue: leads waiting for an agency to open its service window.
create index if not exists waba_leads_open_idx on public.waba_leads (state, created_at)
  where handed_off_at is null;
alter table public.waba_leads enable row level security;

-- Per-agency messaging state. KEYED ON THE PHONE TAIL, reusing nationalTail() -
-- re-splitting rows across phone spellings here would reproduce the exact bug
-- the recipient ledger was just fixed for, and the cooldown below is the single
-- most load-bearing value in the design: error 131049 caps a recipient at ~2
-- marketing templates per 24h across ALL businesses, and our ranking sends every
-- traveller in a district to the same top agencies.
create table if not exists public.waba_agencies (
  agency_tail          text primary key,
  agency_number        text,
  agency_name          text,
  window_expires_at    timestamptz,      -- service window: free-form until this
  template_capped_until timestamptz,     -- set on 131049; do NOT retry before
  last_template_at     timestamptz,
  sent_total           int not null default 0,
  delivered_total      int not null default 0,
  read_total           int not null default 0,
  tapped_total         int not null default 0,
  replied_total        int not null default 0,
  updated_at           timestamptz not null default now()
);
create index if not exists waba_agencies_window_idx on public.waba_agencies (window_expires_at desc);
alter table public.waba_agencies enable row level security;

-- Append-only wire log. This is what makes a failed handoff diagnosable a week
-- later, when the only question anyone asks is "what did we actually send them".
create table if not exists public.waba_events (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  lead_id     bigint,
  agency_tail text,
  kind        text not null,             -- send | delivery | read | tap | inbound | error
  error_code  int,
  raw         jsonb
);
create index if not exists waba_events_lead_idx on public.waba_events (lead_id, at desc);
create index if not exists waba_events_at_idx on public.waba_events (at desc);
alter table public.waba_events enable row level security;

-- The fourth consent: sharing the traveller's own number with a rental agency
-- so that agency can message them (plan Part 12.9 item 9). New personal-data
-- disclosure, so it is recorded separately rather than folded into the terms.
alter table public.app_users add column if not exists number_sharing_accepted_at timestamptz;

-- ---------------------------------------------------------------------------
-- TIER 3 OBSERVABILITY (plan Part 9.7): the append-only risk ledger.
--
-- Every safety signal today is a MUTABLE SCALAR on one whatsapp_number_reputation
-- row per user, overwritten on every send. After a restriction you can read what
-- the counters are now and nothing at all about the preceding 72 hours - so
-- there is no numerator, no denominator, and no rate to be 99% of.
--
-- Append-only, one row per event, never updated, never re-derived. `axis` is
-- stored rather than computed at read time because the two enforcement axes have
-- different penalties and different observability, and a query that has to join
-- a vocabulary table to tell them apart will eventually stop bothering.
--
-- config_fingerprint is the one column that makes fleet-correlated (axis 2) risk
-- analysable at all: where a single Meta rule keys on a shared config, the
-- effective sample size across the fleet is 1, and without this stamp a config
-- change and its consequences cannot be told apart afterwards.
create table if not exists public.wa_risk_events (
  id                 bigint generated always as identity primary key,
  at                 timestamptz not null default now(),
  sender_key         text not null,
  kind               text not null,   -- see RISK_KINDS in src/lib/wa/risk-events.ts
  axis               text not null,   -- velocity | client | meter | policy
  to_key             text,
  detail             jsonb,
  config_fingerprint text,
  policy_version     text
);
-- Descending on time: the window queries that matter want the MOST RECENT rows,
-- and the ledger this replaces was capped ascending - so past its limit it kept
-- the oldest week-prefix and discarded exactly the diagnostic tail.
create index if not exists wa_risk_events_sender_idx
  on public.wa_risk_events (sender_key, at desc);
create index if not exists wa_risk_events_axis_idx on public.wa_risk_events (axis, at desc);
create index if not exists wa_risk_events_kind_idx on public.wa_risk_events (kind, at desc);
alter table public.wa_risk_events enable row level security;

-- Hourly rollup, so the dashboard reads a handful of rows regardless of fleet
-- size. /api/activity is the counter-example already in this repo: ~21 Supabase
-- round trips per tick, and at fleet scale a live fan-out monitor becomes the
-- load it monitors.
--
-- dark_signals[] and truncated_signals[] are what make empty-state rules E1 and
-- E9 reconstructable after the fact. A bucket that could not be read must be
-- distinguishable from a bucket in which nothing happened, forever - not just
-- while the incident is live.
create table if not exists public.wa_risk_snapshots (
  bucket             timestamptz primary key,
  computed_at        timestamptz not null default now(),
  accounts           int not null default 0,
  counts             jsonb,           -- {kind: n}
  dark_signals       text[],
  truncated_signals  text[],
  -- One reading per Evolution instance: {instance: {state, messages}}.
  --
  -- A DEAF SESSION IS ONLY VISIBLE ACROSS TWO SAMPLES. `looksDeaf`
  -- (wa/fleet-truth) is a pure function of a PRIOR and a CURRENT reading: an
  -- instance that says `open`, that Evolution still lists, and whose message
  -- count has not moved while we were actively sending. There is no way to see
  -- that in one sample, so the hourly rollup carries its own reading forward.
  -- Nullable and read defensively - a deployment that has not run this
  -- migration simply reports the detector as dark, never as "no deaf
  -- instances".
  fleet              jsonb
);
alter table public.wa_risk_snapshots add column if not exists fleet jsonb;
create index if not exists wa_risk_snapshots_bucket_idx
  on public.wa_risk_snapshots (bucket desc);
alter table public.wa_risk_snapshots enable row level security;

-- Anti-ban policy changes as versioned rows with an author and a diff.
--
-- Part 5.9's inversion, stated plainly: negotiation policy is versioned,
-- golden-replay gated and one-click rollbackable, and its worst case is a bad
-- haggle - while whatsapp_security_policies took a bare upsert from any
-- management session with no version, no audit and no undo, and its worst case
-- is a traveller losing their personal WhatsApp. Without this table no
-- before/after comparison on the risk dashboard means anything, which is the
-- entire point of building the dashboard.
create table if not exists public.wa_policy_versions (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  version      text not null,
  author_email text,
  changes      jsonb,
  note         text
);
create index if not exists wa_policy_versions_at_idx
  on public.wa_policy_versions (created_at desc);
alter table public.wa_policy_versions enable row level security;

-- ---- M20 / I-7: why a provider failed, not just that it did -----------------
--
-- `ai_usage` recorded provider/tokens/failed. The REASON - `errorDetail`'s
-- trimmed "<provider> <status> - <body>" - was thrown, caught into a local
-- array in chatDetailed, and discarded, so the Command Center could report
-- Cerebras failing 14 of 14 calls while nothing anywhere could say it was a
-- 400 on a renamed model id.
--
-- `model` is the id that actually went on the wire, which is not always the
-- configured one: callProvider retries on `fallbackModel` for a 400/404.
alter table public.ai_usage add column if not exists model text;
alter table public.ai_usage add column if not exists detail text;

-- Reading the last failure per provider is the whole query this exists for.
create index if not exists ai_usage_failed_idx
  on public.ai_usage (provider, created_at desc)
  where failed;

-- ---- The anon Data API must never reach a SECURITY DEFINER prune ------------
--
-- `prune_old_rows` is created by supabase/retention.sql, and PostgreSQL grants
-- EXECUTE on a new function to PUBLIC by default - which Supabase publishes
-- over PostgREST to `anon`, the key that ships inside every browser. That is a
-- one-request wipe of agent_events / agent_traces / whatsapp_messages by anyone
-- who views the site. retention.sql now revokes it as part of creating it; this
-- block is here because THIS is the file every owner is told to run, and told
-- to re-run after every update. A database repaired here cannot un-repair
-- itself by running the files in the wrong order.
--
-- Guarded on existence so it is a clean no-op before retention.sql has ever run,
-- and safe to re-run for ever.
do $$
begin
  if exists (
    select 1 from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'prune_old_rows'
  ) then
    revoke all on function public.prune_old_rows(int) from public;
    revoke all on function public.prune_old_rows(int) from anon;
    revoke all on function public.prune_old_rows(int) from authenticated;
    grant execute on function public.prune_old_rows(int) to service_role;
    raise notice 'prune_old_rows locked down: service_role only.';
  else
    raise notice 'prune_old_rows does not exist yet - run supabase/retention.sql (it creates AND locks it).';
  end if;
end;
$$;

-- ---- The funnel stage ledger (src/lib/funnel/stages.ts) ---------------------
--
-- `stage` is the thread's CURRENT funnel stage - the single vocabulary the
-- traveller tracker, the Ops console and analytics all read, advanced only by
-- advanceThreadStage() (forward-only + terminal refusal enforced in the PATCH
-- filter, never read-then-write). Transition HISTORY is append-only in
-- agent_events kind='funnel-stage' (join columns user_email/to_number/
-- vendor_id/decision_id; detail JSON carries {from,to,evidence,transport,
-- engine,entry}). `stage_at` is when the current stage was entered - dwell
-- times come from the event history, this is just the cheap "since when" the
-- tracker shows without an events query.
alter table public.negotiation_threads add column if not exists stage text;
alter table public.negotiation_threads add column if not exists stage_at timestamptz;
create index if not exists negotiation_threads_stage_idx
  on public.negotiation_threads (user_email, stage);

-- ---- The booking lifecycle (src/lib/bookings.ts) ----------------------------
--
-- `status` grows a real vocabulary: confirmed -> deposit_pending ->
-- deposit_settled|deposit_waived -> picked_up -> completed, terminals
-- cancelled / no_show. Advanced ONLY by advanceBooking() (forward-only +
-- terminal refusal + ownership in the PATCH filter); history is append-only in
-- agent_events kind='booking-stage'. The doctrine: the funnel never asserts
-- what nobody witnessed - picked_up/completed come from traveller taps, and
-- the schedule timeout only ever SUGGESTS completion (completion_suggested_at
-- throttles that push to once per booking). thread_key joins the money record
-- to the negotiation that produced it.
alter table public.bookings add column if not exists deposit_status text;
alter table public.bookings add column if not exists deposit_amount numeric;
alter table public.bookings add column if not exists deposit_currency text;
alter table public.bookings add column if not exists picked_up_at timestamptz;
alter table public.bookings add column if not exists completed_at timestamptz;
alter table public.bookings add column if not exists cancelled_at timestamptz;
alter table public.bookings add column if not exists cancel_reason text;
alter table public.bookings add column if not exists thread_key text;
alter table public.bookings add column if not exists completion_suggested_at timestamptz;

-- waba_leads joins the real conversation spine: thread_key (user_email:digits)
-- replaces the dead search_sessions uuid as the lead's join to
-- negotiation_threads / whatsapp_messages. Stamped by the WABA dispatch when
-- the takeover leg wires up (Wave 6); additive and null until then.
alter table public.waba_leads add column if not exists thread_key text;

-- The webhook re-arm's shared clock (src/lib/evolution reassertWebhook) lives
-- on the instance's own session row now - the old per-instance WH_REARM_*
-- app_config rows polluted the owner's Key Vault, and the clock advanced even
-- on a FAILED set (throttling a broken re-arm into staying broken for an
-- hour). Stamped only on a verified outcome.
alter table public.wa_sessions add column if not exists webhook_rearmed_at timestamptz;

-- ---- WABA compliance + ledger completion (Wave 6) ---------------------------
--
-- opted_in_at: the Meta-policy gate. A cold template may only go to a shop
-- that opted in to WheelDeal leads (QR/wa.me inbound to the WABA, or the
-- partner form); admitLead fails CLOSED on this - an un-migrated or unreadable
-- store refuses the lane and Evolution stays the path.
alter table public.waba_agencies add column if not exists opted_in_at timestamptz;
-- dry_run: a rehearsal is not a send - persisted so the governor, cooldowns
-- and every count can exclude it.
alter table public.waba_leads add column if not exists dry_run boolean;
-- fallback: rung 4's payload - the composed opener + rfq captured at HOLD
-- time, so a hold that times out can re-dispatch the traveller's real message
-- on their own wire (a held lead has no anchor row; nothing was ever sent).
alter table public.waba_leads add column if not exists fallback jsonb;

-- ---- Fleet-wide shop suppression (owner decision: opt-out is fleet-wide) ----
--
-- A shop that asked to stop hearing from WheelDeal asked WheelDeal, not one
-- traveller. Keyed on the national number tail (same canonical key as the
-- recipient ledger and waba_agencies); consulted by guardOutbound's cold gate,
-- mass outreach admission and the WABA admitLead.
create table if not exists public.wa_suppressions (
  number_tail text primary key,
  number      text,
  reason      text,
  source      text,               -- stop-intent | owner | wrong-number
  created_at  timestamptz not null default now()
);
alter table public.wa_suppressions enable row level security;

-- ---- Session revocation horizon (Wave 9) ------------------------------------
--
-- A password change, a block, an erasure or "Sign out everywhere" moves this
-- timestamp to now; getSession rejects any cookie whose issuedAt predates it.
-- Without it, revocation only reached the one browser that performed the
-- action - every other device kept a valid 30-day cookie.
alter table public.app_users add column if not exists sessions_valid_from timestamptz;
