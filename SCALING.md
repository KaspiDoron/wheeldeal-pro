# SCALING.md - taking WheelDeal from 25 testers to hundreds of people at once

Written for the owner, not for an engineer. Every section is the same five
questions:

1. **What is this thing?** - one sentence, plain words.
2. **What is the limit today?** - the number that is true right now.
3. **What breaks first?** - at 100, at 300, at 500 people using it at the same time.
4. **What do I buy or flip?** - the exact plan, the exact price, the exact switch.
5. **How do I know it worked?** - the button to press in Admin -> Keys.

Two words used precisely throughout:

- **Simultaneous users** = people whose hunt is live *right now* - a phone open,
  or an agent negotiating on their behalf in the background. Not signups.
- **A wall** = a limit whose failure mode is worse than waiting. Most limits in
  this app produce a queue. Exactly one produces a banned WhatsApp number, and
  that is why it goes first.

> Everything in this guide that is a claim **about this codebase** is pinned by
> `src/lib/wave7-scale.test.ts`. If someone changes the code and not this file,
> the test suite goes red. A guide that quietly drifts from the app is worse
> than no guide, because it gets trusted.

---

## The one thing to understand before anything else

Your app is a small, cheap web service in front of **one expensive, fragile
thing**: real WhatsApp accounts.

Everything else here - the database, the AI, the web server - is elastic. You
pay a bit more and it stretches. The WhatsApp layer does not stretch. It is a
Node process holding a live socket per traveller, and when it runs out of room
the failure is not slowness. It is a traveller's **personal WhatsApp number
getting banned**, which you cannot buy back afterwards.

So the order of work in this guide is not "cheapest first" or "easiest first".
It is **worst-consequence first**.

---

## The order to do these in

Do them in this order. Each step is independently verifiable, and each one is
useless if the step above it is still broken.

| # | Step | Why here | Rough cost |
|---|---|---|---|
| 1 | **Size the WhatsApp (Evolution) tier** | The only wall whose failure is permanent | $7-25 per host / month |
| 2 | **Set `REDIS_URL`** | Without it, every daily safety cap is multiplied by up to 20 | $0-10 / month |
| 3 | **Upgrade Supabase compute** | Everything the app does is a database call | $25-85 / month |
| 4 | **Raise the Cloud Run ceiling** | Cheap, and pointless before 1-3 are done | $10-40 / month |
| 5 | **Guarantee the queue drain** | A perfect fleet that nothing pings sends nothing | ~$0 |
| 6 | **Protect the webhook front door** | A reply burst is the one thing that can flood you | $0 |
| 7 | **Everything else** (AI, maps, email, payments, push) | Real limits, gentle failures | varies |

---

## 1. WhatsApp transport (Evolution / Baileys) - THE WALL

### What is it
A server called Evolution API that speaks WhatsApp on your travellers' behalf.
Each traveller who links their WhatsApp gets a "session" - a live connection -
inside that server. Your app spreads travellers across a **pool** of these
servers (Admin -> Keys -> `EVOLUTION_HOSTS`, one `url|apikey` per line - with
an OPTIONAL third field of calling-code prefixes, `url|apikey|66,84,855`, that
says which numbers that host is geographically right for) and fails over
automatically if one goes to sleep.

**Placement is geo-first, then least-loaded** - never round-robin. A number
transmitting from a datacenter on the wrong continent is a separately scored
WhatsApp signal, so a host that claims this number's country is preferred, then
a host that claims nothing, then one that claims somewhere else (still used - a
scored signal beats a user who cannot link at all, and it writes a
`host-geo-mismatch` event so the shortage is visible). A line with no third
field is region-neutral, which is what every line meant before this existed.

### What is the limit today
- **25 paired users per host.** That is `EVOLUTION_MAX_PER_HOST`, and 25 is the
  built-in default when it is unset. **At capacity the app now REFUSES** - it
  answers "we are at capacity" rather than placing the traveller anyway.
  It used to do the latter (`underCap.length ? underCap : pickFrom`), which
  meant the cap did nothing at the exact moment it mattered: with a single
  configured host, every tester landed on one box regardless.
- **Memory is the real ceiling, and 40 was over it.** Evolution's own
  documented production floor is 2 vCPU / 2 GB. A 512 MB Render `starter` -
  what `render.yaml` ships - holds roughly 30-50 sockets, and
  PRODUCTION-READINESS puts safe occupancy at 25-30. The old default of 40 sat
  at the top of that range with no margin. The failure mode is not a slow
  queue: the container OOMs, every socket drops at once, and each of those is
  a personal WhatsApp number reconnecting in a storm. Capacity added later
  does not un-ban a traveller, so the default is deliberately conservative and
  the owner raises it as a decision.
- **Evolution has no queue and no rate limiting of its own.** It sends what you
  hand it, as fast as you hand it over. All pacing in this system is done by
  *your* app (`wa-guard.ts`, the outbox, the per-plan budgets).
- **Today you run ONE Render `starter` web service** for this. One host. 25
  users. That is the honest current ceiling of the whole product - and the
  refusal above applies to the single-host case too, so user 26 is told "at
  capacity" rather than being placed on a full box. `deploy/fleet/` is the $0
  way past it: Oracle Always Free, Azure's 12-month B1s and Northflank Sandbox
  each run one self-contained lane, which also retires the $13/mo Render bill.

### What breaks first
| Simultaneous users | What happens |
|---|---|
| **~25** | The pool is full. New travellers are REFUSED with an honest "at capacity" message rather than placed on a full box. Nobody's number is at risk - but nobody new can link, either. |
| **100** | One 512 MB container cannot hold the sessions. Sockets drop, pairing fails, "WhatsApp disconnected" appears for people who did nothing wrong. |
| **300** | Without more hosts this simply cannot run. With hosts but no proxy spread, you look like a bot farm from one IP - the clustering failure, where one enforcement rule catches your whole fleet at once. |
| **500** | Same as 300, plus Evolution's own event fan-out (every inbound message POSTed to your webhook) becomes the flood described in section 6. |

### What to buy / flip
**Choose one of two shapes. Do not mix them without thinking.**

**Shape A - many small hosts (recommended, and what the app is built for).**
Add Render (or Koyeb, or Fly) services, each running
`deploy/evolution/Dockerfile`, each on a paid plan that never sleeps
(~$7/month on Render `starter`). Paste each one into `EVOLUTION_HOSTS` as
`https://host-2.onrender.com|itsapikey`, one per line.

At the real 25/host default:

- 100 users -> **4 hosts** (~$28/month on Render, or **$0** on the free fleet)
- 300 users -> **12 hosts** (~$84/month)
- 500 users -> **20 hosts** (~$140/month)

`deploy/fleet/docker-compose.yml` runs the same pinned Evolution image with its
own Postgres and Redis on any Docker host, which is how the first three or four
of those become free.

Why this shape wins: hosts fail independently, and different hosts can sit
behind different residential exit IPs, which is the single most effective
anti-clustering measure available to you.

**Shape B - fewer big hosts.** Bump the Render plan to `standard` (2 GB,
~$25/month). A 2 GB container holds a few hundred sessions. Cheaper per user,
but a single crash takes everyone down at once, and every session shares one IP.

**In both shapes, also do this:**

1. **Set the residential proxy template.** Admin -> Keys ->
   `EVOLUTION_PROXY_TEMPLATE`, one URL containing `{session}` (required) and
   `{country}` (optional), e.g.
   `socks5://USER:PASS_country-{country}_session-{session}@gateway:port`.
   Each traveller gets a stable exit IP in a plausible country.
   (`EVOLUTION_PROXY_POOL` is deprecated - editing the pool remaps everyone.)
2. **Do not raise `EVOLUTION_MAX_PER_HOST` above 25** on a 512 MB box to
   "save money". It is not a licence limit, it is a safety limit: Evolution's
   own stated production floor is 2 vCPU / 2 GB, and when a box OOMs every
   socket on it drops at once and every one of those numbers starts
   reconnecting together. A bigger host earns a bigger number; a bigger number
   does not earn a bigger host.
3. **Add hosts BEFORE the invites go out**, not after. Capacity added after a
   ban does not undo the ban.

### How do I know it worked
Admin -> Keys:

- **Choke points card** -> *WhatsApp host occupancy*. Green until any single
  host passes **80%** of the cap, then red with the host named. This is the
  number to watch before every invite wave.
- **WhatsApp host pool card** -> "Check hosts" shows every host, healthy or
  not, with its live session count and a per-host "Test this server" button.
- **Ban risk tab** for the enforcement-axis view.

---

## 2. Redis - the switch that makes your safety caps real

### What is it
A tiny, very fast shared memory that every copy of your app can see. Your app
uses it for four things: the **atomic daily caps** (AI spend, send volume), the
AI budget cache, the copy-uniqueness window (so two travellers never send
identical text), and the live session fan-out.

### What is the limit today
**It is not set.** `REDIS_URL` is passed through the Cloud Run deploy as an
*optional* secret, and when it is absent every "atomic" cap degrades to a
counter that lives inside **one instance's memory**.

Read that consequence slowly, because it is the least obvious thing in this
document: your app runs with `--max-instances 20`. Twenty instances, each with
its own private counter, each believing it is the only one. **A cap of 100 can
be exceeded up to 20 times over.** The dial in the admin panel says the spend is
capped. Without Redis, it is not.

### What breaks first
| Simultaneous users | What happens |
|---|---|
| **Under ~30** | Cloud Run mostly runs one instance, so the in-memory counter is accidentally correct. This is why the beta has never seen the problem. |
| **100** | The autoscaler starts a second instance at about 19 in-flight requests. From this point on, every cap is wrong by the instance count - quietly, with no error anywhere. |
| **300+** | Daily AI spend can multiply without warning, and the anti-ban volume ceilings stop being ceilings. |

### What to buy / flip
Create a managed Redis and paste its connection string into **GCP Secret
Manager** as `REDIS_URL` (this one is deliberately **not** pasteable in the
admin panel - see below), then redeploy.

- **Upstash free tier**: 500,000 commands and 256 MB per month, $0. This
  genuinely covers a beta and probably your first hundred users.
- **Upstash pay-as-you-go**: $0.20 per 100,000 commands after the free bucket.
- **Upstash fixed plans**: from $10/month (250 MB, 10,000 commands/second) when
  you want a predictable bill instead of a metered one.
- Your app uses the **ioredis** client over a normal TCP connection, which is
  the right choice on Cloud Run because instances are long-lived and reuse the
  connection.

**Why is `REDIS_URL` the one key you cannot paste into Admin -> Keys?**
Because the Redis client is created from `process.env.REDIS_URL` the first time
it is needed, inside a module that also runs in the worker services where the
admin vault is not in the request path. A pasteable field would say
"configured" and change nothing - the worst possible lie for this particular
key. It is *listed* in the Keys page so you can see and test it; it is *set* in
your host's environment.

### How do I know it worked
Admin -> Keys:

- **Service health card** -> a **Redis (atomic caps + hot state)** row. Grey
  "NOT SET" is the honest degraded mode with the 20x warning spelled out;
  green shows the real **PING round-trip in milliseconds**; red means it is
  configured and *not answering*, which is the dangerous state.
- The **`REDIS_URL` key row** now has a working **Test API** button that fires
  a real PING.

---

## 3. Supabase - the database everything leans on

### What is it
Your database, and also the encrypted vault where every key you paste in the
admin panel is stored. Every read and write your app makes is an HTTPS call to
Supabase's API layer (PostgREST).

### What is the limit today
This is the most commonly misunderstood limit in the whole system, so here it
is precisely:

- Your app **does not** open direct Postgres connections, and **does not** use
  the connection pooler (Supavisor/pgbouncer). Neither of those is in your
  request path at all. Ignore advice about them.
- The real limit is **PostgREST's own internal pool, which defaults to 10
  connections.** Every request from every one of your instances shares those 10.
- **Pool exhaustion does not fail fast.** Request 11 does not get an error - it
  **waits** in a queue until the pool-acquisition timeout, and only then
  returns a **504**. This is why the first symptom you will ever see is "the
  app feels slow", not "the app is erroring".
- After a connection loss PostgREST answers **503 with a Retry-After header**.
- There is **no application-level rate limiting** on the Supabase Data API -
  only Cloudflare's DDoS protection at the edge. Nothing will politely throttle
  you before you hit the wall.
- The connection numbers are **hard-coded per compute tier**. The only way to
  move them is to buy more compute.

| Compute tier | Direct connections | Pooler connections | Cost |
|---|---|---|---|
| Nano (Free) | 60 | 200 | $0 |
| Micro | 60 | 200 | ~$10/month |
| Small | 90 | 400 | ~$15/month |
| Medium | 120 | 600 | ~$60/month |
| Large | 160 | 800 | ~$110/month |
| XL | 240 | 1000 | ~$210/month |
| 2XL | 380 | 1500 | ~$410/month |

The **Pro plan is $25/month** and includes a **$10 compute credit** (which pays
for one Micro), 8 GB disk, 250 GB egress, 50,000 monthly active users and 200
concurrent Realtime connections (cap 500). Egress over 250 GB is **$0.09/GB**.

### What breaks first
| Simultaneous users | What happens |
|---|---|
| **100** | Free/Nano still copes, but latency starts creeping because requests queue for the pool. Watch the number, do not wait for an error. |
| **300** | You will see intermittent **504s** - the pool-acquisition timeout. It will look random and it is not. |
| **500** | Sustained queueing. Also watch egress: at 250 GB you start paying $0.09/GB, and image/media traffic is what gets you there. |

### What to buy / flip
1. Upgrade to **Pro ($25/month)** - this is the point where the free tier stops
   being a reasonable place to keep a real product's data anyway.
2. Move compute up as latency demands: **Micro** (covered by the credit) ->
   **Small (~$15)** at a few hundred users -> **Medium (~$60)** if the app
   becomes genuinely busy.
3. Run `supabase/schema.sql` once (Dashboard -> SQL Editor -> paste -> Run). It
   is idempotent and carries the hot-path indexes.
4. Run `supabase/retention.sql` once. It prunes 90-day-old rows and rolls usage
   up into daily summaries, which is what keeps the tables (and the bill) from
   growing forever - and it revokes the default PUBLIC grant on
   `prune_old_rows`, without which anyone holding the browser-side anon key can
   call that function and delete your history.

Console steps: Supabase Dashboard -> your project -> Settings -> Add-ons ->
Compute size -> pick the tier -> confirm. It restarts the database, so do it at
a quiet hour.

### How do I know it worked
Admin -> Keys:

- **Choke points card** -> *Database round trip*, measured on a single-row read
  through exactly the client the app uses. Green under 400 ms, amber to
  1,500 ms, red above - and red says explicitly that the pool is queueing.
- **Connection tests** -> "Test Supabase".
- The persistence banner at the top of the Keys tab must say persistence is ON.

---

## 4. Cloud Run - the web server

### What is it
Google runs your Next.js app in containers and starts more of them when you get
busy. You pay for CPU and memory by the second while a request is being served.

### What is the limit today
Your deploy is (from `.github/workflows/deploy-gcp.yml`):
`--memory 1Gi --cpu 1 --concurrency 32 --min-instances 1 --max-instances 20
--timeout 90`.

What those numbers actually mean:

- **`--concurrency 32`** = up to 32 requests at once per container. The
  autoscaler does not wait for 32 - it starts a new instance at **60% of the
  concurrency setting**, so a new container appears at about **19 in-flight
  requests**.
- **Fleet ceiling = 20 x 32 = 640 concurrent requests.** That is your hard
  wall today, and it is comfortably above the WhatsApp wall in section 1.
- Platform hard limits, for reference: 1,000 concurrency per instance, 100
  max instances by default, 32 GiB memory, and a 60-minute request timeout
  ceiling - but **your deploy sets `--timeout 90`, and 90 seconds is the number
  that matters.** `export const maxDuration = 60` appears in 19 route files and
  is INERT: it is a Vercel hint, and this app runs `node server.js` from a
  standalone build. Before the flag was set, a hung upstream held a Cloud Run
  concurrency slot for five minutes while the client that fired it had long
  given up.
- **Cost**: $0.00002400 per vCPU-second and $0.00000250 per GiB-second, with
  180,000 vCPU-seconds, 360,000 GiB-seconds and 2,000,000 requests free every
  month. A single warm `--min-instances 1` container costs roughly
  **$10-12/month** - that is most of your current Google bill, and it buys you
  no cold starts.

**Where the client's IP comes from, and why it matters here.** Every
sessionless limit in the app (forgot-password, feedback, the billed Places
proxy) is keyed on the caller's address, and Google's front end does **not**
replace `X-Forwarded-For` - it **appends** the address it observed to whatever
the caller already sent. So `X-Forwarded-For: 1.2.3.4` arrives as
`1.2.3.4, <real ip>`: the *left* end is written by the attacker and the *right*
end is written by Google. `lib/rate-limit.ts` reads the right end. Today that is
the last entry, because this service is reached through a **Cloud Run domain
mapping** (`wheeldeal.pro` A/AAAA records point straight at Google - see
`docs/LAUNCH-wheeldeal.pro.md`), with no load balancer or CDN in front.

If you ever put one in front - a global external Application Load Balancer,
Cloudflare, anything - **set `TRUSTED_PROXY_HOPS`** to the number of addresses
that proxy appends after the client's (a Google external ALB appends its own, so
`1`). Get it wrong in that direction and nothing is exploitable: the app keys
its limits on the proxy's constant address, which is one shared bucket - strict,
not open. The one thing it will never do is trust hop 0.

**One deliberate non-decision:** the deploy does **not** pass
`--no-cpu-throttling`, and that is correct. With request-based billing, the CPU
freezes the moment a response is flushed - which is exactly why the queue drain
kicks itself over HTTP instead of leaving a timer dangling that would never fire.
Do not "fix" this.

### What breaks first
Honestly? Very little. This is the most elastic part of the system.

| Simultaneous users | What happens |
|---|---|
| **100** | About 3-6 instances. Fine. |
| **300** | About 10-15 instances. Fine. Memory per instance is the thing to watch if AI turns get heavier. |
| **500** | Approaching the 20-instance ceiling. Raise it. Note that every extra instance makes the missing-Redis problem in section 2 worse, not better. |

### What to buy / flip
Edit the deploy workflow and redeploy:

- `--max-instances 20` -> `40` when you pass a few hundred simultaneous users.
- `--memory 1Gi` -> `2Gi` if you see out-of-memory restarts in Cloud Run logs.
- Leave `--concurrency 32` alone unless you measure a reason. Raising it makes
  each instance hold more concurrent AI chains, which is the thing the inbound
  gate in section 6 exists to prevent.

### How do I know it worked
Admin -> Keys -> **Deploy info card** shows the revision actually serving.
Google Cloud Console -> Cloud Run -> your service -> Metrics -> "Container
instance count" and "Request latency".

---

## 5. The queue drain - the thing with no owner

### What is it
Messages do not go out the instant they are composed. They are paced (that is
the anti-ban design) and parked in a queue called `wa_outbox`. Something has to
come along and drain it. That something is a **ping** to `/api/wa/ping`.

Today the ping comes from: a **Cloud Scheduler** job the deploy workflow creates
(every minute), any open app tab, every webhook tail, and an in-process armer
that self-kicks over HTTP when a reply comes due.

### What is the limit today
Cloud Scheduler is effectively free - **3 jobs per month free, then $0.10 per
job per month**, with a one-minute minimum granularity. Cost is not the issue.

The issue is that **nothing watches the watcher**. If the scheduler job is
never created (the deploy says so loudly but does not fail), or its token
rotates, or it silently stops, then nothing drains and **nothing tells anyone**.
Queued messages only move while somebody has the app open. This has happened
before in this product.

### What breaks first
This does not degrade with scale - it is binary, and it is already broken until
you verify it. At any user count, a dead drain means introductions and timed
replies simply do not send.

### What to buy / flip
1. **Verify the Cloud Scheduler job exists.** Cloud Console -> Cloud Scheduler
   -> look for the ping job, schedule `* * * * *`, state ENABLED. If it is not
   there, the deploy service account is missing `roles/cloudscheduler.admin`.
2. **Add a second, monitored pinger** that alerts a phone - UptimeRobot or
   Better Stack pointed at the same URL every 5 minutes. The point is not
   redundancy of the ping. The point is that **someone finds out**.
3. Get the ready-made URL (token included) from Admin -> Keys -> **Cron
   keep-alive URL** and paste it in. Do not compute the token by hand.
4. **Test the alert by breaking it.** Pause the primary job for five minutes and
   confirm an alert actually arrives. An untested alert is not an alert.

**If you outgrow simple pinging** (many hundreds of users, and you want real
per-second pacing rather than per-minute waves), the right next primitive is
**Cloud Tasks**, not Pub/Sub. Cloud Tasks gives you per-queue dispatch-rate
control (up to 500 dispatches/second), scheduled delivery, per-task
deduplication and configurable retries. Pub/Sub push has none of that - it has
no rate control at all, which is the one feature that matters for outbound
pacing.

### How do I know it worked
Admin -> Keys -> **Choke points card** -> *Queue drain heartbeat*: the age of
the last ping, green under 5 minutes, red past 10 with the difference between
"it never ran" and "it ran and stopped" spelled out, because those have
different fixes.

---

## 6. The webhook front door - inbound message floods

### What is it
Every time a rental shop replies, Evolution POSTs that event to your app, and
your app runs the full AI chain (read -> decide -> compose -> validate ->
localize) **inside that webhook request**.

### What is the limit today
- A per-instance gate caps **heavy turns at 4 concurrent** (`MAX_INFLIGHT = 4`
  in `src/lib/wa/inbound-gate.ts`). Without it, `--concurrency 32` would mean
  32 simultaneous LLM chains on one 1 GB container.
- It is a **smoother, not a limiter**: a waiter past its patience window
  (50s - sized above the p95 turn, so the gate genuinely queues; the old 8s
  window was shorter than a single 15-45s turn and expired on the FIFTH
  concurrent turn, buying latency and no protection) proceeds ungated,
  because a gate must never eat a shop's reply.
- The work is **bounded, not offloaded**. It still runs inside the webhook.

### What breaks first
| Simultaneous users | What happens |
|---|---|
| **100** | Fine. Replies arrive spread out. |
| **300** | Mid-morning bursts (shops open, everyone answers at once) queue behind the gate of 4. Reply latency climbs (the queue is real now - turns wait their turn instead of running ungated). |
| **500** | Queued waits regularly exceed the 50s patience window, chains run ungated and memory spikes. In practice bursts bind FAR earlier than this row once claimed - ~5 concurrent turns already queue. |

### What to buy / flip
The strongest fix is not on your side of the wire. **Evolution supports
streaming its events to RabbitMQ, Kafka or SQS instead of POSTing them straight
at you.** That moves the burst off the HTTP path entirely, which is better
protection than any receiver-side guard can be - you cannot be flooded by
requests that were never sent to you.

Short of that, the industry-standard shape for a webhook receiver, and the one
to aim for:

1. **Verify the signature, enqueue the payload, ACK in under ~500 ms.** Do the
   work afterwards.
2. **Idempotency on the provider's own event id**, held in Redis for 7-30 days,
   so a redelivery cannot double-send.
3. **Per-key rate limits**, so one busy traveller cannot starve everyone else.

Your app already does (2) and (3) at the database layer; (1) is the BullMQ
worker upgrade that `services/workers` exists for and which is **not currently
provisioned**.

### How do I know it worked
Admin -> Keys -> **Service health** -> the webhook-silence alert (it fires when
you have sent recently, a session is open, and **no** inbound has arrived in
30 minutes - the signature of Evolution rejecting your webhook), plus the WA
doctor's "Re-arm webhook" button.

---

## 7. AI providers - twelve of them, in a failover chain

### What is it
Nine free providers (Groq, Cerebras, DeepSeek, Together, SambaNova, OpenRouter,
Mistral, Hugging Face, Gemini) and three paid ones (Anthropic, OpenAI, Kimi),
tried in order. If one is out of quota or has retired a model id, the next
answers. A free rung answering means no bill.

### What is the limit today
- Free tiers are **daily or monthly quotas that reset**, not hard failures. The
  chain is the design: run out on one, continue on the next.
- **Only two providers expose a live remaining-quota figure.** The "tokens used
  this cycle" number on the AI providers card is a **self-reported estimate**,
  and the code says so itself. Do not treat it as a contract.
- Model ids drift. That is why every provider has a `<PROVIDER>_MODEL` override
  you can paste without redeploying.
- **Groq is two billed products behind one key**: chat completions *and*
  voice-note transcription. Until Wave 7 the key test only exercised chat, so a
  working chat key could sit next to a completely dead voice-note path with the
  same green chip.

### What breaks first
| Simultaneous users | What happens |
|---|---|
| **100** | Free tiers cope. Latency is the visible cost, not money. |
| **300** | Daily free quotas exhaust mid-afternoon; the chain falls further down and answers get slower. |
| **500** | You will be on paid rungs for a meaningful share of turns. This is the point to actually look at the money. |

### What to buy / flip
1. Add keys for **all** the free providers, not some. Each one is a free rung
   between you and a bill.
2. Add **one** paid key (Anthropic or OpenAI) as the last rung, so a bad day
   degrades into a small charge rather than a deterministic-template
   negotiation.
3. Use `AI_PROVIDER` to set your preferred first rung.
4. Set `LIMIT_AI_PER_DAY` - **and note that this cap is only real once
   `REDIS_URL` is set** (section 2).

### How do I know it worked
Admin -> Keys -> **AI providers** card -> "Test AI providers" sweeps every
configured provider and shows which model answered and how fast, including a
"the primary failed and the fallback answered" warning that tells you a model
id has drifted.

Then, separately:

- **`GROQ_WHISPER_MODEL` -> Test API** posts a real (silent, ~free) audio clip
  to Groq's transcription endpoint. This is the **voice-note SKU tested as
  itself**. It can fail while chat is perfectly healthy.
- **`GEMINI_VISION_MODEL` / `GROQ_VISION_MODEL` / `ANTHROPIC_VISION_MODEL` ->
  Test API** each send a real one-pixel image to the exact model id the ladder
  would use first. These buttons used to exist and always answer "No test
  available for this key", which meant the one failure they were created to fix
  - a provider retiring a multimodal id - was the one thing the panel could not
  check.

---

## 8. Maps and geocoding

### What is it
Google Maps finds rental shops and turns addresses into coordinates.
**OpenStreetMap Nominatim is the free fallback** whenever Google is unset, over
quota, or restricted - including the no-key path a fresh deployment runs on.

### What is the limit today
- Google Maps is pay-as-you-go per API call, per SKU. Search, autocomplete,
  geocoding and **photos** are separate SKUs that can be enabled and can fail
  independently - which is exactly how photos once failed while the whole panel
  showed green.
- **Nominatim throttles and blocks datacenter IPs.** A scaled deployment *is* a
  datacenter IP. So the moment the free fallback is most needed is the moment
  it is most likely to refuse you, and until Wave 7 nothing had ever probed it.

### What breaks first
| Simultaneous users | What happens |
|---|---|
| **100** | Fine. Vendor-discovery results are cached for 6 hours per query (geocoding for a day), so repeat searches in one town are free. |
| **300** | The Maps bill becomes a real line item. Restrict the key by referrer/IP so it cannot be scraped. |
| **500** | If Google is misconfigured and you silently fall through to Nominatim, address search returns nothing and looks like a product bug. |

### What to buy / flip
Set `GOOGLE_MAPS_API_KEY` and enable, in Google Cloud Console: **Places API
(New)**, **Places API (legacy)**, **Geocoding API**, and **Place Photos**. Set
a budget alert on the project. Do not rely on Nominatim in production.

### How do I know it worked
Admin -> Keys -> `GOOGLE_MAPS_API_KEY` -> **Test API** now reports four things
including a new **"OpenStreetMap fallback"** line, and **Service health** has
its own **OpenStreetMap (keyless geocoder)** row that says plainly when
OpenStreetMap is blocking this server's IP.

---

## 9. Email

### What is it
Signup verification codes and feedback notifications. Three providers, tried in
order: **Gmail SMTP -> Brevo -> Resend**.

### What is the limit today
- **Gmail App Password**: free, no domain needed, roughly **500 emails/day**.
  Gotcha: it must be a 16-character App Password, not your login password.
- **Brevo**: 300 free emails/day, needs one verified sender address.
- **Resend**: needs a verified domain. Gotcha: the shared sandbox sender only
  delivers to the account owner until you verify a domain - the number-one
  "I set the key and got no email" complaint.
- Without any of them, invited testers sign up **with no verification code at
  all**.

### What breaks first
At 300+ users signing up in a wave, Gmail's ~500/day is a real ceiling. Move to
Brevo or Resend with a verified domain before a launch push.

### How do I know it worked
The **Service health** email row is now a **live credential check**, not a
configuration check. It opens a real SMTP session and authenticates (sending
nothing), and asks Brevo and Resend to confirm their keys. Its label tells you
which kind of check it was - the old row called `emailVerificationAvailable()`,
which only asks whether a *string* is present, so a revoked Gmail App Password
reported HEALTHY on the path that delivers signup codes.

---

## 10. Payments (PayPal)

### What is it
Subscription checkout for the Pro and Ultra plans, plus a webhook that is the
**only** thing that can lower somebody's plan when they cancel.

### What is the limit today
No meaningful volume limit at your scale. The risk is configuration, not load -
specifically the webhook id, which is environment-specific. A live webhook
verified against a sandbox id fails signature verification and every
subscription event is silently discarded.

### What to buy / flip
Set `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_PLAN_PRO`,
`PAYPAL_PLAN_ULTRA`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_ENV=live`. Then make **one
real purchase on a real card**, confirm the plan applies, then cancel and
confirm the downgrade lands.

### How do I know it worked
Admin -> Keys -> **PayPal webhook doctor**. This is the best health check in
the codebase and the standard the others are now measured against: it verifies
your stored webhook id against PayPal's **live list of webhooks**, and it
treats an empty list as a **failure**, not a pass - because an id that matches
nothing can never verify a signature.

---

## 11. Push notifications (Web Push / VAPID)

### What is it
Browser notifications telling a traveller a shop replied. Keys are
auto-generated on first use; you only paste your own to override.

### What is the limit today
Free, and per-browser. The real failure mode is silent: a subscription expires,
or the sender identity changes, and notifications stop for that person only.

### How do I know it worked
The **WA doctor** carries a genuinely good per-user push diagnostic. It is
buried one level down and it is not in the health roll-call - noted here as a
known gap rather than pretended away. `push24h` on the Service health card
gives you the fleet-level failure rate.

---

## 12. The official business number (WABA) - optional, and OFF

### What is it
An optional path where **WheelDeal's own** WhatsApp Business number makes first
contact with a rental shop, instead of the traveller's personal number. It
ships **off** (`WABA_ENABLED` unset) and in **dry run** (renders the exact wire
text, sends nothing).

### What is the limit today
- **Messaging tier**: 250 unique recipients per 24h unverified, 1,000 after
  business verification. **This number lives in your vault as a string you
  typed** (`WABA_TIER_UNIQUE_PER_DAY`) - nothing read it from Meta, so it could
  drift from reality without a trace. Same for `WABA_QUALITY_RATING`.
- Template messages cost money per send; free-form replies inside a 24-hour
  service window do not, and do not count against the tier.
- The account is **rented** through a reseller, so quality rating is not a
  metric - it is an asset that can be taken away.

### How do I know it worked
Any `WABA_*` key -> **Test API** now runs the whole block: shape checks (https
base URL, no trailing slash, sender id present, link base valid), a live
read-only reachability call against the phone-number node, and - the important
part - a **DRIFT** line when the tier or quality rating you typed disagrees
with what Meta actually reports.

---

## Keeping GitHub Actions free

This one is arithmetic, and it bit us. **GitHub bills a minimum of one minute
per job run**, no matter how short the job is. The queue-heartbeat workflow is a
single `curl` that finishes in seconds - but at a `*/5` schedule it ran 288
times a day, billed as 288 minutes, or **~8,640 minutes a month**. A private
repo gets 2,000 free. So more than four times the entire allowance was being
spent on rounding, by a job doing almost nothing.

It is hourly now (~720 min/month), which leaves the rest of the allowance for
CI. The verify job (three typechecks, the full vitest suite, the production
build and the browser journeys) runs about 10-15 minutes, twice per shipped
change - once on the dev branch, once on the master merge - so roughly 20 ships
a month costs another ~480 minutes. Total ~1,200 of 2,000.

Three ways to stop paying entirely, in order of how much they cost you:

1. **Make the repository public.** Public repos get UNLIMITED free Actions
   minutes - the allowance only exists for private ones. No secret lives in this
   repo (that is the first golden rule in CLAUDE.md), so the exposure is
   competitive, not a security question. This is the only option that scales
   without you thinking about it again.
2. **Replace the GitHub heartbeat with a free external monitor.** UptimeRobot's
   free tier does 5-minute checks at no cost and, unlike a workflow, actually
   ALERTS somebody when the drain stops - which is the thing section 5 says you
   need anyway. Once it and Cloud Scheduler are both confirmed live, delete
   `.github/workflows/heartbeat.yml` and the 720 goes to zero.
3. **Set a $0 Actions budget** in billing settings. This does not reduce usage;
   it blocks overage spend instead of billing it, so the worst case becomes
   "CI stops until the 1st" rather than an invoice.

---

## The monthly cost envelope

Ranges, not promises. Excludes Google Maps (usage-based - watch your own
console), paid-LLM overage, and WABA template sends.

| | Today (25 testers) | 100 simultaneous | 300 simultaneous | 500 simultaneous |
|---|---|---|---|---|
| **WhatsApp hosts** (Evolution) | 1 x starter $7 | 3 x starter ~$21 | 8 x starter ~$56 | 13 x starter ~$91 |
| **Evolution database** | basic-256mb ~$6 | ~$6 | ~$6-19 | ~$19 |
| **Supabase** | Free $0 | Pro $25 (Micro on the credit) | Pro + Small ~$30 | Pro + Medium ~$75 |
| **Redis** | unset $0 (**caps not real**) | Upstash free $0 | Upstash fixed ~$10 | ~$10-20 |
| **Cloud Run** | ~$10-12 | ~$12-20 | ~$25-40 | ~$40-70 |
| **Cloud Scheduler** | $0 | ~$0.10 | ~$0.10 | ~$0.10 |
| **Email** | Gmail $0 | Gmail $0 | Brevo/Resend ~$0-20 | ~$20 |
| **Monthly total** | **~$23-25** | **~$64-72** | **~$127-175** | **~$255-295** |

Two things worth noticing in that table:

- The **jump from today to 100 users is almost entirely Supabase Pro plus two
  more WhatsApp hosts.** It is a small amount of money for a large amount of
  headroom.
- **Redis is the cheapest line and the most consequential.** At $0 on the free
  tier it turns your safety caps from decorative into real.

---

## What this guide does NOT solve

Stated plainly, because a scaling document that only lists wins is a marketing
document.

1. **Retention is owner-run SQL.** `supabase/retention.sql` exists and is
   idempotent, but nothing runs it for you. Until you paste it into the SQL
   editor once, your tables grow forever and so does the bill - **and the
   `prune_old_rows` function stays callable by the public anon key**, because
   PostgreSQL grants EXECUTE to PUBLIC by default and Supabase publishes that
   over the Data API. The revoke now lives in the same file, immediately after
   the CREATE, so running it once closes both. Admin -> Keys -> Connection tests
   -> **"Check anon RPC lockdown"** asks your live database which state it is in
   (and says "unknown" rather than green when it cannot tell).
2. **There is no error tracking.** Nothing in this codebase talks to Sentry or
   any equivalent. The three event kinds that `PRODUCTION-READINESS.md` says
   should page someone - `wa-send-dropped`, `wa-ban-risk`,
   `wa-send-expired`, `host-geo-mismatch`, `media-fetch-failed`,
   `wa-rep-bump-degraded` - are written faithfully to the database and read by
   **nobody** unless a human opens the admin panel. Wave 7 puts their 24-hour
   counts and the age of the most recent one on the choke-point card, with an
   "email me this digest" button that uses your existing email provider. That
   is a **pull**, not a **page**. It is deliberately not a new dependency and a
   new bill, and it is deliberately not as good as a real alerting pipeline.
   (`wa-rep-bump-degraded` is the newest and the quietest: the atomic safety
   counters refused a write for a reason other than "the migration has not been
   run", so they silently fell back to the racy path and will UNDER-count. The
   risk gauge then reads *healthier* than the truth on exactly the numbers
   closest to a ban. Nothing else surfaces it, because the app keeps working.)
3. **Supabase egress is measured by the app, not by whoever happens to be
   watching.** The read path counts its own bytes at the two `sbSelect`
   chokepoints and flushes at most one `api_usage` row per instance per 15
   minutes (kind `sb-egress-bytes`); the choke-point card projects it to 30 days
   against the free 5 GB. Read path only - writes, Storage and Realtime are not
   in it - and it over-states where transport compression is active, which is
   the right direction to be wrong in for a safety ceiling. It refuses to
   project a month from under 12 hours of traffic, because a confident wrong
   number on a launch panel gets acted on where a dash does not.
4. **The workers VM is not provisioned.** `services/workers` and the BullMQ
   offload path exist in the repo. Nothing runs them. Inbound webhook work is
   *bounded* (4 concurrent heavy turns per instance), not *offloaded*.
5. **The second monitored pinger is a runbook step, not code.** Section 5 tells
   you to add it. Nothing in this repository will notice if you do not.
6. **AI "remaining quota" is an estimate for ten of the twelve providers.** The
   panel says so; believe the panel.
7. **The WABA tier and template cost are values you typed.** The new drift check
   catches disagreement *when you press it*. It does not watch continuously.
8. **Evolution's own memory ceiling is not instrumented.** The app knows how
   many users it has placed on a host. It does not know that host's RAM. Watch
   it in Render's dashboard.

---

## The ten-minute check, after any of the above

Admin -> Keys, top to bottom:

1. **Deploy info** - the revision serving is the one you deployed.
2. **Choke points** - every reading green: host occupancy under 80%, invited
   testers inside fleet capacity, Supabase egress projecting under 60% of the
   free 5 GB, heartbeat under 5 minutes, database under 400 ms, no paging
   events in 24h.
3. **Service health** - "Check now". Every configured service green, including
   the new Redis, OpenStreetMap and live-email rows.
4. **WA doctor** - a real inbound traced end to end.
5. **PayPal doctor** - "verified".
6. **AI providers** - "Test AI providers", every configured provider answering
   on the model id you expect.
7. Press **Test API** on `REDIS_URL`, `GROQ_WHISPER_MODEL`, the three vision
   model keys, and any `WABA_*` key you use.

If all seven pass, the system is as ready as this codebase can tell you it is.
The parts it cannot tell you about are in the section directly above.
