# WheelDeal - WhatsApp account safety (anti-ban) — the honest version

**Read this before touching `evolution.ts`, `wa-guard.ts`, `wa/pacing.ts`, or the
Evolution server config.**

## The one thing this document will NOT say

No software can **guarantee zero bans or zero restrictions.** WhatsApp/Meta run a
private, changing, server-side classifier; the decision is theirs, made on signals
we cannot fully see, and it applies to a number we do not own the trust history of.
Anyone selling you a "guaranteed no-ban" WhatsApp automation is lying. What we CAN
do — and do — is remove every *known* flag vector, behave like a human, and **stop
digging the moment WhatsApp pushes back.** That materially lowers the odds; it does
not zero them. Treat every connected number as expendable and reversible, never as
permanent infrastructure.

## What actually happened (root cause of the current restriction)

The restriction hit **at the pairing / socket-connection step, before a single
message was sent.** That rules out message content, velocity, and volume as the
trigger — those come later. A ban at *connect* time points at the **session
fingerprint**: the client string, the protocol, and the connecting IP.

Baileys' default client fingerprint is a generic library string (e.g. an
"Evolution API"/bot identifier), which reads as automation to Meta the instant the
web socket opens. Combined with a **data-center IP** (GCP/AWS/Render egress ranges
are known and heavily weighted), a fresh pairing from that fingerprint on that IP
is a textbook automated-client signature.

## Fixes shipped for the pairing layer (this change)

In `src/lib/evolution.ts`, on **every** `instance/create` path (initial link,
failover recreate, and the older-build flat-webhook retry):

| Field | Value | Why |
|---|---|---|
| `browser` | `["Mac OS", "Chrome", "131.0.0"]` | Presents a **standard desktop WhatsApp-Web** fingerprint instead of the flagged library default. `CONNECT_FINGERPRINT` constant, spread into all create bodies. The version is refreshed to a current stable build (owner report 4); the platform + browser stay fleet-uniform on purpose — the unofficial-client axis is a full ban keyed on client *identity* that resolves 100%/0% for the whole fleet at once, so varying the name per account buys nothing. |
| `mobile` | `false` | Pins the **WhatsApp Web protocol**, not the deprecated/flagged mobile API. |
| `syncFullHistory` | `false` | Never backfills the user's past chats on connect (data minimization + removes the "pulls everything on link" bot signature). Already present; kept. |
| `readMessages`, `readStatus` | `false` | Never auto-reads other chats / statuses on connect. |
| `groupsIgnore` | `true` | Drops group traffic. |
| `alwaysOnline` | `false` | Never shows a permanent-online presence. |

> **Authoritative equivalent on stock Evolution API.** Some Evolution builds read
> the fingerprint from **server env**, not the per-instance create field. If you run
> your own Evolution server, ALSO set:
> ```
> CONFIG_SESSION_PHONE_CLIENT=Mac OS
> CONFIG_SESSION_PHONE_NAME=Chrome
> ```
> and restart it. Setting both the per-instance `browser` field and the server env
> is belt-and-suspenders: the field is a harmless no-op on builds that read only the
> env, and authoritative on forks that pass `browser` to `makeWASocket`.
>
> **These are now baked into `deploy/evolution/Dockerfile` as `ENV` (owner report
> 4)** — the pairing-code path ignores the per-instance `browser` field entirely on
> stock builds, so without the server env a code-link would fall back to Baileys'
> generic default at the exact moment (pairing) that the ban fires. `render.yaml`
> sets the same pair for the Render half; `wa/device-fingerprint.test.ts` pins that
> the code constant, the render env and the docs all agree.

The `hardening-invariants` test now pins the Mac-OS/Chrome fingerprint + `mobile:false`
so a future edit cannot silently regress to the flagged default.

## The IP problem (the biggest remaining pairing risk) — proxy guidance

**A data-center IP is a top-weighted ban signal, and no amount of fingerprint
tuning fully compensates for it.** If the Evolution server (the process that opens
the WhatsApp socket — NOT the Next.js app) runs on GCP / AWS / Render / any cloud,
route the WhatsApp **socket** through a **residential or mobile proxy** located in
or near the number's home country:

- The code already supports per-user proxies: `parseProxy(email)` →
  `proxyHost/proxyPort/proxyProtocol/proxyUsername/proxyPassword` on create, plus
  `/proxy/set/{instance}`. Configure a residential proxy there.
- Prefer a **residential** or **4G/LTE mobile** proxy, **geo-matched** to the
  number's country (a `+972` number connecting via a Singapore data center is itself
  suspicious). Static data-center proxies do **not** solve this — they are still
  data-center ranges.
- Keep the SAME egress IP for a given number across reconnects where possible;
  hopping IPs every reconnect is its own flag.

This is the single highest-leverage change for pairing survival on cloud
hosting - and it costs roughly $30-55/mo per port, which at 50 numbers is not a
$0 answer. **The free half of it is geography.** The paragraph above notes that
a +972 number connecting via a Singapore datacenter is itself suspicious; that
mismatch is a separate signal from the datacenter range, and it is fixed by
placing the number on a host in its own region rather than by buying anything.
`EVOLUTION_HOSTS`' third field and `deploy/fleet/` exist for exactly that. It
does not replace a residential proxy - the range is still a datacenter range -
but it removes the half of the problem that is free to remove.

> **Warm-up note (owner report 8).** The ramp no longer touches introductions
> alone. `warmupNewContactFactor` now also scales the ALL-LANES daily ceiling
> (`day_cap`), floored at 40, so a day-0 number sits near 110/day rather than
> 220 and reaches the full ceiling only once it is warm. The REPLY lane is
> deliberately left generous: reciprocal traffic is the protective signal, and
> refusing to answer a shop that just wrote to us would raise ban risk, not
> lower it.

## The defense stack already in the codebase (send + reputation layers)

Once connected, outbound behavior is governed by a layered guard — none of it new,
all of it real:

- **Reputation & risk scoring** (`wa-guard.ts`): per-number 0-100 trust,
  `computeRisk` from live behavior (reply rate is the dominant spam signal, blocks/
  reports catastrophic, failed sends = list-blasting), **auto-pause** when risk
  crosses the threshold (`paused_until`), and **fail-closed** on unknown safety state.
- **Volume caps** (`usage.ts` / `capacity.ts`): plan-tiered hourly/daily cold-intro
  budgets; new numbers **earn** volume (warm-up ramp).
- **Pacing** (`wa/pacing.ts`): atomic lock-free send-slot claims (no thundering
  herd under concurrency), min-gap enforcement, hour-window-aware stagger, and now
  **Gaussian (bell-curve) jitter** on the cold lane (`gaussianUnit`) so inter-message
  gaps cluster like human timing instead of a flat uniform spread.
- **Presence emulation** (`evolution.ts`): composing → paused → composing before a
  queued send, and a **length-proportional typing delay** (18 ms/char on top of
  a 1.2s floor, clamped **1.2-4.5s**) so a short "ok" and a long paragraph don't
  take the same time to "type". The 4.5s ceiling is load-bearing, not taste:
  Evolution honours this delay by holding the send request server-side and our
  fetch aborts at 12s, so a longer "human" pause turns into a failed send.
- **Lexical entropy** (`humanizeVariant`, `copy/` matrix compiler, `graph/uniqueness`):
  every outbound is structurally varied so no two shops (across all users) receive the
  same skeleton — zero identical payload hashes.
- **Business-hours gate**: never message a shop at 3 AM local (coarse per-prefix UTC).
- **Geo-aware host placement** (`EVOLUTION_HOSTS`, `wa/host-region.ts`): NOT
  round-robin. A host may declare the calling codes it is right for
  (`url|key|66,84,855`), and a new number prefers a host claiming its country,
  then a region-neutral host, then a mismatched one - load breaking every tie.
  This is the one network-level lever available without a proxy: IP-vs-number
  geo mismatch is scored SEPARATELY from the datacenter-range signal below, so
  a Thai number on a Thai-region box removes half the problem for free. A
  mismatched placement writes `host-geo-mismatch`, which is how a capacity
  shortage in the right region becomes visible instead of silent.
- **Ban-recovery** (`enterBanRecovery`): a real WhatsApp logout/conflict/ban signal
  from the connection webhook pauses the number 24h and drops trust to 10.

## New this change — the send-side STOP-LOSS (fast circuit breaker)

`computeRisk` is a **slow** gauge (a failed send adds only ~+3). So a number that
gets restricted **mid-batch** would keep getting hammered shop-after-shop long
before cumulative risk trips the pause. The new `noteSendOutcome(senderKey, outcome)`
in `wa-guard.ts` is the **fast** trip:

- Every send reports its outcome from the one send chokepoint (`sendFromUser`):
  `"ok"` (clean) resets the streak; `"soft"` resets it too — a scattered dead/invalid
  number **and** a bare transient timeout (a cold/slow Evolution host returns status 0,
  which is NOT a restriction and must not trip the breaker); `"hard"` — an
  **account-level** signal, HTTP 401/403/429 or restriction/ban/rate-limit text —
  increments it.
- **3 consecutive hard failures within 180s → `enterBanRecovery` immediately.** That
  sets `paused_until`, and `guardOutbound` then **parks every automated send** for the
  whole account until the window clears. An `wa-stop-loss` `agent_events` row is written
  so the owner sees it in the Ops center.
- **Scope, honestly:** the fast streak is in-memory per-process, so it reliably protects
  the long-lived workers deployment (a burst lands in one process). On the serverless
  path it under-fires (sends are spread ~1/instance across ephemeral lambdas); there the
  **durable** reputation gauge (`recordSendFailure` → risk auto-pause) is the
  cross-instance safety net. A real restriction is caught by both over time; the fast
  breaker is the immediate stop for the workers path.

This is the honest core of "no-ban safeguards": not a promise that a ban can't
happen, but a guarantee the system **stops the moment WhatsApp resists**, instead of
digging the hole deeper. Dead numbers stay "soft" so a list-quality problem never
trips a 12h halt.

## New this change (owner report 4) — behavioural completeness + honest residuals

The Aug-2026 anti-ban pass closed the behavioural gaps the audit named and, per
this document's own rule, **writes down the risks it did not close** rather than
pretending they are gone.

**Shipped:**

- **Read receipts (the largest behavioural tell we were missing).** A real linked
  device reads a message before it answers; ours never did — `readMessages:false`
  at the socket AND no `markMessageAsRead` anywhere, so every number presented the
  same never-reads-then-replies pattern (a documented clustering signal).
  `markMessageAsRead` now fires from ingest, **post-store, after a humanized 2-7s
  "just glanced" delay** (`readReceiptDelayMs`), for the whole batch in parallel.
  It is **counted, not swallowed** (`wa-read-failed` events) — the `@lid`
  silent-failure class that bit presence cannot hide here.
  - *Deliberate distinction:* the socket-level `readMessages:false` STAYS false. It
    means "do not auto-read every chat and status on connect" (privacy + the
    reads-everything bot signature). `markMessageAsRead` marks only the specific
    rental-shop messages the agent actually handled — which is exactly what a human
    does, and touches nothing personal.
  - *Product note:* shops now see blue ticks. The pre-link consent copy says so.
- **Presence failures are counted** (`wa-presence-failed`), not `catch {}`-swallowed
  — the `@lid` `sendPresence` bug made lid recipients silently presence-less with no
  trace. One throttled event per failing sequence surfaces it.
- **Fingerprint refreshed + baked into the Evolution image** (see the pairing table
  and the env note above).
- **Datacenter-IP cluster banner** (`clusterWarning` / `transportSummary`): when
  **≥5 EXPOSED numbers share one host**, the transport tile turns red and names
  the host. Datacenter-IP clustering is the classic cluster-ban trigger, and it was
  the one transport state worth a loud alarm (an unconfigured proxy at low numbers
  is the expected, non-alarming baseline). "Exposed" means no CONFIRMED residential
  exit - `proxy_verified_at` unset - not merely "no template configured". Pasting
  `EVOLUTION_PROXY_TEMPLATE` used to silence the banner for the whole fleet the
  instant it was set, verified or not, which is precisely backwards: a template is
  an assertion, and a number whose exit was never confirmed is still egressing from
  the shared datacenter IP. The alarm now takes no config flag at all, so no pasted
  value can quiet it.
- **Webhook re-arm throttle is now a shared config row** (`WH_REARM_<instance>`),
  not a per-process map — N serverless instances no longer each re-arm once an hour
  (N× the intended `/webhook/set` churn).

**Accepted residual risks (honesty over theater):**

- **Outbound media is 100% text.** We send no images, vCards or location replies, so
  the outbound *media-type mix* is uniform where a human's is varied. Message length,
  emoji and timing variance already exist; richer outbound media is a deliberate
  non-goal for now, and this uniformity is an accepted residual signal, not a solved
  one.
- **Connect / disconnect churn is already hardened, not newly rewritten.** The
  pairing flow re-issues codes on the **same instance** (no destructive
  rebuild-per-refresh — see `connectInstance` and `/api/wa/connect`), and a genuine
  unlink goes through the explicit logout/ban paths while a transient host outage
  never regresses a durable "open". These invariants predate this pass; the audit
  confirmed them rather than replacing them.
- **Proxy support is built but OFF by default** (owner decision). The template
  engine, sticky per-number sessions and `/proxy/set` verification all exist; flip
  `EVOLUTION_PROXY_TEMPLATE` (and optionally `EVOLUTION_PROXY_REQUIRED`) on to
  activate. Until then the cluster banner above is the standing reminder of the
  datacenter-IP exposure.

## Operational runbook — what to do RIGHT NOW while restricted

1. **Do NOT send anything from the restricted number during the countdown.** Every
   attempt during a restriction is a fresh strike. Let the timer expire fully.
2. **Open the WhatsApp app on the phone** and confirm the state; if it asks you to
   verify, do so from the real device.
3. After the restriction clears, **warm the number back up slowly**:
   - Day 1: a handful of *replies to real conversations*, no cold intros.
   - Then ramp cold intros over several days — the plan caps already enforce this;
     do not raise them to "catch up".
   - Genuine two-way engagement (shops that reply) is the single strongest positive
     signal and the fastest way to rebuild trust.
4. If this recurs at pairing on a cloud IP, the residential proxy (above) is almost
   certainly the missing piece — fingerprint tuning alone will not carry a
   data-center IP indefinitely.
5. Consider a **dedicated number** for the automation that is never your personal
   line, and treat it as replaceable.

## Owner switches worth knowing

- `whatsapp_security_policies` (Admin → WA security): every risk threshold, pause
  duration, min-gap and cap is tunable from the DB with no redeploy.
- `clearPause(senderKey)` / Admin lift-pause: manually resume a paused number once
  you've confirmed it's healthy.
- `EVOLUTION_HOSTS`: one `url|apikey` per line, plus an optional third field of
  calling-code prefixes for geo-aware placement (`url|apikey|66,84,855`). No
  third field = region-neutral. `deploy/fleet/` stands one up at $0.
- Per-user proxy: set via the proxy fields; residential + geo-matched strongly
  recommended on cloud hosting.
