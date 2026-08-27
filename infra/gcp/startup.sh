#!/usr/bin/env bash
# WheelDeal GCE startup script (metadata `startup-script`). Self-bootstraps the
# VM with NO interactive SSH: installs Docker + compose, adds swap (1GB VM),
# pulls secrets from Secret Manager into infra/docker/.env, clones the deploy
# branch, brings the stack up (redis + gateway + workers), and installs nginx.
# SSL (certbot) is a SEPARATE post-DNS step - see infra/gcp/README.md.
#
# Required VM metadata / instance attributes (set at create time):
#   wd-repo         github owner/repo             (e.g. KaspiDoron/Rental-App)
#   wd-branch       deploy branch                 (e.g. master)
#   wd-secret-name  Secret Manager secret id      (holds the full .env contents)
#   wd-repo-secret  Secret Manager secret id      (a GitHub token for the private clone; optional if public)
#   wd-api-domain   the gateway's PUBLIC domain   (default: <this VM's external IP>.sslip.io)
#   wd-owner-email  email for the Let's Encrypt account (certbot)
#
# ZERO-DNS ROUTING: by default the gateway is served at `<external-ip>.sslip.io`
# - sslip.io is a public wildcard DNS that resolves A.B.C.D.sslip.io -> A.B.C.D,
# so the domain ALREADY points at this VM the moment it boots. That means
# certbot's HTTP-01 challenge succeeds immediately and this script issues TLS
# automatically - no manual A-record, no DNS wait, no second step. (Set
# wd-api-domain to a real domain instead if you'd rather use your own; then you
# must point its A-record at the static IP before the cert can issue.)
#
# The .env secret's payload is the literal infra/docker/.env (SUPABASE_URL,
# SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL pooled:6543, SESSION_SECRET,
# ADMIN_EMAILS, EVOLUTION_API_URL/KEY, APP_DOMAIN=<Cloud Run frontend>, ...).
# SESSION_SECRET MUST equal the web service value or webhook tokens + app_config
# decryption break. NOTE: APP_DOMAIN is the CLOUD RUN FRONTEND origin (SSE CORS) -
# it is SEPARATE from the gateway's own wd-api-domain.
set -euo pipefail
exec > >(tee /var/log/wd-startup.log) 2>&1
echo "[wd] startup begin $(date -u)"

meta() { curl -s -H "Metadata-Flavor: Google" \
  "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1" || true; }

REPO="$(meta wd-repo)";           REPO="${REPO:-KaspiDoron/Rental-App}"
BRANCH="$(meta wd-branch)";       BRANCH="${BRANCH:-master}"
SECRET_NAME="$(meta wd-secret-name)"; SECRET_NAME="${SECRET_NAME:-wheeldeal-env}"
REPO_SECRET="$(meta wd-repo-secret)"
OWNER_EMAIL="$(meta wd-owner-email)"
APP_DIR=/opt/wheeldeal

# The gateway's public domain. Default to the zero-DNS <external-ip>.sslip.io,
# derived from THIS VM's own external IP (so nothing needs to be pre-computed).
EXTERNAL_IP="$(curl -s -H 'Metadata-Flavor: Google' \
  'http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip')"
API_DOMAIN="$(meta wd-api-domain)"
API_DOMAIN="${API_DOMAIN:-${EXTERNAL_IP}.sslip.io}"
echo "[wd] gateway public domain: $API_DOMAIN (external IP $EXTERNAL_IP)"

# --- Docker + compose plugin (Debian 12) ------------------------------------
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg git nginx
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
systemctl enable --now docker

# --- Swap (the 1GB e2-micro needs headroom for docker build) ----------------
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile; mkswap /swapfile; swapon /swapfile
  echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi

# --- Fetch source + secrets --------------------------------------------------
rm -rf "$APP_DIR"
if [ -n "$REPO_SECRET" ]; then
  TOKEN="$(gcloud secrets versions access latest --secret="$REPO_SECRET" 2>/dev/null || true)"
  git clone --depth 1 --branch "$BRANCH" "https://x-access-token:${TOKEN}@github.com/${REPO}.git" "$APP_DIR"
else
  git clone --depth 1 --branch "$BRANCH" "https://github.com/${REPO}.git" "$APP_DIR"
fi

# The .env secret payload IS the infra/docker/.env file.
gcloud secrets versions access latest --secret="$SECRET_NAME" > "$APP_DIR/infra/docker/.env"
chmod 600 "$APP_DIR/infra/docker/.env"

# --- Bring the stack up (redis + gateway + workers; NO web - separate Cloud Run)-
cd "$APP_DIR/infra/docker"
docker compose --env-file .env up -d --build

# --- nginx reverse proxy (server_name = the gateway's public domain) ---------
cp "$APP_DIR/infra/gcp/nginx.conf" /etc/nginx/sites-available/wheeldeal
ln -sf /etc/nginx/sites-available/wheeldeal /etc/nginx/sites-enabled/wheeldeal
rm -f /etc/nginx/sites-enabled/default
sed -i "s/__API_DOMAIN__/$API_DOMAIN/g" /etc/nginx/sites-available/wheeldeal
nginx -t && systemctl reload nginx

# --- Automatic TLS: sslip.io already resolves to this VM, so certbot's HTTP-01
#     challenge works right now - no manual DNS step. Non-fatal if it can't
#     issue (rate limit / a custom domain whose DNS isn't pointed yet): the
#     gateway still serves over HTTP:80 and certbot can be re-run later.
apt-get install -y certbot python3-certbot-nginx
CERT_EMAIL="${OWNER_EMAIL:-admin@${API_DOMAIN}}"
if certbot --nginx -d "$API_DOMAIN" --non-interactive --agree-tos \
     -m "$CERT_EMAIL" --redirect --keep-until-expiring; then
  echo "[wd] TLS issued for https://$API_DOMAIN"
  systemctl reload nginx
else
  echo "[wd] WARN: certbot did not issue a cert - gateway serves HTTP only for now."
fi

echo "[wd] startup complete $(date -u)."
echo "[wd] Gateway live. Set the Evolution webhook to:"
echo "[wd]   https://$API_DOMAIN/api/webhooks/evolution?token=<sha256('wd-webhook:'+SESSION_SECRET)[:32]>"
echo "[wd] Health: curl https://$API_DOMAIN/readyz"
