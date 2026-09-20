# Revenue, traffic and the management workspace - the build plan

What is being built, in what order, and which decisions were taken and why.
The business plan (Sep 2026) fixes the commercial rules; this fixes the
engineering.

## Where this starts from

Measured on a local hunt against simulated shops, before any of this:

- The dearer shops were never told about a cheaper quote. The trigger compared
  the arriving price against a figure that already contained it, so a shop
  arriving as the cheapest in the hunt woke nobody. Fixed.
- A reply took 17 to 20 seconds, of which about ten were a flat pause that
  never looked at how long the turn had already taken. Fixed; the promise is
  now measured from the shop's own message.
- The regex reader missed "85k sehari" - a perfectly ordinary Indonesian price.
  A small local model reads it without trouble. This is the case for the
  AI-first brain, in one line.
- There is no way to charge a shop. The business plan says so too: "There is no
  way to charge a shop today. It is not built."

## 1. The commission engine

### What the plan fixes, and what it leaves to engineering

The shop pays a flat fee per COMPLETED rental - $3 scooter, $8 compact car,
about 10.9% of a blended rental - and the traveller pays nothing per rental.
A fee is owed only when three things agree: the agent recorded the deal, the
traveller confirmed the pickup, and the shop confirmed the rental on its
monthly list. Silence is never a charge. "No" is never a charge, and is never
argued with.

The rule that keeps it safe, from the plan: **the AI never moves money.** Its
only job is deciding when to ask a person. At 0.90 transcript accuracy, 1,000
rentals a month means a hundred people charged wrongly - survivable as a
question, not as a charge.

### Data model

Four new tables, each user-keyed row registered in `privacy/user-tables.ts`
and covered by retention, erasure and export:

- `partner_shops` - the durable shop record, keyed by the canonical phone key
  the rest of the app already uses (`wa/phone-key`). Terms acceptance, status,
  contact, market, credit balance, confirmation rate. A shop that has never
  accepted terms can never be billed, which is what makes the fee honest.
- `rental_claims` - one row per deal the agent closed: shop, traveller, vehicle
  class, agreed price, currency, pickup time, pickup place, the thread it came
  from, and the evidence trail. States: `recorded` -> `traveller_confirmed` |
  `traveller_denied` | `unanswered` -> `shop_confirmed` | `shop_denied` |
  `expired`.
- `commission_ledger` - the money view of a claim: fee amount and currency,
  `mode` (shadow or live), state `accrued` -> `invoiced` -> `collected` |
  `waived` | `disputed`, and the statement it belongs to.
- `shop_statements` - a month per shop: the claims, the total, the token that
  opens the shop's own page, and what was paid.

### Lifecycle, and who answers each question

1. **The agent writes it down.** At thread close the engine already holds the
   agreed price, the pickup time and the pickup place. A `rental_claim` is
   recorded from the same evidence, never from a fresh guess.
2. **The traveller is asked once**, about three hours after the pickup time:
   "Did you pick up the scooter from Wayan's?" Two buttons. No reminder, no
   second ask. Silence leaves the claim `unanswered`, which is not a charge.
3. **The shop confirms a month at a time**, on a tokenised page (no login) and
   by WhatsApp for shops that prefer to answer in the thread. The AI reads the
   free-text answer ("1 yes, 2 no, 3 didn't come") and proposes a mark; the
   mark is a human's, and anything unmarked is not billed.
4. **Collection.** A new shop buys a small block of introductions (prepaid
   credit) so there is no invoice and no risk to it. After three paid months it
   moves to a monthly statement. A shop that stops confirming stops being sent
   travellers - the only enforcement that matters.

### Shadow mode first

`COMMISSION_MODE` = `off` | `shadow` | `live`, defaulting to **shadow**: every
claim, every confirmation and every fee is computed and recorded, and nothing
is ever charged. That log is the evidence the FTC's DoNotPay order asks for
before any saving or fee claim is made, and it answers the one question the
model turns on - what share of negotiated offers actually become rentals.

### Where the AI is, and where it is not

AI reads the thread and proposes the deal record; AI reads the traveller's and
the shop's free-text answers in any language; AI drafts the statement message.
Code decides nothing about the negotiation, and money moves only on a human
answer. That is the plan's rule kept exactly, with the AI doing more of the
reading rather than less.

## 2. Traffic monetization, done so it survives a review

> **Status 2026-09-20: BUILT**, behind `TRAFFIC_MODE` (off by default). The
> runbook is `docs/SPONSORED-SEARCH.md`. Two things changed from the sketch
> below once Google's current policy was read: the related-search unit takes
> Google's own terms rather than ours (supplying terms became a Restricted
> Access Feature on 25 Aug 2025), and Google's unit is not requested in the
> EEA, the UK or Switzerland until a certified consent platform is installed.
> Still to build from this section: consented first-touch attribution, and the
> no-coverage / hunt-ended / free-limit placements inside the app - only the
> guide and `/search` placements exist today.

Non-converting traffic - no coverage in this area, a hunt that ended with no
deal, the free limit reached, a visitor leaving - is sent to partners
(search-feed partners such as Tonic, parking for domains the company owns such
as Sedo, and travel affiliates whose offers are actually relevant).

Non-negotiable rules, because the revenue is worthless if the account is
closed:

- Every exit is a click the visitor chose. No auto-redirects, no pop-unders, no
  interstitials that look like the product.
- Every placement is labelled "Sponsored" in the visitor's own language, and
  the disclosure says WheelDeal may earn a commission.
- Nothing personal crosses the boundary. The partner gets an opaque sub ID
  encoding placement, market, category and a session hash - never a phone
  number, never an email, never a thread.
- Advertising consent gates the whole module. The cookie layer that landed on
  master already has the categories; this uses them rather than inventing a
  second consent.
- Never inside a live negotiation, and never dressed as a shop offer.

Pieces: a partner registry (destination template, sub-ID scheme, market and
category targeting, revenue share, kill switch), consented first-touch
attribution (source, campaign, landing, referrer) on the existing analytics
pipeline, a click log, revenue import per partner with reconciliation against
our own clicks, and an admin surface reporting revenue per placement, per
market and per 1,000 visitors.

## 3. The management workspace

Today it is fourteen tabs where the command screen mixes KPI tiles with an FAQ
editor, an X post studio and sponsored shops, and "Money" shows signup-funnel
counters with no revenue in them. The rebuild groups it by the question being
asked:

- **Today** - what needs the owner now: SLA breaches, failed sends, disputes,
  restricted numbers, spend against budget.
- **Revenue** - subscriptions, commissions accrued and collected per shop,
  statements, credits, partner traffic revenue, contribution per rental.
- **Shops** - the partner CRM: who answers, how fast, who honours a price, who
  confirms rentals, terms status, suppression.
- **Travellers** - accounts, plans, consent, warm-up, erasure requests.
- **Negotiation** - the live board, the AI's reading and decisions per turn,
  the 10-second SLA, leverage used, golden replay.
- **Growth** - traffic sources, content, partner placements.
- **System** - health, keys, WhatsApp fleet, anti-ban, data console, settings.

## 4. The ten-second reply

Done: the pause is measured from the shop's message and bounded by the promise;
the shop's timestamp is carried into the turn and stamped on the latency event;
the simulator measures the same number from outside the app, where it cannot be
flattered.

Remaining: per-phase timings on the turn record, an SLA panel and alert in the
management workspace, and the honest lane statement - the official Business API
lane can answer inside its 24-hour window with no pacing at all, while the
personal-number lane keeps every anti-ban floor, and replying promptly to a
shop that just wrote to us is the protective signal the anti-ban doctrine
already describes.

## Order of work

1. The AI-first turn read, verified against the simulator (in progress).
2. Commission engine in shadow mode, with the traveller question and the shop
   statement page.
3. Traffic monetization behind advertising consent.
4. The management workspace rebuild, which is where all of the above becomes
   visible.
