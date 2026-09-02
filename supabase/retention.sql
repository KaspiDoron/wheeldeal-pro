-- WheelDeal - data retention (owner report 4, scale #4). Run ONCE in the
-- Supabase SQL editor. Idempotent: safe to re-run, and safe to run before
-- pg_cron is enabled (the schedule block degrades to a no-op with a NOTICE).
--
-- WHY THIS EXISTS. Four tables grow without bound on the live path and were the
-- top row-growth risk at launch scale:
--   - whatsapp_messages : every inbound/outbound frame (the biggest by far)
--   - agent_events      : holds, drops, latency, read/presence receipts, ...
--   - agent_traces      : per-decision reasoning rows (several per turn)
--   - api_usage         : one row per provider call, for the cost tracker
-- At hundreds of users these accumulate millions of rows a month, which slows
-- every hot-path query that scans by created_at and inflates the DB bill.
--
-- WHAT IS KEPT. 90 days of operational history is plenty for the Ops center,
-- the message-path tracer and incident forensics. Two things are NEVER pruned:
--   - PRICED whatsapp_messages rows (raw->>'reading' present, or a stamped
--     offer): a board photographed once is cross-thread leverage for the whole
--     search session, and the golden suite freezes real conversations.
--   - api_usage is ROLLED UP to a daily total per (kind, day) before its raw
--     rows are pruned, so the cost tracker keeps its history at 1/1000th the
--     rows.
--
-- Everything here is bounded and re-entrant; it removes only rows older than
-- the window, and only from these four tables.

-- ---------------------------------------------------------------------------
-- 1. Monthly rollup target for api_usage (keeps cost history, drops the rows).
-- ---------------------------------------------------------------------------
create table if not exists public.api_usage_daily (
  day        date not null,
  kind       text not null,
  total      bigint not null default 0,
  primary key (day, kind)
);
alter table public.api_usage_daily enable row level security;

-- ---------------------------------------------------------------------------
-- 2. The prune function. One transaction, bounded, idempotent.
-- ---------------------------------------------------------------------------
create or replace function public.prune_old_rows(retain_days int default 90)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  -- THREE WINDOWS, because "how long is this needed" differs by what it is:
  --   cutoff      (90d)  - operational exhaust: events, traces, turns, risk
  --   cutoff_mid  (180d) - session context a stale hunt might still lean on:
  --                        threads, replies, sessions, auth trail
  --   cutoff_long (360d) - USER-VISIBLE history: searches and offers feed the
  --                        Trips restore flow, which deliberately has no date
  --                        bound in the app - pruning these early would eat a
  --                        traveller's own history out from under the UI.
  cutoff      timestamptz := now() - make_interval(days => retain_days);
  cutoff_mid  timestamptz := now() - make_interval(days => retain_days * 2);
  cutoff_long timestamptz := now() - make_interval(days => retain_days * 4);
  msgs   bigint := 0;
  deident bigint := 0;
  events bigint := 0;
  traces bigint := 0;
  usage_rows bigint := 0;
  others jsonb := '{}'::jsonb;
  n bigint;
begin
  -- api_usage: roll up to the daily table FIRST, then prune the raw rows.
  insert into public.api_usage_daily (day, kind, total)
  select date_trunc('day', created_at)::date as day, kind, sum(count)::bigint
    from public.api_usage
   where created_at < cutoff
   group by 1, 2
  on conflict (day, kind) do update set total = public.api_usage_daily.total + excluded.total;

  delete from public.api_usage where created_at < cutoff;
  get diagnostics usage_rows = row_count;

  -- whatsapp_messages, in two honest steps.
  --
  -- L6 (owner report 6): the englishGloss exemption is GONE. Every localized
  -- outbound carries a gloss, so in the app's core markets (Thai, Vietnamese,
  -- Indonesian threads) that clause exempted essentially every message the
  -- agent ever sent - the prune was defeated exactly where the volume is.
  --
  -- W9: the priced-row exemption is no longer "keep the whole row forever".
  -- A priced row's lasting value is the READING (vehicle/price extraction) and
  -- the outcome - the deal_memory shape - not WHO said it or the words used.
  -- Past the mid window the row is DE-IDENTIFIED in place: body nulled, the
  -- traveller's email stripped out of raw, the shop's number dropped. The
  -- pricing evidence stays; the person leaves.
  delete from public.whatsapp_messages
   where received_at < cutoff
     and (raw ->> 'reading') is null
     and coalesce((raw ->> 'ok')::text, '') <> 'priced';
  get diagnostics msgs = row_count;

  update public.whatsapp_messages
     set body = null,
         from_number = case when direction = 'inbound' then 'deidentified' else from_number end,
         to_number   = case when direction = 'outbound' then 'deidentified' else to_number end,
         raw = (raw - 'sender' - 'receiver' - 'english' - 'gloss' - 'pushName'
                    - 'remoteJid' - 'participant')
               || jsonb_build_object('deidentified_at', now())
   where received_at < cutoff_mid
     and (raw ->> 'deidentified_at') is null
     and ((raw ->> 'reading') is not null
          or coalesce((raw ->> 'ok')::text, '') = 'priced');
  get diagnostics deident = row_count;

  -- THE PAYMENT TRAIL IS NOT OPERATIONAL EXHAUST.
  --
  -- `subscription-activated` rows are the ONLY record in this system that both
  -- means money changed hands (PayPal was asked server-side with the secret)
  -- and names the payer - billing_events has no user_email column at all. This
  -- blanket delete destroyed them at 90 days, which silently (a) moved every
  -- customer older than a quarter from Paid to Comped on the monetization
  -- panel, and (b) disarmed the PayPal reconcile sweep, whose activationsFor()
  -- then returns [] and classifies the account "unknown" forever.
  --
  -- The subscription lifecycle kinds are kept for the LONG window alongside the
  -- other user-visible history. They are a handful of rows per paying customer,
  -- not exhaust.
  delete from public.agent_events
   where created_at < cutoff
     and kind not in ('subscription-activated', 'subscription-suspended',
                      'subscription-resumed');
  get diagnostics events = row_count;

  delete from public.agent_events
   where created_at < cutoff_long
     and kind in ('subscription-activated', 'subscription-suspended',
                  'subscription-resumed');
  get diagnostics n = row_count; others := others || jsonb_build_object('billing_events_pruned', n);

  delete from public.agent_traces where created_at < cutoff;
  get diagnostics traces = row_count;

  -- W9: the tables the first version never touched. Each line names its window.
  delete from public.wa_turns where first_seen_at < cutoff;
  get diagnostics n = row_count; others := others || jsonb_build_object('wa_turns', n);

  delete from public.wa_risk_events where at < cutoff;
  get diagnostics n = row_count; others := others || jsonb_build_object('wa_risk_events', n);

  delete from public.bargain_drafts where created_at < cutoff;
  get diagnostics n = row_count; others := others || jsonb_build_object('bargain_drafts', n);

  delete from public.graph_wakeups where created_at < cutoff;
  get diagnostics n = row_count; others := others || jsonb_build_object('graph_wakeups', n);

  -- Keyed on updated_at (the table has no created_at): a thread QUIET for the
  -- whole mid window is gone; one the traveller re-engaged stays.
  delete from public.negotiation_threads where updated_at < cutoff_mid;
  get diagnostics n = row_count; others := others || jsonb_build_object('negotiation_threads', n);

  delete from public.vendor_replies where created_at < cutoff_mid;
  get diagnostics n = row_count; others := others || jsonb_build_object('vendor_replies', n);

  delete from public.search_sessions where created_at < cutoff_mid;
  get diagnostics n = row_count; others := others || jsonb_build_object('search_sessions', n);

  -- THE SEMANTIC SIDECAR, AND THE ONE GUARDED DELETE IN THIS FUNCTION.
  --
  -- corpus_embeddings is created ONLY inside schema.sql's pg_extension branch,
  -- so on a database without pgvector it does not exist. A bare
  -- `delete from public.corpus_embeddings` would raise "relation does not
  -- exist" AT EXECUTION and abort this whole function - stopping retention for
  -- every other table at once, and turning the health panel's retention tile
  -- red with no clue why. A privacy regression caused by a privacy feature.
  --
  -- Dynamic SQL is what makes it safe: plpgsql resolves a statement when it
  -- runs it, and `execute` is never parsed against the catalogue at all, so
  -- the missing relation is simply never looked up.
  --
  -- The window is cutoff_mid (180d), at or inside every source's own window -
  -- the sidecar copies text and must never EXTEND the retention horizon of
  -- what it copies. And it lives in this function rather than a separate
  -- sweeper for the reason stated at the top of this file: the body is a fixed
  -- list, so a table not named here is never pruned at all.
  if to_regclass('public.corpus_embeddings') is not null then
    execute 'delete from public.corpus_embeddings where created_at < $1' using cutoff_mid;
    get diagnostics n = row_count; others := others || jsonb_build_object('corpus_embeddings', n);
  end if;

  delete from public.auth_events where created_at < cutoff_mid;
  get diagnostics n = row_count; others := others || jsonb_build_object('auth_events', n);

  delete from public.waba_events where at < cutoff_mid;
  get diagnostics n = row_count; others := others || jsonb_build_object('waba_events', n);

  -- response_times holds bare shop numbers with no owner: hash what remains
  -- (md5 keeps the fast-responder lookup working - the reader hashes its probe
  -- the same way) and drop old samples entirely.
  delete from public.response_times where created_at < cutoff_mid;
  get diagnostics n = row_count; others := others || jsonb_build_object('response_times', n);
  update public.response_times set phone = md5(phone) where phone !~ '^[0-9a-f]{32}$';
  get diagnostics n = row_count; others := others || jsonb_build_object('response_times_hashed', n);

  -- Transient auth material: expired verification/reset rows and cooldowns.
  delete from public.email_verifications where expires_at < now() - interval '7 days';
  get diagnostics n = row_count; others := others || jsonb_build_object('email_verifications', n);

  delete from public.user_cooldowns where until < now() - interval '30 days';
  get diagnostics n = row_count; others := others || jsonb_build_object('user_cooldowns', n);

  -- The consented analytics projection ages out with the long window too - a
  -- year of funnel history is plenty for any product question it can answer.
  delete from public.product_events where occurred_at < cutoff_long;
  get diagnostics n = row_count; others := others || jsonb_build_object('product_events', n);

  -- USER-VISIBLE history last, on the long window (Trips restore reads these
  -- with no date bound; a year-old hunt is stale enough to let go).
  delete from public.offers where created_at < cutoff_long;
  get diagnostics n = row_count; others := others || jsonb_build_object('offers', n);

  delete from public.searches where created_at < cutoff_long;
  get diagnostics n = row_count; others := others || jsonb_build_object('searches', n);

  -- DELIBERATELY NOT PRUNED: bookings (the traveller's own record of real
  -- rentals), consent_events (proof of consent for the life of the account -
  -- erased with the account by the erasure registry), deal_memory (already
  -- de-identified), wa_sessions / push_subscriptions / wa_recipient_state /
  -- whatsapp_number_reputation (live operational state), game_scores (tiny).

  -- HEARTBEAT: one agent_events row per run, so the app can OBSERVE that
  -- retention is actually scheduled and running (pg_cron degrades to a NOTICE
  -- nobody reads when it is missing). The admin health panel reads the newest
  -- 'retention-ran' row; older heartbeats are pruned with agent_events above.
  insert into public.agent_events (kind, detail)
  values ('retention-ran', jsonb_build_object(
    'cutoff', cutoff,
    'whatsapp_messages_deleted', msgs,
    'whatsapp_messages_deidentified', deident,
    'agent_events_deleted', events,
    'agent_traces_deleted', traces,
    'api_usage_rolled_and_deleted', usage_rows,
    'other_tables', others
  )::text);

  return jsonb_build_object(
    'cutoff', cutoff,
    'whatsapp_messages_deleted', msgs,
    'whatsapp_messages_deidentified', deident,
    'agent_events_deleted', events,
    'agent_traces_deleted', traces,
    'api_usage_rolled_and_deleted', usage_rows,
    'other_tables', others
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. LOCK THE FUNCTION DOWN. This is part of creating it - not a separate file.
-- ---------------------------------------------------------------------------
--
-- `prune_old_rows` is SECURITY DEFINER: it runs with the privileges of its
-- OWNER, not of the caller. PostgreSQL grants EXECUTE on a new function to
-- PUBLIC by default, and Supabase exposes every function in the `public` schema
-- over PostgREST RPC to the `anon` and `authenticated` roles. The anon key
-- ships to every browser. So without the four lines below, ANYONE could call
--   POST /rest/v1/rpc/prune_old_rows  { "retain_days": 0 }
-- and wipe agent_events, agent_traces and the un-priced whatsapp_messages as
-- the definer, straight past every RLS policy this schema relies on.
--
-- THEY LIVE HERE, IMMEDIATELY AFTER THE CREATE, ON PURPOSE. They shipped first
-- as a separate supabase/security-fix.sql, which meant the file that creates
-- the hole was the one owners were told to run and the file that closes it was
-- referenced nowhere - so every fresh deployment got the vulnerable function and
-- never the patch. A fix in a file nobody runs is not a fix. `create or replace`
-- above preserves whatever grants already exist, so re-running this file on an
-- older database repairs it; running it on a new one never opens the hole at
-- all. pg_cron is unaffected (it runs as a superuser, not through PostgREST),
-- and the app calls it - if it ever does - with the service_role key.
revoke all on function public.prune_old_rows(int) from public;
revoke all on function public.prune_old_rows(int) from anon;
revoke all on function public.prune_old_rows(int) from authenticated;
grant execute on function public.prune_old_rows(int) to service_role;

-- Prove it, in the same transcript the owner is already reading. `has_function_privilege`
-- is the database's own answer, not a comment claiming the lines above worked.
do $$
begin
  if has_function_privilege('anon', 'public.prune_old_rows(int)', 'execute')
     or has_function_privilege('authenticated', 'public.prune_old_rows(int)', 'execute') then
    raise exception
      'prune_old_rows is STILL callable by anon/authenticated - the revoke did not take. Do not leave the database in this state.';
  end if;
  raise notice 'prune_old_rows is service_role-only: the anon/authenticated Data API cannot call it.';
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Schedule it nightly via pg_cron when available; a clean NOTICE otherwise.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    -- Unschedule a prior copy so a re-run does not stack duplicate jobs.
    perform cron.unschedule(jobid)
      from cron.job where jobname = 'wheeldeal-prune-nightly';
    perform cron.schedule(
      'wheeldeal-prune-nightly',
      '17 3 * * *',                        -- 03:17 UTC daily, off the hour
      $cron$ select public.prune_old_rows(90); $cron$
    );
    raise notice 'Scheduled wheeldeal-prune-nightly (03:17 UTC).';
  else
    raise notice 'pg_cron not installed - enable it (Supabase: Database -> Extensions) then re-run this file, OR call select public.prune_old_rows(90); on your own schedule.';
  end if;
end;
$$;
