#!/usr/bin/env bash
#
# STAND UP ONE EVOLUTION LANE ON GOOGLE CLOUD, FROM A LAPTOP, IN ONE COMMAND.
#
#   ./deploy/fleet/gcp-lane.sh --name wd-evo-sg1 --zone asia-southeast1-b \
#       --machine e2-medium --prefixes 66,84,855,856,60,65 --cap 50
#
# THE DEFAULT IS A DRY RUN. It prints exactly what would be created and what it
# costs per month, and creates nothing. Add --create to actually provision.
# That is deliberate: every resource here is BILLABLE. GCP's Always Free tier is
# one e2-micro in a US region, and this project already spends it on the
# gateway + workers box (infra/gcp). A second VM is money, so it never happens
# as a side effect of reading a README.
#
# WHAT IT FIXES OVER `setup.sh --tunnel`. A Cloudflare quick tunnel's hostname
# is random and changes on restart, which strands every number pinned to the
# old URL. This lane gets a RESERVED static IP, and its public name is
# <ip>.sslip.io - a wildcard resolver, so the name exists the moment the IP
# does, with no DNS record and no registrar. Caddy issues and renews TLS by
# itself. The name survives reboots, which is the property that matters.
#
# The lane itself is still deploy/fleet/setup.sh - this file only builds the
# box around it, so a GCP lane and an Oracle lane run byte-identical compose.

set -euo pipefail

NAME=""
ZONE="asia-southeast1-b"
MACHINE="e2-medium"
PREFIXES=""
CAP=""
DISK_GB="30"
CREATE=0
PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}"
BRANCH="${BRANCH:-master}"

usage() {
  cat <<'USAGE'
Usage: gcp-lane.sh --name <vm-name> [options]

  --name wd-evo-sg1        VM name (also names its static IP). Required.
  --zone asia-southeast1-b Zone. Pick the region the lane's numbers live in.
  --machine e2-medium      e2-small (2 GB), e2-medium (4 GB), e2-standard-2 (8 GB).
  --prefixes 66,84,855     Calling codes this lane is geographically right for.
  --cap 50                 Linked numbers this lane may carry.
  --disk 30                Boot disk, GB (pd-balanced).
  --create                 Actually provision. Without it this is a dry run.
  -h, --help               This message.

Suggested caps (README.md explains why they are conservative):
  e2-small 2 GB -> 25     e2-medium 4 GB -> 50     e2-standard-2 8 GB -> 100
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --name)     NAME="${2:-}"; shift 2 ;;
    --zone)     ZONE="${2:-}"; shift 2 ;;
    --machine)  MACHINE="${2:-}"; shift 2 ;;
    --prefixes) PREFIXES="${2:-}"; shift 2 ;;
    --cap)      CAP="${2:-}"; shift 2 ;;
    --disk)     DISK_GB="${2:-}"; shift 2 ;;
    --create)   CREATE=1; shift ;;
    -h|--help)  usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

[ -n "$NAME" ] || { echo "--name is required" >&2; usage; exit 2; }
[ -n "$PROJECT" ] || { echo "no GCP project: set PROJECT=... or gcloud config set project" >&2; exit 2; }
case "$NAME" in
  *[!a-z0-9-]*|-*|*-) echo "--name must be lowercase letters, digits and hyphens" >&2; exit 2 ;;
esac
case "$CAP" in ''|*[!0-9]*) [ -z "$CAP" ] || { echo "--cap must be a whole number" >&2; exit 2; } ;; esac
case "$PREFIXES" in *[!0-9,]*) echo "--prefixes must be digits and commas" >&2; exit 2 ;; esac

REGION="${ZONE%-*}"

# List prices, USD/month, on-demand, 730 h. They move and they differ a little
# by region - this is an order-of-magnitude guard against a surprise bill, not
# an invoice. The pricing calculator is the authority.
case "$MACHINE" in
  e2-micro)      VM_USD=7 ;;
  e2-small)      VM_USD=14 ;;
  e2-medium)     VM_USD=27 ;;
  e2-standard-2) VM_USD=54 ;;
  *)             VM_USD="?" ;;
esac
DISK_USD=$(( DISK_GB / 10 ))   # pd-balanced is about $0.10 per GB-month
IP_USD=4                       # an in-use external IPv4 is about $0.005/h

cat <<PLAN

== Plan for lane "$NAME"
   project   $PROJECT
   zone      $ZONE
   machine   $MACHINE           ~\$$VM_USD/mo
   disk      ${DISK_GB} GB pd-balanced   ~\$$DISK_USD/mo
   static IP reserved, in use   ~\$$IP_USD/mo
   prefixes  ${PREFIXES:-"(region-neutral)"}
   cap       ${CAP:-"(fleet default)"}

   NOT a spot VM, on purpose: a preemption drops every linked WhatsApp socket
   at once and they all reconnect in a storm, which is the exact pattern the
   anti-ban doctrine exists to avoid. The discount is not worth a banned number.
PLAN

if [ "$CREATE" != 1 ]; then
  printf '\n   DRY RUN - nothing was created. Re-run with --create to provision.\n\n'
  exit 0
fi

say() { printf '\n== %s\n' "$*"; }

say "Reserving a static IP"
gcloud compute addresses describe "$NAME-ip" --project "$PROJECT" --region "$REGION" >/dev/null 2>&1 \
  || gcloud compute addresses create "$NAME-ip" --project "$PROJECT" --region "$REGION" --network-tier PREMIUM
IP="$(gcloud compute addresses describe "$NAME-ip" --project "$PROJECT" --region "$REGION" --format='value(address)')"
DOMAIN="${IP}.sslip.io"
echo "   $IP -> https://$DOMAIN"

say "Opening 80/443 to the wd-evo tag (8080 stays loopback-only)"
gcloud compute firewall-rules describe wd-evo-web --project "$PROJECT" >/dev/null 2>&1 \
  || gcloud compute firewall-rules create wd-evo-web --project "$PROJECT" \
       --direction INGRESS --allow tcp:80,tcp:443 --target-tags wd-evo --source-ranges 0.0.0.0/0

# The startup script runs as root on first boot AND on every reboot. Everything
# in it is idempotent - above all setup.sh, which never regenerates an existing
# .env, because the API key is the host's identity.
STARTUP="$(mktemp)"
trap 'rm -f "$STARTUP"' EXIT
cat > "$STARTUP" <<STARTUP_EOF
#!/usr/bin/env bash
set -uo pipefail
exec >>/var/log/wd-evo-startup.log 2>&1
echo "== startup \$(date -u +%FT%TZ)"

# Swap first: a 2-4 GB box under a reconnect storm should slow down, not OOM.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

export HOME=/root
apt-get update -y && apt-get install -y curl ca-certificates openssl debian-keyring debian-archive-keyring apt-transport-https gnupg

mkdir -p /root/wheeldeal-evolution && cd /root/wheeldeal-evolution
curl -fsSL -o setup.sh https://raw.githubusercontent.com/KaspiDoron/wheeldeal-pro/${BRANCH}/deploy/fleet/setup.sh
curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/KaspiDoron/wheeldeal-pro/${BRANCH}/deploy/fleet/docker-compose.yml
chmod +x setup.sh

# The printed EVOLUTION_HOSTS line carries this host's API key, so it goes to a
# root-only file - NEVER to this log, which the serial console makes readable
# to anyone with project viewer access.
umask 077
./setup.sh --url "https://${DOMAIN}" ${PREFIXES:+--prefixes $PREFIXES} ${CAP:+--cap $CAP} > /root/wheeldeal-evolution/setup.out 2>&1
SETUP_EXIT=\$?
grep -E '^ +https://' /root/wheeldeal-evolution/setup.out | head -1 | sed 's/^ *//' > /root/wheeldeal-evolution/HOSTS_LINE
echo "setup.sh exit=\$SETUP_EXIT (output kept root-only in setup.out)"

# Caddy: automatic TLS for <ip>.sslip.io, reverse proxy to the loopback bind.
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi
cat > /etc/caddy/Caddyfile <<CADDY
${DOMAIN} {
  encode gzip
  reverse_proxy 127.0.0.1:8080
}
CADDY
systemctl enable caddy && systemctl restart caddy
echo "== done"
STARTUP_EOF

say "Creating the VM"
gcloud compute instances create "$NAME" --project "$PROJECT" --zone "$ZONE" \
  --machine-type "$MACHINE" \
  --image-family debian-12 --image-project debian-cloud \
  --boot-disk-size "${DISK_GB}GB" --boot-disk-type pd-balanced \
  --address "$IP" --tags wd-evo \
  --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
  --no-service-account --no-scopes \
  --labels "app=wheeldeal,role=evolution-lane" \
  --metadata-from-file "startup-script=$STARTUP"

cat <<DONE

== "$NAME" is booting. It needs about 4 minutes to install Docker, pull the
   images and get its certificate.

   Is it up?      curl -s -o /dev/null -w '%{http_code}\n' https://$DOMAIN/
   Its host line: gcloud compute ssh $NAME --zone $ZONE --project $PROJECT \\
                    --command 'sudo cat /root/wheeldeal-evolution/HOSTS_LINE'

   Paste that line into Admin -> Keys -> EVOLUTION_HOSTS (one line per host),
   then check Admin -> Ops -> choke points.

   To remove the lane and stop ALL of its charges:
     gcloud compute instances delete $NAME --zone $ZONE --project $PROJECT
     gcloud compute addresses delete $NAME-ip --region $REGION --project $PROJECT
DONE
