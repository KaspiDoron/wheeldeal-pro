#!/usr/bin/env bash
#
# STAND UP ONE EVOLUTION LANE. Run this on a fresh host, once.
#
#   curl -fsSL https://raw.githubusercontent.com/KaspiDoron/wheeldeal-pro/master/deploy/fleet/setup.sh | bash -s -- --prefixes 66,84,855 --cap 50
#
# ...or, from a clone:  cd deploy/fleet && ./setup.sh --prefixes 66,84 --cap 50
#
# It installs Docker if missing, generates a UNIQUE key + DB password for THIS
# host, brings the compose lane up, and prints the exact EVOLUTION_HOSTS line to
# paste into Admin -> Keys. It does NOT touch an existing .env - re-running is
# safe and keeps the host's identity, because regenerating the key would orphan
# every WhatsApp session already linked to this box.
#
# See README.md for which lane to build first and what cap to give it.

set -euo pipefail

PREFIXES=""
CAP=""
PUBLIC_URL=""
TUNNEL=0

usage() {
  cat <<'USAGE'
Usage: setup.sh [options]

  --prefixes 66,84,855   Calling codes this host is geographically right for.
                         Omit for a region-neutral host.
  --cap 50               How many linked numbers this host may carry.
                         Omit to use the fleet default (EVOLUTION_MAX_PER_HOST).
  --url https://sg.x.com The public HTTPS URL, if you already have one.
  --tunnel               Start a free Cloudflare quick tunnel and use its URL.
  -h, --help             This message.

The suggested caps per lane are in README.md. They are STARTING POINTS scaled
from one measured box - raise a cap only after watching a host hold its current
one.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --prefixes) PREFIXES="${2:-}"; shift 2 ;;
    --cap)      CAP="${2:-}"; shift 2 ;;
    --url)      PUBLIC_URL="${2:-}"; shift 2 ;;
    --tunnel)   TUNNEL=1; shift ;;
    -h|--help)  usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

say() { printf '\n== %s\n' "$*"; }

# The compose file lives next to this script. When piped from curl there is no
# script directory to speak of, so fetch the lane into a working copy instead.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/docker-compose.yml" ]; then
  WORK="$SCRIPT_DIR"
else
  WORK="${HOME}/wheeldeal-evolution"
  mkdir -p "$WORK"
  say "Fetching the lane definition into $WORK"
  curl -fsSL -o "$WORK/docker-compose.yml" \
    https://raw.githubusercontent.com/KaspiDoron/wheeldeal-pro/master/deploy/fleet/docker-compose.yml
fi
cd "$WORK"

# ---------------------------------------------------------------- docker ----
if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker"
  curl -fsSL https://get.docker.com | sh
  # Oracle and Azure images ship firewalld/iptables rules that drop Docker's
  # published ports. Nothing here opens a port to the internet - the tunnel
  # below is what exposes the lane - but the local bind still has to work.
  sudo systemctl enable --now docker >/dev/null 2>&1 || true
fi
DC="docker compose"
docker compose version >/dev/null 2>&1 || DC="docker-compose"

# ------------------------------------------------------------------- env ----
# NEVER regenerate over an existing .env. The API key is this host's identity:
# rotating it silently breaks every session already linked here and every
# EVOLUTION_HOSTS line pointing at it.
if [ -f .env ]; then
  say "Keeping the existing .env (re-run is safe; the host keeps its identity)"
else
  say "Generating this host's own key and database password"
  umask 077
  printf 'AUTHENTICATION_API_KEY=%s\nPOSTGRES_PASSWORD=%s\n' \
    "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env
fi
# shellcheck disable=SC1091
API_KEY="$(grep -E '^AUTHENTICATION_API_KEY=' .env | cut -d= -f2-)"

# ------------------------------------------------------------------- up ------
say "Starting Evolution + its own Postgres and Redis"
$DC up -d

say "Waiting for the lane to answer"
for i in $(seq 1 60); do
  if curl -fsS -m 3 http://127.0.0.1:8080/ >/dev/null 2>&1; then
    echo "   healthy after ${i}s"
    break
  fi
  [ "$i" = 60 ] && { echo "   STILL DOWN - read: $DC logs --tail=50 evolution" >&2; exit 1; }
  sleep 1
done

# ---------------------------------------------------------------- https ------
# Evolution must be reachable over HTTPS, and no lane should need an inbound
# port open. Cloudflare's quick tunnel is free with unmetered bandwidth and no
# cap on tunnel count (confirmed Jul 2026).
if [ "$TUNNEL" = 1 ] && [ -z "$PUBLIC_URL" ]; then
  say "Starting a Cloudflare quick tunnel"
  if ! command -v cloudflared >/dev/null 2>&1; then
    curl -fsSL -o /tmp/cloudflared \
      "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')"
    sudo install -m 0755 /tmp/cloudflared /usr/local/bin/cloudflared
  fi
  nohup cloudflared tunnel --url http://127.0.0.1:8080 > /tmp/cf-tunnel.log 2>&1 &
  for i in $(seq 1 30); do
    PUBLIC_URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/cf-tunnel.log | head -1 || true)"
    [ -n "$PUBLIC_URL" ] && break
    sleep 1
  done
  # A QUICK TUNNEL IS FOR PROVING THE LANE, NOT FOR CARRYING NUMBERS. Its
  # hostname is random and changes on every restart, which would silently
  # orphan every session pinned to the old URL. Say so rather than let it be
  # discovered in production.
  cat <<'WARN'

   NOTE: a quick tunnel's hostname is RANDOM and changes whenever it restarts.
   That is fine for proving the lane works. Before this host carries real
   numbers, give it a stable name - a named Cloudflare tunnel or Caddy with
   your own DNS - because an EVOLUTION_HOSTS line pointing at a dead hostname
   strands every number linked through it.
WARN
fi

# ------------------------------------------------------------------ done -----
LINE="${PUBLIC_URL:-https://REPLACE-WITH-YOUR-HTTPS-URL}|${API_KEY}"
if [ -n "$PREFIXES" ] || [ -n "$CAP" ]; then
  LINE="${LINE}|${PREFIXES}"
  [ -n "$CAP" ] && LINE="${LINE}|${CAP}"
fi

say "This lane is up. Paste this line into Admin -> Keys -> EVOLUTION_HOSTS"
printf '\n   %s\n\n' "$LINE"
cat <<'NEXT'
   One line per host, newline separated. Fields:
     url | key | dial prefixes (optional) | this host's cap (optional)

   Then check Admin -> Ops -> choke points: the fleet's capacity is the SUM of
   the hosts' caps, and it has to clear your invited tester count.
NEXT
