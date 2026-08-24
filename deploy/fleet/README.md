# The $0 Evolution fleet

One `docker-compose.yml`, brought up once per host. Each host is a
self-contained lane: Evolution + its own Postgres + its own Redis. Nothing is
shared between hosts, because none of the free managed databases survive an
always-on Evolution (the reasoning is written out at the top of the compose
file).

## Why more than one host at all

Four separate reasons, and only the first is about capacity.

1. **Capacity.** Render `starter` is 512 MB - below Evolution's own stated
   production floor of 2 vCPU / 2 GB - and `render.yaml` itself says that holds
   roughly 30-50 live sockets. `maxPerHost` is 25 and genuinely REFUSES at the
   cap rather than overfilling, so **one host means a beta capped at 25 linked
   numbers**. 100 testers need **4 hosts** of capacity; 8 lanes gives 200 and
   leaves room to lose one.
2. **Geography.** IP-vs-number geo mismatch is a separately scored WhatsApp
   signal. Our whole fleet was one box in Oregon carrying numbers whose shops
   are in south-east Asia.
3. **Blast radius.** One burned IP range must not take the whole beta down.
4. **Provider risk.** See the next paragraph - it is the thing this table gets
   wrong if you read it as a shopping list.

> **A HOST buys capacity. A PROVIDER buys blast radius.** Six VMs inside one
> Oracle tenancy are six hosts and **one** failure domain: one suspended
> tenancy takes all six, and one flagged ASN taints all six. Cap any single
> provider at half the fleet. That constraint, not the free-tier limits, is
> what shapes the recommended arrangement below.

Migrating off Render also **saves $13/mo** ($7 web + $6 Postgres).

## The lanes (verified Aug 2026 against primary sources)

| # | Lane | Free? | Shape | What to know before you commit |
|---|---|---|---|---|
| 1-4 | **Oracle Always Free, ARM A1** | forever | 2 OCPU / 12 GB **total**, splittable into up to **4** instances | Halved from 4 OCPU / 24 GB on **15 Jun 2026**, and over-limit instances were terminated from **18 Aug 2026**. **The home region is chosen at signup and can NEVER be changed** - create this account LAST. |
| 5-6 | **Oracle Always Free, AMD** | forever | 2 x `VM.Standard.E2.1.Micro`, 1/8 OCPU + 1 GB each | Untouched by the June cut. 1 GB comfortably holds 25 sockets. Same tenancy as 1-4, so same failure domain. |
| 7 | **Google Cloud Always Free** | forever | 1 x `e2-micro`, 1 GB, 30 GB disk | **us-west1 / us-central1 / us-east1 ONLY** - a geo mismatch for Asian numbers, so give it numbers whose shops are in the Americas or leave its prefix field empty. Same GCP account as Cloud Run. |
| 8 | **Northflank free** | forever | 2 services + 1 DB + 2 crons, **no sleep** | Docker-native and genuinely always-on. Positioned by Northflank as a **sandbox**, not production - read their current terms before leaning on it. No card, no region decision: **start here.** |
| 9 | **Azure free** | **12 months** | B1s, 750 h/mo | **Expires**, and the expiry date is the day a cohort loses its host. Many regions including SE Asia. Card required for verification. |
| 10 | **AWS** | **6-12 months** | credits (post-Jul-2025 accounts) | Expires. Legacy accounts keep the old 12-month tier. Last resort. |
| - | **Render** (current) | **$13/mo** | 512 MB starter + Postgres | Keep until two free lanes are proven, then retire it and save the $13. |
| x | **Koyeb** | **CLOSED** | - | Free Starter shut to NEW signups after the Feb 2026 Mistral acquisition. Listed so nobody re-researches it. |
| x | **Fly.io** | **DEAD** | - | Free tier removed in 2024; only legacy Hobby orgs keep 3 machines. |

**Recommended shape for 100 testers - 8 lanes, 200 capacity, 5 providers:**
2 x Oracle ARM (1 OCPU / 6 GB each) + 2 x Oracle AMD + 1 x GCP e2-micro +
1 x Northflank + 1 x Azure B1s + Render until it is retired. That holds Oracle
to 4 of the 8, so no single tenancy is more than half the fleet.

**Build them in this order**, which is not the table's order:

1. **Northflank** - no card, no region decision, no expiry. Proves the compose
   file on someone else's infrastructure before any commitment.
2. **GCP e2-micro** - the account already exists (Cloud Run runs there).
3. **Azure B1s** - region-matched, and **write its expiry date down**.
4. **Oracle, LAST.** Its home region is permanent, so it is the one decision
   that cannot be walked back. Make it once the majority tester country is
   known, then take all 4-6 instances in one go.

## Standing one up

1. Create the VM in the region that matches its numbers. Open only 443 to the
   internet.
2. `git clone` this repo (or copy `deploy/fleet/`), then:
   ```
   cd deploy/fleet
   printf 'AUTHENTICATION_API_KEY=%s\nPOSTGRES_PASSWORD=%s\n' \
     "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env
   docker compose up -d
   ```
   A **unique key per host**, so one leak burns one cohort, not the fleet.
3. Put HTTPS in front of it. Cloudflare Tunnel is free and unmetered (since
   Jul 2026) and needs no inbound port at all:
   `cloudflared tunnel --url http://127.0.0.1:8080`. Caddy with a real DNS name
   works equally well.
4. Add the line to **Admin -> Keys -> EVOLUTION_HOSTS**, with its region:
   ```
   https://sg.example.com|<the key from .env>|66,84,855,856,60,65
   ```
   The third field is a comma-separated list of **calling-code prefixes**. Omit
   it for a region-neutral host. See `src/lib/wa/host-region.ts`.
5. Watch **Admin -> Keys -> host occupancy**. New links now prefer a host that
   claims their number's country; a placement that could not get one leaves a
   `host-geo-mismatch` entry on the message trail, so a fleet that is out of
   capacity in the right region says so instead of looking uniformly green.

`.env` is gitignored by the repo root rule. Never commit a key.

## Retiring Render

Once two free lanes are carrying real numbers, remove Render's
`EVOLUTION_HOSTS` line, let its cohort re-link onto the fleet, then delete the
services. That also deletes the duplicate `wd-queue-drain` cron and the broken
Blueprint (see `render.yaml`'s header) - three problems closed by one action,
and $13/mo back.

## Monitoring (also $0)

- **UptimeRobot** free: 50 monitors, 5-minute checks - one per Evolution host
  plus the app itself.
- **Healthchecks.io** free: a dead-man's switch on the queue-drain cron. This is
  the gap `deploy/ping/ping.mjs` cannot close by itself - its exit-1 alarm only
  fires if the cron still RUNS. If the cron service is deleted or dies, nothing
  tells anyone. Only a dead-man's switch catches a drain that stopped existing.
