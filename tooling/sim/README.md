# Dev mode: a town full of rental shops

Run the whole funnel on your laptop - search, outreach, shop replies, price
extraction, negotiation - with no WhatsApp account, no Evolution server and no
production keys.

```bash
./tooling/dev/local-db.sh     # Postgres + PostgREST, schema applied, grants fixed
npm run dev:sim               # the app + the simulated shops + a drain ticker
```

Then open http://localhost:3000, and watch:

- `http://127.0.0.1:8788/sim/events`  - every message on the wire, both directions
- `http://127.0.0.1:8788/sim/threads` - each shop's persona, floor and quotes
- `http://127.0.0.1:8788/sim/sla`     - reply latency, p50/p95, and every breach of 10s

## How it works, and why it is shaped this way

The simulator does not patch the app. It impersonates the thing the app talks
to: it answers the Evolution API v2 endpoints the code already calls, so every
send goes through the real guard, the real pacing, the real claims, the real
outbox and the real webhook authentication. Nothing in `src/` knows it exists,
and no "if simulating" branch can drift from production behaviour.

The shops are real little businesses (`shops.mjs`): each has an opening price,
a floor it will not cross, a language, a currency, a way of writing numbers and
a temper. The ECONOMICS are deterministic, derived from the phone number, so a
shop behaves identically across restarts and a failing case can be reproduced.
Only the WORDING varies - from templates, or from a local Ollama model when
`SIM_LLM=1`.

Quirks are deliberate, because the app has to survive them: bursts of three
messages, price-board photos, voice notes, weekly packages instead of daily
rates, "not available", shops that never answer, and a minority that quote in
USD instead of the local currency.

## The stopwatch

The simulator records when a shop's message leaves it, and matches our answer to
that shop back to it. The latency is therefore measured OUTSIDE the app, from
the shop's point of view - it cannot be flattered by our own instrumentation.
`/sim/sla` reports p50, p95 and every reply that took longer than ten seconds.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `SIM_MARKET` | `bali` | bali, thailand, philippines, vietnam, goa - sets currency, prices and languages |
| `SIM_LLM` | off | `1` to have a local model write the shops' messages |
| `SIM_OLLAMA_MODEL` | `qwen3:14b` | which local model writes them |
| `SIM_PORT` | `8788` | the fake Evolution host's port |
| `SIM_APP_URL` | `http://127.0.0.1:3000` | where the app is |

## Two things that will bite you

**`APP_DOMAIN` must be local.** The app registers its webhook URL at
`APP_DOMAIN`, which defaults to the live site - so without an override it hands
the simulator a production URL and invented shop messages get posted at the real
server. The simulator refuses any non-loopback webhook target and says so
loudly, but set `APP_DOMAIN=http://localhost:3000` in `.env.local` anyway.

**The grants.** Supabase Cloud grants new tables to `service_role`
automatically; a locally applied schema does not, so every read answers
`permission denied` and the app - correctly - reports an unreadable store while
appearing to work. `local-db.sh` applies the grants and reloads PostgREST's
schema cache.
