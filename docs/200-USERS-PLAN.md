# 200 users - the plan

Date: 2026-09-16. Evidence: `docs/200-USERS-FINDINGS.md` (eight Opus review
agents, one axis each, every claim with file:line). This file is the short
version: what to do, who does it, in what order.

**Where the app is today:** it safely handles about **35-45 simultaneous
hunters**. Past that, nothing crashes - it degrades silently: the queue starts
binning messages at 6h, the free database's monthly egress is gone in about
18 minutes of 200-user load, the free LLM ladder runs out mid-morning, and the
owner dashboards stay green through all of it.

**Number safety is fine.** Every anti-ban constant is enforced by the database,
not by memory, and the one real ban-exposure the review found (a host blip
moving a linked user to another lane, minting a second registration) was
fixed and deployed on 2026-09-16 (`host-affinity.test.ts`).

---

## YOU - about 30 minutes, nothing here can be automated

| # | Do this | Why | Cost |
|---|---|---|---|
| 1 | **Supabase -> Pro, Small compute** (dashboard -> Billing) | Free tier: 5 GB egress/month, gone in ~18 min at 200 users; 500 MB disk, full in ~2 days; 10-connection pool vs ~500 req/s of polling | $25 + ~$10/mo |
| 2 | **Upstash Redis, pay-as-you-go** (upstash.com, TLS URL) -> paste `REDIS_URL` into GitHub -> Settings -> Secrets | Without it four safety caps (AI daily cap, login limits, provider RPM, copy uniqueness) are enforced x20 - one per Cloud Run instance. Free tier is ~10x too small (4-10M commands/month) | ~$10-20/mo |
| 3 | **Create the free VM accounts** in this order: Northflank, GCP (exists), Azure, Oracle (last; switch it to Pay As You Go the same day or it deletes idle VMs). On each, run the one-liner from `deploy/fleet/README.md` and send me the printed line | 225 sockets across 5 providers, $0 | $0 |
| 4 | **One paid LLM key + tell me the daily budget** (Groq paid tier is the cheapest step) -> Admin -> Keys | The free ladder funds ~39 users/day, not 200 | ~$20-50/mo at beta volume |
| 5 | **Keep Render** ($13/mo) until Oracle is under half the fleet | Blast radius, not capacity | $13/mo |
| 6 | From the September audit, still open: run the 3 SQL files on live Supabase (I can do this once Supabase MCP is authorized), make the `wa-media` bucket private, set `OPERATOR_NAME`, rotate `AUTHENTICATION_API_KEY`, re-bless the golden cases in Admin -> Ops | `docs/AUDIT-2026-09.md`, "What no code can close" | $0 |

**Total: about $80-120/month.** Item 1 is the one that matters most; nothing
below is worth doing before it.

---

## ME - from your MacBook terminal

Needs on that machine: `gh` logged in, the Supabase MCP authorized (`/mcp`),
`gcloud` logged in. Each wave is its own gated merge (typecheck, 7,900+ tests,
build, Playwright), deployed and verified before the next. Anti-ban constants
are not touched anywhere.

**Wave 1 - stop the app from loading itself (code only, no spend needed)**

- Client polls: the live-hunt pulse re-arms both heavy polls every 2.5s (8x the
  documented rate); a degraded pulse TIGHTENS polls into a retry storm; two
  loops ignore `SCALE_MODE`; the transcript poll ships whole `raw` jsonb every
  5s (~20 GB/hour fleet-wide).
- `/api/activity`: a moving cursor instead of re-reading the whole hunt window;
  drop `reasoning`/`output` from the feed select (~300 KB -> ~20 KB per poll).
- Evolution health probe: single-flight, filtered by instance, only on a new
  link (the serve-path pin shipped today already removes most of it).
- Missed-reply sweep: durable throttle, off the reply poll, roster cap > 200.
- Auth failure directions: an unreadable vault must not empty the allowlist
  (today it logs out all 200 testers at once); an unreadable user row must not
  downgrade a paid plan to free; Google sign-in lock keyed on IP alone; sync
  scrypt on a 1-vCPU event loop.

**Wave 2 - the queue keeps up (wa-guard selection only)**

- The 30-row drain slice: per-sender round-robin so one heavy user cannot fill
  it; intros can no longer be starved by replies; paid-plan precedence ages
  instead of queue-jumping forever; a dead Evolution host stalls only its own
  users, not the whole loop; a real queue-age metric (`firstDueAt`) with an
  alarm - today the only alarm reads a field the drain itself rewrites.

**Wave 3 - the inbound path holds**

- Cloud Run `--concurrency 32 -> 8` so the in-app inbound gate (4) means
  something; a byte ceiling BEFORE media is fetched (16-frame bursts can OOM a
  1 GiB instance today); release the dedupe claim when a turn is killed so
  Evolution's redelivery is not a no-op; kick the reply dispatcher BEFORE the
  17s of pushes and read receipts; the post-turn tail inside the request wall;
  Evolution webhook timeout/retry envs pinned in the compose file.

**Wave 4 - money and data**

- Daily spend cap on paid LLM rungs (unbounded today - ~$500-800/day possible
  at full load); skip the retired Cerebras rung; prune `ai_usage`; batch the
  retention prune (it cannot finish inside its own 8s timeout once tables are
  big) and write its heartbeat first; indexes on `whatsapp_messages
  (wa_message_id)`, `searches(user_email, created_at)`, `ai_usage(created_at)`,
  `agent_events` / `api_usage (created_at)`; egress meter on the paths it
  misses.
- Fleet-wide (Redis) host slot reservation so a link burst cannot overfill a
  host; stop-loss streak and auth cooldown fleet-wide.

**Wave 5 - the fleet hosts**

- `deploy/fleet/docker-compose.yml`: memory limit, `NODE_OPTIONS`, log
  rotation, prune runs at start and covers `Chat`; the webhook re-arm rotates
  through all 200 instances instead of the same 50.
- Stand up each host as you create the accounts (item 3 above), paste the
  lines, watch Admin -> Ops -> choke points.

**Then - prove it**

- A load script: 200 simulated tabs polling plus a webhook burst against a
  Cloud Run revision, watching the Supabase egress meter, PostgREST latency and
  the queue-age metric. Ship the invites only when that is green.

---

## What "done" looks like

- Admin -> Ops -> choke points: 200 invited vs >= 225 fleet capacity, egress
  projection green, queue age under 5 minutes at load.
- `REDIS_URL` set (Keys page shows "fleet-wide").
- One paid LLM rung with a daily cap that actually fires.
- No lane holding more than half the fleet's sockets.
