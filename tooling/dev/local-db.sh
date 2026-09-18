#!/usr/bin/env bash
# LOCAL DEVELOPMENT DATABASE - one command, idempotent, never production.
#
# The app is honest about a missing store rather than crashing, so without a
# database the whole funnel "works" and records nothing: threads are never
# created, offers are never banked, and the engine has no state to reason over.
# That is why dev mode starts with a real Postgres + PostgREST rather than
# demo mode.
#
# Two things here are easy to lose a day to, so they are automated:
#
#  1. GRANTS. On Supabase cloud, new tables are granted to service_role by an
#     event trigger that does not run against a locally applied schema. Without
#     it every single read answers `permission denied for table ...` - which the
#     app correctly reports as "store unreadable", so the symptom is an app that
#     looks fine and stores nothing.
#  2. THE SCHEMA CACHE. PostgREST reads the schema once at boot. Tables created
#     after it started are invisible until it is told to look again.
#
# Usage:  ./tooling/dev/local-db.sh          (start + apply + grant)
#         ./tooling/dev/local-db.sh reset    (wipe every row, keep the schema)
set -euo pipefail

cd "$(dirname "$0")/../.."
CONTAINER="supabase_db_$(basename "$PWD")"

psql_run() { docker exec -i "$CONTAINER" psql -U postgres -d postgres -q "$@"; }

if [ "${1:-}" = "reset" ]; then
  echo "Truncating every public table (schema kept)..."
  psql_run -t -c "
    do \$\$
    declare r record;
    begin
      for r in select tablename from pg_tables where schemaname = 'public' loop
        execute format('truncate table public.%I cascade', r.tablename);
      end loop;
    end \$\$;"
  echo "Local database is empty again."
  exit 0
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running. Starting OrbStack..."
  open -a OrbStack 2>/dev/null || open -a Docker 2>/dev/null || true
  until docker info >/dev/null 2>&1; do sleep 2; done
fi

if [ ! -f supabase/config.toml ]; then
  supabase init --force
fi

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "Starting the local Supabase stack (first run pulls images)..."
  supabase start --yes -x studio,inbucket,imgproxy,edge-runtime,realtime,storage,analytics,vector,functions
fi

echo "Applying schema.sql, perf-indexes.sql, retention.sql..."
for f in schema perf-indexes retention; do
  psql_run -v ON_ERROR_STOP=0 < "supabase/$f.sql" > /dev/null 2>&1 || true
done

echo "Granting service_role (local only - cloud does this for you)..."
psql_run <<'SQL' > /dev/null
grant usage on schema public to service_role;
grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
notify pgrst, 'reload schema';
SQL

TABLES=$(psql_run -t -c "select count(*) from information_schema.tables where table_schema='public';" | tr -d ' ')
echo "Local database ready: ${TABLES} tables."
echo
echo "Put these in .env.local (values from: supabase status -o env):"
echo "  SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL = API_URL"
echo "  SUPABASE_SERVICE_ROLE_KEY               = SERVICE_ROLE_KEY"
echo "  NEXT_PUBLIC_SUPABASE_ANON_KEY           = ANON_KEY"
