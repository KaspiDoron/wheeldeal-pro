# The $0 Evolution fleet - sized for 200 users

One `docker-compose.yml`, brought up once per host. Each host is a
self-contained lane: Evolution + its own Postgres + its own Redis. Nothing is
shared between hosts, because none of the free managed databases survive an
always-on Evolution (the reasoning is written out at the top of the compose
file).

Migrating off Render also **saves $13/mo** ($7 web + $6 Postgres).

## Read this first: 200 users is two ceilings, not one

Both have to clear 200 or the other one is decorative, and they live on
different screens:

1. **The invite list** - `BETA_ALLOWLIST_MAX` (`src/lib/allowlist.ts`), now
   **200**. It was 100, which meant a fleet built for 200 numbers still refused
   tester 101 at the door while the capacity tile reported room to spare.
2. **The fleet** - the sum of every host's cap. That is what the rest of this
   file is about.

A tester past the SECOND ceiling is the confusing failure: they sign in
perfectly happily and then cannot link WhatsApp. Watch
**Admin -> Ops -> choke points**, which now renders both.

## Why more than one host at all

Four separate reasons, and only the first is about capacity.

1. **Capacity.** Evolution's own stated production floor is 2 vCPU / 2 GB. A
   Render `starter` is 512 MB - a quarter of it - and `render.yaml` estimates
   only "~30-50 live sockets" there. The default cap is 25 and it genuinely
   REFUSES at the cap rather than overfilling, so **one small host means a beta
   capped at 25 linked numbers**.
2. **Geography.** IP-vs-number geo mismatch is a separately scored WhatsApp
   signal. The old fleet was one box in Oregon carrying numbers whose shops are
   in south-east Asia.
3. **Blast radius.** One burned IP range must not take the whole beta down.
4. **Provider risk.** See below - it is the thing this table gets wrong if you
   read it as a shopping list.

> **A HOST buys capacity. A PROVIDER buys blast radius.** Six VMs inside one
> Oracle tenancy are six hosts and **one** failure domain: one suspended
> tenancy takes all six, and one flagged ASN taints all six.
>
> **Measure that share in CAPACITY, not in lane count** - the per-host cap
> below is exactly what breaks those two apart. Two Oracle ARM lanes at 50 and
> five 1 GB lanes at 25 is 2 hosts against 5, which looks diversified, and
> 100 slots against 125, which barely is. The lane count flatters you; the
> slot count is the number that goes down when a tenancy does.

## Per-host caps: the fourth `EVOLUTION_HOSTS` field

**This is what makes 200 reachable without ten separate free accounts.**

`EVOLUTION_MAX_PER_HOST` is one number for the whole fleet, so it has to be
sized for the SMALLEST box in it. That leaves the owner two moves and both are
wrong: leave it at 25 and a 6 GB ARM lane runs at a fraction of what it holds,
or raise it and the 1 GB micro beside it is now authorised to accept 60 sockets
and OOM - which does not degrade into a queue. Every socket on the box drops at
once, and each one is a traveller's PERSONAL WhatsApp number reconnecting in a
storm.

So the cap belongs to the host, beside the key and the region already there:

```
https://arm-sg.example.com|<key>|66,84,855,856,60,65|50
https://micro-sg.example.com|<key>|66,84,855|25
https://us.example.com|<key>||25
```

- Field 3 is the calling-code prefixes this host is right for. Empty (`||`) =
  region-neutral.
- Field 4 is that host's cap. **Omit it and the host uses the fleet default**,
  which is exactly how every line written before this field existed behaves.
- A junk or zero cap degrades to the default, never to zero - a typo must not
  silently take a lane's capacity to nothing and refuse every link on it.

Placement also ranks by **fullness, not headcount**. With equal caps that is
the old least-loaded ordering term for term; once the caps differ a raw
headcount is backwards, sending the next traveller to the 20/25 micro instead
of the 30/60 ARM box.

### The caps below are STARTING POINTS, not measurements

The only number here with evidence behind it is the 25 on a 512 MB box, and
even that is the conservative end of `render.yaml`'s own 30-50 estimate. The
rest are scaled from it with a deliberate margin, because the cost of being
wrong is asymmetric: too low wastes a lane you can raise next week, too high
bans numbers you cannot un-ban. **Raise a cap only after watching a host hold
its current one** - Admin -> Ops -> choke points shows per-host occupancy
against each host's own cap, and the compose file's container is the thing to
watch for memory pressure.

## The lanes (re-verified Sept 2026 against primary sources)

| # | Lane | Free? | Shape | Suggested cap | What to know before you commit |
|---|---|---|---|---|---|
| 1-2 | **Oracle Always Free, ARM A1** | forever | 2 OCPU / 12 GB **total**, splittable into up to 4 instances; 2 lanes of 1 OCPU / 6 GB | **50** | Halved from 4 OCPU / 24 GB on **15 Jun 2026**; over-limit instances terminated from **18 Aug 2026**. **Home region is chosen at signup and can NEVER be changed** - create this account LAST. |
| 3-4 | **Oracle Always Free, AMD** | forever | 2 x `VM.Standard.E2.1.Micro`, 1/8 OCPU + 1 GB each | **25** | Untouched by the June cut. Same tenancy as 1-2, so the same failure domain. |
| 5 | **Google Cloud Always Free** | forever | 1 x `e2-micro`, 1 GB, 30 GB disk | **25** | **us-west1 / us-central1 / us-east1 ONLY** - a geo mismatch for Asian numbers, so give it American numbers or leave its prefix field empty. Same GCP account as Cloud Run. |
| 6 | **Northflank free** | forever | 2 services + 1 DB + 2 crons, **no sleep** | **25** | Docker-native and genuinely always-on. Card required for identity, not billing. Positioned as a **sandbox**, not production - read their current terms before leaning on it. No region decision: **start here.** |
| 7 | **Azure free** | **12 months** | B1s (and B2pts v2 / B2ats v2), 750 h/mo | **25** | **Expires**, and the expiry date is the day a cohort loses its host. Many regions including SE Asia. Card required. |
| 8 | **Render** (current) | **$13/mo** | 512 MB starter + Postgres | **25** | The one lane already carrying numbers. Keep it as the fourth non-Oracle lane until something free replaces it. |
| - | **AWS** | **6 months** | $100-200 credits, then the account CLOSES | - | Post-Jul-2025 accounts get credits, not 12 months of t2.micro. Last resort. |
| x | **Koyeb** | **CLOSED** | - | - | Free Starter shut to NEW signups after the Feb 2026 Mistral acquisition. Listed so nobody re-researches it. |
| x | **Fly.io** | **DEAD** | - | - | Free tier removed in 2024; only legacy Hobby orgs keep 3 machines. |

### Oracle will reclaim an idle instance - and this workload looks idle

Oracle deems a compute instance idle when, across a **7-day** window, 95th-
percentile CPU is under 20%, network is under 20%, and (A1 shapes only) memory
is under 20%. **An Evolution host holding sockets that nobody is negotiating on
hits all three.** This is the single most likely way a lane in this fleet
disappears, and it disappears quietly.

The fix costs nothing: **upgrade the tenancy to Pay As You Go.** PAYG accounts
are not subject to idle reclamation, and usage that stays inside the Always
Free limits is still billed at zero. It needs a card on file, and it means a
mistake outside the free limits can now bill you - so set a budget alert at $1
the same day. Do this on the Oracle account before it carries real numbers.

## The 200-user shape

**7 lanes, 225 slots, 5 providers** - and Oracle holds 150 of the 225.

| Lane | Cap |
|---|---|
| 2 x Oracle ARM (1 OCPU / 6 GB) | 100 |
| 2 x Oracle AMD micro | 50 |
| GCP e2-micro | 25 |
| Northflank | 25 |
| Azure B1s | 25 |
| **Total** | **225** |

That is 200 users with one micro lane's worth of slack, and it is the honest
best a card-free-ish all-free fleet does today. **Be clear-eyed about what it
costs:** Oracle is 67% of the capacity, over the half-the-fleet rule above, so
a suspended Oracle tenancy takes two thirds of the beta at once. It is over the
line because there is no fifth always-free provider left to move slots to -
Koyeb closed and Fly.io's free tier is gone.

Two ways to buy that back, in order of what they cost:

- **Keep Render** ($13/mo, already running). 8 lanes, 250 slots, Oracle at 60%,
  and it is the lane with a track record.
- **Add one small paid ARM box** in the region your numbers are actually in.
  Hetzner's CX23 (2 vCPU / 4 GB) lists around EUR 3.99/mo and the ARM CAX11
  around EUR 5.99 after the June 2026 increase - **but check availability
  before planning on it**, as the shared-vCPU line was reported sold out in
  early September 2026. One such box at a cap of 40 puts Oracle under half.

**Also plan for Azure's expiry.** It is a 12-month lane: write the date down
the day you create it, and treat it as a lane you WILL have to replace rather
than one you have.

## Build them in this order

Not the table's order:

1. **Northflank** - no region decision, no expiry. Proves the compose file on
   someone else's infrastructure before any commitment.
2. **GCP e2-micro** - the account already exists (Cloud Run runs there).
3. **Azure B1s** - region-matched, and **write its expiry date down**.
4. **Oracle, LAST.** Its home region is permanent, so it is the one decision
   that cannot be walked back. Make it once the majority tester country is
   known, then take all four instances in one go - and upgrade to PAYG the same
   day (see the reclamation note above).

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
3. Put HTTPS in front of it. Cloudflare Tunnel is free with unmetered bandwidth
   and no cap on tunnel count (confirmed Jul 2026), and needs no inbound port at
   all: `cloudflared tunnel --url http://127.0.0.1:8080`. Caddy with a real DNS
   name works equally well.
4. Add the line to **Admin -> Keys -> EVOLUTION_HOSTS**, with its region and
   its cap:
   ```
   https://sg.example.com|<the key from .env>|66,84,855,856,60,65|50
   ```
5. Watch **Admin -> Keys -> host occupancy** and **Admin -> Ops -> choke
   points**. New links prefer a host that claims their number's country; a
   placement that could not get one leaves a `host-geo-mismatch` entry on the
   message trail, so a fleet that is out of capacity in the right region says so
   instead of looking uniformly green.

`.env` is gitignored by the repo root rule. Never commit a key.

## Retiring Render

Once two free lanes are carrying real numbers **and Oracle is under half the
fleet's capacity without it**, remove Render's `EVOLUTION_HOSTS` line, let its
cohort re-link onto the fleet, then delete the services. That also deletes the
duplicate `wd-queue-drain` cron and the broken Blueprint (see `render.yaml`'s
header) - three problems closed by one action, and $13/mo back.

Until that second condition holds, $13/mo is buying blast radius, not capacity.

## Monitoring (also $0)

- **UptimeRobot** free: 50 monitors, 5-minute checks - one per Evolution host
  plus the app itself.
- **Healthchecks.io** free: a dead-man's switch on the queue-drain cron. This is
  the gap `deploy/ping/ping.mjs` cannot close by itself - its exit-1 alarm only
  fires if the cron still RUNS. If the cron service is deleted or dies, nothing
  tells anyone. Only a dead-man's switch catches a drain that stopped existing.

## Sources

Free-tier terms move; these were the primary or best available sources as of
2026-09-16. Re-check before committing an account.

- Oracle ARM cut to 2 OCPU / 12 GB, enforced 18 Aug 2026 -
  [InfoQ](https://www.infoq.com/news/2026/07/oracle-cloud-free-tier-limits/),
  [Linuxiac](https://linuxiac.com/oracle-quietly-cuts-free-tier-ampere-a1-resources-in-half/),
  [HN discussion](https://news.ycombinator.com/item?id=49183750)
- Oracle idle reclamation thresholds and the PAYG exemption -
  [Oracle Always Free Resources docs](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm),
  [LowEndTalk](https://lowendtalk.com/discussion/184161/oracle-may-reclaim-your-idle-vps)
- GCP e2-micro always free, us-west1 / us-central1 / us-east1 only -
  [GCP free tier guide 2026](https://agentdeals.dev/gcp-free-tier-2026)
- Northflank free sandbox, always-on, 2 services + 1 DB + 2 crons -
  [FreeTier.co](https://freetier.co/directory/products/northflank),
  [Northflank pricing](https://www.budgetforge.dev/tools/northflank-pricing-2026)
- Azure free account, 750 h/mo B1s / B2pts v2 / B2ats v2 for 12 months -
  [Microsoft Learn](https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/create-free-services)
- AWS free tier now 6-month credits for accounts after 15 Jul 2025 -
  [InfraTally](https://infratally.com/articles/aws-free-tier-2026.html)
- Cloudflare Tunnel free and unmetered, no tunnel cap -
  [bex.co](https://bex.co/blog/2026/07/28/cloudflare-tunnel-free-zero-open-ports-ingress)
- Hetzner CX23 / CAX11 pricing after the June 2026 increase, and the Sept 2026
  availability report -
  [Northflank breakdown](https://northflank.com/blog/hetzner-cloud-server-price-increases),
  [costgoat](https://costgoat.com/pricing/hetzner)
