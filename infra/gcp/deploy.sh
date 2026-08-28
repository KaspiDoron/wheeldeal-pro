#!/usr/bin/env bash
# WheelDeal one-shot GCE provisioning. Creates a static IP, an e2-micro VM
# (free-tier) running the startup script, and firewall rules for 80/443, then
# the VM self-bootstraps AND auto-issues TLS - because the gateway is served at
# `<static-ip>.sslip.io`, which public DNS already resolves to the VM, so
# certbot needs no manual A-record. Run from a machine with gcloud authed to the
# target project (e.g. Google Cloud Shell).
#
# Usage (zero-DNS, recommended):
#   PROJECT=my-proj OWNER_EMAIL=you@example.com \
#   ENV_SECRET=wheeldeal-env REPO_SECRET=wheeldeal-gh-token \
#   ./infra/gcp/deploy.sh
#
# Optional overrides: REGION ZONE NAME IP_NAME REPO BRANCH, and API_DOMAIN to
# use your OWN domain instead of sslip.io (then point its A-record at the
# printed IP before the cert can issue).
#
# Prereqs the owner does ONCE (see README.md): create the Secret Manager
# secrets (the .env payload + optional GitHub token) and enable the APIs.
set -euo pipefail

: "${PROJECT:?set PROJECT}"; : "${OWNER_EMAIL:?set OWNER_EMAIL}"
REGION="${REGION:-us-central1}"; ZONE="${ZONE:-us-central1-a}"
NAME="${NAME:-wheeldeal-vm}"; IP_NAME="${IP_NAME:-wheeldeal-ip}"
REPO="${REPO:-KaspiDoron/wheeldeal-pro}"
BRANCH="${BRANCH:-master}"
ENV_SECRET="${ENV_SECRET:-wheeldeal-env}"; REPO_SECRET="${REPO_SECRET:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"

gcloud config set project "$PROJECT"
gcloud services enable compute.googleapis.com secretmanager.googleapis.com

# Static external IP (so the sslip.io domain + the cert never have to change).
gcloud compute addresses create "$IP_NAME" --region "$REGION" 2>/dev/null || true
IP="$(gcloud compute addresses describe "$IP_NAME" --region "$REGION" --format='value(address)')"

# The gateway's public domain: zero-DNS sslip.io by default, derived from the IP.
API_DOMAIN="${API_DOMAIN:-${IP}.sslip.io}"

# Let the VM's default service account READ the secrets (the .env + repo token).
SA="$(gcloud iam service-accounts list --filter='displayName:Compute Engine default' --format='value(email)')"
for S in "$ENV_SECRET" "$REPO_SECRET"; do
  [ -n "$S" ] && gcloud secrets add-iam-policy-binding "$S" \
    --member="serviceAccount:${SA}" --role='roles/secretmanager.secretAccessor' >/dev/null 2>&1 || true
done

# Firewall: 80/443 to the tagged VM (8080 stays internal, behind nginx).
gcloud compute firewall-rules create wheeldeal-web \
  --allow tcp:80,tcp:443 --target-tags wheeldeal --direction INGRESS 2>/dev/null || true

# The VM: e2-micro free-tier, Debian 12, our startup script + metadata.
gcloud compute instances create "$NAME" \
  --zone "$ZONE" --machine-type e2-micro \
  --image-family debian-12 --image-project debian-cloud \
  --boot-disk-size 30GB --boot-disk-type pd-standard \
  --tags wheeldeal,http-server,https-server \
  --address "$IP" \
  --scopes cloud-platform \
  --metadata-from-file startup-script="$HERE/startup.sh" \
  --metadata wd-repo="$REPO",wd-branch="$BRANCH",wd-secret-name="$ENV_SECRET",wd-repo-secret="$REPO_SECRET",wd-api-domain="$API_DOMAIN",wd-owner-email="$OWNER_EMAIL"

echo
echo "=== VM created. Static IP: $IP ==="
echo "Gateway domain (zero-DNS): $API_DOMAIN"
echo
echo "The VM now self-bootstraps: Docker + swap -> pulls .env from Secret Manager"
echo "-> clones $BRANCH -> docker compose up (redis+gateway+workers) -> nginx"
echo "-> certbot auto-issues TLS for https://$API_DOMAIN (sslip.io already resolves)."
echo "Watch it:  gcloud compute ssh $NAME --zone $ZONE --command 'sudo tail -n 40 -f /var/log/wd-startup.log'"
echo
echo "When it finishes (~3-5 min), set the Evolution dashboard webhook URL to:"
echo "   https://$API_DOMAIN/api/webhooks/evolution?token=<sha256('wd-webhook:'+SESSION_SECRET) first 32 hex chars>"
echo "Verify:  curl https://$API_DOMAIN/readyz    ->   {\"ok\":true,\"redis\":true}"
echo "         curl -s -o /dev/null -w '%{http_code}\\n' 'https://$API_DOMAIN/api/webhooks/evolution?token=nope'  ->  403"
