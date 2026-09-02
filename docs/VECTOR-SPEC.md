# Semantic retrieval (pgvector) - SPEC FOR REVIEW

**Status: design only. Nothing here is implemented.** The owner reads this
before any code is written, per instruction. A previous version of this spec was
blocked 3/3 by adversarial review; section 0 states what was wrong with it,
because a spec that does not say what it got wrong last time is asking to be
trusted rather than checked.

---

## 0. Two corrections to the blocked spec

### 0.1 The `offers` insert is off limits

`src/lib/agent-loop.ts:1850-1876` is a four-rung degrading insert whose **rung 4
IS `offerBase`** (`:1792-1816`), and rung 3 is
`base = { ...offerBase, search_id: searchId }` (`:1850`). So any field added to
`offerBase` or `base` is present in **all four rungs**: on a database missing
that column every rung 400s and every priced offer is lost.

The loss would have been invisible twice over. The final `sbInsert` return at
`:1874` is discarded, and `"offers"` is not in `TELEMETRY_TABLES`
(`src/lib/runtime-config.ts:565`), so `noteLostTelemetryWrite` never counts it.

**This design writes nothing to `offers`, adds no column to any existing table,
and adds no rung.** The literal grep at `src/lib/rival-integrity.test.ts:151-159`
stays green untouched, because nothing here goes near those lines.

### 0.2 The `similarity.ts` claim, stated correctly

The blocked spec asserted that `similarity.ts` returns empty for Thai, and a
reviewer disproved it by running the real tokenizer. The accurate statement:

`similarity.ts:11` is `.replace(/[^a-z0-9\s]/g, " ")` - an ASCII-only class with
no `u` flag - so non-Latin script is **deleted**. Line 14 then strips ASCII digit
runs and line 16 keeps only tokens longer than two characters. So the function
returns 0 **only when zero ASCII tokens longer than two characters survive on
either side**. Both failure directions are live, and both are now covered by
executed tests in `src/lib/wa/repetition-units.test.ts`:

- an English draft against the Thai rendering of the same sentence scores 0, so
  a real repeat passes the guard;
- two different Thai price lines that both retain the Latin `"day"` reduce to
  `{"day"}` against `{"day"}`, Jaccard 1.0, so a legitimate reply is suppressed.

**The underlying units bug is already fixed and shipped**, in its own commit,
before any of this: `priorOutbound` now prefers `raw.englishGloss` on both
engines, so the guard compares English with English. Retrieval must never be
sold as the fix for a units bug.

---

## 1. THE INVARIANT

> Retrieval may **narrow** the rival set and **suppress** a question. It may
> never **admit** a rival today's predicate rejects, nor **assert** a fact this
> thread has not established.

**Narrowing is a subsequence, by object identity.** Retrieval never queries
`offers`. Its rival-facing entry point is `(rivals, q) => rivals` - a filter and
a stable sort over the input array, with no lookup by id and no second read. So
there is no path by which an object that was not already in the array can
appear in the output. Every existing guard runs first and unchanged: exact
currency, positive vehicle-class match, exact `search_id` scoping, package-basis
rejection, strictly-cheaper, and the declined / out-of-stock eviction.

**Assertion is not retrieval's to grant.** The number-integrity rails run last
and unmodified. See objection 9.2, where the residual risk is conceded and paid
for rather than argued away.

**A row with no embedding scores `null` and is treated exactly as today.**
Refusing an unscored row would silently disable cross-shop leverage the moment a
backfill lagged. The `embedding` column is nullable by design, and an
un-embedded row *is* the write queue entry - one mechanism, two invariants.

---

## 2. The sidecar table

```
public.corpus_embeddings
  id            bigint generated always as identity primary key
  source_table  text not null
  source_id     text not null
  embed_model   text not null       -- 'lexical:v1' | 'gemini:text-embedding-004'
  content_hash  text not null       -- sha256 of the NORMALIZED snippet
  snippet       text                -- what was embedded, capped 1200
  dim           int  not null
  embedding     vector(768)         -- NULLABLE: null means enqueued
  user_email    text
  created_at    timestamptz not null default now()

unique (embed_model, source_table, source_id)
index  (embed_model, content_hash)
index  (created_at) where embedding is null
ANN index on (embedding)            -- guarded, see 3
```

**The content hash is stored but is NOT the identity.** It is the staleness key
(source text changed means re-embed) and the skip key (do not pay twice for the
same sentence). Hash-as-identity would collapse two people's identical sentence
into one row, and the erasure walker deletes by `user_email` - so erasing person
A would delete a row that also serves person B. One shared row cannot carry two
owners.

**Why a sidecar and not a column.** Four reasons, in order of severity:

1. The ladder, section 0.1.
2. `sbInsert` (`runtime-config.ts:582-611`) returns a bare boolean and never
   reads the response body, so it cannot distinguish "column missing" from any
   other 4xx. Every write that adds a field to an existing insert inherits that
   blindness. A sidecar's failure mode is total and local: the row is absent,
   and absence already means "behave as today".
3. Egress and DSAR. `sbSelect` meters every byte it pulls, and the DSAR export
   reads registered tables with `select=*` unless an `exportSelect` narrows
   them. A `vector(768)` column on `vendor_replies` would drag 768 floats
   through every read and into every export.
4. A `vector`-typed column added by `alter table` errors when pgvector is absent
   and can abort the rest of the paste. A sidecar's whole creation fits inside
   one guarded block.

**RLS.** `enable row level security`, no policies, following the stated rule at
`supabase/schema.sql:333-334`. `hardening-invariants.test.ts:247-259` pins seven
named tables today and should gain this one.

**Erasure registry.** A `USER_TABLES` entry keyed on `user_email`, with an
`exportSelect` that omits `embedding` - the same reasoning already on record for
`feedback_images`. This is not a claim that a vector is not personal data. It is
derived from the person's thread; it is registered, not excused.

**Retention.** A delete added to `prune_old_rows` itself, in the `cutoff_mid`
group (180 days). That is at or inside every source's own window, so the sidecar
**never extends** the retention horizon of anything it copies. Adding it to the
function is mandatory rather than optional: the body is a fixed list, so a table
not named there is never pruned at all.

---

## 3. Where the SQL lives - folded into `schema.sql`

**Recommendation, and the owner's decision: fold it into `supabase/schema.sql`.
Do not create a fourth file.**

The doctrine is already written down, at `supabase/retention.sql:241-249`:

> "They shipped first as a separate `supabase/security-fix.sql`, which meant the
> file that creates the hole was the one owners were told to run and the file
> that closes it was referenced nowhere ... **A fix in a file nobody runs is not
> a fix.**"

Two mechanical arguments make it decisive rather than stylistic:

**The erasure completeness test cannot see a fourth file.**
`src/lib/privacy/wave9-erasure.test.ts:68` builds its table universe from
exactly `schema.sql + retention.sql`. A table created elsewhere is invisible to
the "every table is either registered or excused, no third state" test, so it
could ship with no erasure decision at all and the suite would stay green. And
if it *is* registered, the "no ghosts" test goes red, because the table is in
neither scanned file. A fourth file forces a choice between an un-erasable table
and a broken suite.

**The events reconciliation test cannot see it either.**
`src/lib/events-reconcile.test.ts:81` scans SQL writers from exactly those same
two files.

**What `schema.sql` costs**, stated honestly: it is 1839 lines and every owner
re-runs it, so a hard error mid-file could cost tables they already had. Two
structural mitigations: the block goes **last**, and the whole block sits inside
a `pg_extension` guard so it can only ever raise a notice.

**The guard**, in the style of `retention.sql:271-287`:

```sql
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'vector') then
    raise notice 'pgvector not installed - semantic retrieval stays OFF and the
      app behaves exactly as it does today. To enable: Supabase -> Database ->
      Extensions -> enable "vector", then re-run this file.';
    return;
  end if;
  -- create table, RLS, indexes ...
end;
$$;
```

It deliberately does **not** attempt `create extension`, for the same reason
`retention.sql` does not install pg_cron: enabling an extension is an owner
decision made in the dashboard, and a failed create inside an 1800-line paste
can cost the owner the rest of the file.

The table is created **only inside that branch**, on purpose. That makes
"`corpus_embeddings` exists" mean exactly "pgvector was present when the owner
ran this file" - there is no half-migrated state where the table is there and
the vector column is not, so the app needs one probe rather than two.

The ANN index is a try / fallback / notice: `hnsw` needs pgvector 0.5.0 or
newer, `ivfflat` otherwise, and an exact scan is fine below roughly 50k rows.

---

## 4. The runtime gate

Reuse `src/lib/schema-probe.ts:59-70` verbatim in semantics:

- **ready** - feature on.
- **missing** - feature off, degrade to exactly today, breadcrumb **once**.
- **unavailable** - feature off, **no breadcrumb**. An outage is not a migration
  signal, and `sbSelectStrict` is the only read helper that can tell those
  apart.

`NEGATIVE_TTL_MS = 60_000` means positives are cached for ever and negatives
expire in a minute, so the owner pastes the SQL and the feature switches itself
on **without a redeploy**.

Breadcrumbing once uses the `GATE_KINDS` heartbeat shape from
`src/lib/retention.ts:38-101`, whose comment names the trap exactly: a database
missing the function *"would otherwise re-attempt (and re-breadcrumb) on every
single ping, because the thing that would have gated it is the row the missing
function never wrote."*

A new `agent_events` kind and its writer must land in the **same commit**:
`events-reconcile.test.ts` treats a registry entry as a claim and requires a
writer for it.

---

## 5. The write path

Two stages. **No embedding call happens while a shop is waiting for a reply.**

**Stage A - hot enqueue, after the reply is on the wire.** Hooked in `live.ts`
after the turn-telemetry block, where `delivered` is already resolved and
nothing can affect what the shop receives. It performs exactly one insert of a
row with `embedding = null`: no AI call, no vector arithmetic, no Redis.

One correction found while writing this, kept visible rather than quietly fixed:
the obvious helper is `sbInsert(..., onConflict)`, but that path sends
`resolution=merge-duplicates` - an **upsert** - so a re-enqueue would overwrite
an already-computed vector with null. `sbInsertClaim` is the right primitive: a
plain insert whose 409 is reported as `"lost"`, which here means precisely
"already enqueued, nothing to do".

Bounded explicitly. Every `sb*` helper already goes through `timedFetch` at 8
seconds, which is far too long to spend after a send, so the hook adds its own
ceiling in the `withCeiling` shape `comprehension.ts` already uses: skip
entirely below 2s of remaining turn, otherwise cap at 1.5s. The gate probe is a
network read too, so it is inside the same ceiling.

**Stage B - cold backfill, where the embedding calls live.** A new block on the
`/api/wa/ping` cron, in the exact style of the three already there, at an offset
minute. It reads a bounded batch of un-embedded rows with `sbSelectDark` -
which returns `[]` for missing and `null` for unavailable, so an outage is not
mistaken for an empty queue - embeds them, and writes the vectors back filtered
on `embedding=is.null` so a concurrent sweep cannot double-write.

Every network call is bounded, individually: the gate probe and both PostgREST
calls by `timedFetch`, the embedding HTTP by its own 6s `AbortController`, the
telemetry insert by a 1s ceiling, and the Redis budget probe by a **300ms race
that fails open**.

That last one matters and is a pre-existing hazard this design must not inherit
silently: `ai.ts:1169-1185` does `await r.incr(key)` with no timeout, and its
catch handles a rejection, not a hang. Flagged here as a separate defect worth
its own fix; out of scope for this spec.

---

## 6. The embedding provider

**Not a new `ProviderDialect`.** That union describes how a provider speaks on
the **chat** wire, and every surface in `ai.ts` is chat-completions. Adding
`"embeddings"` would make the union a lie and would put a non-chat provider into
the failover order. The code lives in its own module and reuses `getConfig` for
keys and `ai-rpm`'s exported counters for accounting.

**Rung 1, neural:** Gemini `text-embedding-004` via the `GEMINI_TOKEN` already in
the vault. 768 dimensions, which is why the column is `vector(768)`. Stamped
`embed_model = "gemini:text-embedding-004"`.

**Rung 2, keyless lexical fallback:** a deterministic hashed bag of character
n-grams projected into 768 dimensions and L2-normalized. No key, no network, no
failure mode. Stamped `embed_model = "lexical:v1"`.

**A distinct model id is not a naming convention, it is the safety property.**
Cosine between a hashed-lexical vector and a neural one is not merely inaccurate,
it is meaningless - the two live in unrelated coordinate systems - and it does
not fail loudly. Two independent random 768-dimensional unit vectors have cosine
near 0 with a standard deviation of about 0.036, so a mixed pool returns
plausible near-zero scores with occasional spurious highs. That is a silent
wrong answer, the exact class this repo keeps hunting.

Enforced structurally, not by convention: every read filters
`embed_model = <current>` in SQL, so a cross-model comparison **is not
expressible** through the interface; and the unique index includes
`embed_model`, so a source row can hold a lexical and a neural vector at once.
The backfill upgrades lexical to neural by inserting a second row, never by
mutating the first, which makes a model rollback a filter change rather than a
re-embed.

**Budget entries are mandatory.** `ai-rpm.ts:141-142` reads
`if (!capacity) return true; // unknown ceiling -> never our place to refuse`,
so a counter with no `DEFAULT_RPM` entry is **ungoverned by construction**. The
counter is named so that its config override key is usable, and it is kept
**distinct from the chat `gemini` counter** on purpose: sharing one would let a
backfill starve the negotiation chain, which is the wrong trade in every case.

**Interaction with the per-user AI cap**, stated rather than glossed.
`reserveAiCall` counts **calls, not tokens**, and has no per-kind carve-out.

- *Backfill* runs from the cron, which has no user and therefore no budget
  scope, so it returns `"ungoverned"` and is charged to nobody. That is correct:
  charging a traveller for a batch job would degrade their negotiation to pay
  for someone else's corpus.
- *Live embed* is inside a scope, so it raises that phase's governed cost from
  three units to four - a 33% increase on every turn. There is no carve-out to
  hide behind. The mitigation is exact: on `"over-cap"` the embedder falls back
  to `lexical:v1`, which makes zero network calls and needs no reservation.
  Over-cap degrades to lexical; lexical never degrades.

---

## 7. The read path

### The owner's decision: one bounded call in the existing fan-out

`src/lib/spte/comprehension.ts:304-312` is the only true fan-out on the reply
path - three classifiers in `Promise.all` under a hard 7s `withCeiling` with a
5.6s per-call budget. A fourth promise costs the max of four instead of the max
of three, so its marginal wall clock is approximately zero. This is the claim
the blocked spec made falsely and this one can make truthfully. By contrast
`loadCoaching` is serial inside `buildSession` and would pay its full latency.

**One mechanical trap to avoid.** Do not attach the vector to
`TurnComprehension`: that object is serialized into `agent_events.detail`, which
is clipped at 2000 characters, so 768 floats would produce truncated non-JSON
and silently destroy every metric on the row - the exact failure a comment in
`live.ts` already describes for a previous cut. Return it as a sibling instead;
three lines, and the vector is out of every serializer by construction.

**What retrieval can then do:**

1. **Coaching selection.** Today's retrieval is neither semantic nor keyword: a
   `note=in.("lesson:<kind>")` filter driven by a pure seven-boolean function,
   plus three pools ordered by pure recency. A lesson filed under `option-menu`
   is invisible on a turn without a menu, however relevant. Retrieval reorders
   *within* the existing pre-filter, which stays as a coarse gate, and the
   1400-character cap stays.
2. **Question suppression** - if the drafted question is semantically near one
   this thread already asked. Pure narrowing.
3. **Rival narrowing** - drop a rival whose source reply is semantically a
   refusal the deterministic scanner missed. Narrowing only. Semantic *ranking*
   of rivals is explicitly not proposed: rivals are prices, and there is no
   meaningful text-similarity ordering over them.

**What it cannot do:** admit a rival, introduce a number, widen the pre-filter,
or run at all when the gate is not ready or the budget is over-cap.

### Sequencing recommendation

Even with the live call chosen, **ship the corpus and the offline readers
first**, then add the live call as a strictly additive second commit that reuses
the same table, gate and embedder and adds one promise to one existing
`Promise.all`. The corpus alone already improves coaching quality and the distil
loop, at zero reply-path risk; the live call buys suppression and narrowing.

**Corpus sources by value:** `agent_reviews` (`better_response` plus
rating/verdict/tags) is the richest labelled set and the first target;
`vendor_replies` second; `agent_training` is owner-authored and small;
`agent_events` `engine-v3-turn` is clipped to 180 characters, so the sidecar's
1200-character snippet is strictly better material than what the distil loop
mines today; `agent_traces` is written only by the graph engine and is nearly
empty on the path that actually runs.

---

## 8. Tests, written before the code, each executing its subject

1. **Determinism and dimension** - the lexical embedder returns byte-identical
   output twice, length 768, L2 norm 1, and a model id that is not the neural
   one.
2. **The invariant, as a property test** over generated cases including empty
   arrays, all-null embeddings, all-zero and NaN-bearing query vectors: the
   output is a subsequence of the input **by object identity**.
3. **The gate** - stubbed `missing` produces output byte-identical to the
   feature-disabled run; fifty calls produce exactly one breadcrumb;
   `unavailable` produces none; and flipping the stub plus advancing a fake
   clock past the negative TTL flips the gate to ready.
4. **Write bounds** - with a never-resolving insert, a never-resolving Redis
   `incr` and a never-resolving telemetry write, the turn's returned text is
   byte-identical to the no-hook run and the hook returns inside its ceiling.
5. **Write target** - a recording double proves the tables written are exactly
   the sidecar plus at most `agent_events`. *Conceded as partial:* the ideal
   test would drive the four-rung ladder against a double that 400s on unknown
   columns, but that block is inline in a very large function and extracting it
   would break the literal grep that currently guards it. The ladder stays
   untouched and stays guarded; this test asserts positively where retrieval
   does write.
6. **Erasure** - the filter builder produces the right query, the walker issues
   the delete, and `exportSelect` omits the vector.
7. **Budget** - `tryConsume` on the new counter eventually returns false, which
   proves a real ceiling exists rather than asserting a literal; and the
   embedder falls back to lexical on over-cap without a network call.
8. **Latency** - with the fourth promise stubbed to never resolve, the
   comprehension phase still returns inside its ceiling. The existing pins on
   `TURN_WALL_MS` are not duplicated, just not broken.

---

## 9. Adversarial self-review

### 9.1 "Eight new surfaces for a better coaching block, when the repo already solved this offline"

**Largely conceded**, and it is why the sequencing recommendation exists.

The honest sub-concession: a KNN database function is **not** needed at first.
Below a few thousand rows a bounded read plus in-process cosine is enough, and
it needs zero new database functions and therefore zero `security definer`
lockdown surface. The crossover is a real number rather than a feeling: at 768
floats per row a JSON-over-PostgREST scan is roughly 10-15 KB per row, so 10,000
rows is over 100 MB per query, against a 5 GB monthly egress ceiling that a
previous audit ranked first among constraints. So: **in-process cosine in the
first commit, the RPC in the commit that needs it.**

The counter-argument for building it at all: the offline mechanism compiles
*owner-curated* exemplars. It has no way to ask "which of 40,000 shop replies is
relevant to this turn". That is a real gap - but it is worth one table, not
eight surfaces at once.

### 9.2 "The invariant is unenforceable, because retrieval writes into a prompt"

**This is the strongest objection and its core is conceded.**

The first half - never admit a rival - is enforced by the shape of the function,
and I stand behind it. The second half - never assert an unestablished fact - is
**not** enforced by retrieval. It is enforced by the number-integrity rails
downstream, and the "imitate the tone only, never copy a number" wording in the
coaching block is a request to a language model, not a guarantee.

Worse: retrieval makes this axis actively harder. Recency-ranked coaching
surfaces an arbitrary recent exemplar; semantic retrieval surfaces the one **most
similar to this turn**, which is precisely the one most likely to contain a
plausible-looking wrong price for this vehicle in this region. Retrieval raises
the prior probability that a tempting wrong number is in the context window.

The mitigation is a hard requirement of the retrieval path, not guidance:
**retrieved exemplars are number-stripped before they enter the prompt** - every
digit run replaced with a placeholder at assembly time. Today's recency path does
not do this. So on the one axis where retrieval makes things worse, the
retrieval path ships strictly safer than the status quo. Beyond that, the rails
are the guarantee and retrieval is not.

### 9.3 "You duplicated user text into a new table"

**Partly conceded.** The snippet is capped at 1200 characters and is a copy of
text already retained elsewhere; the sidecar prunes at 180 days, at or inside
every source's own window, so the retention horizon does not extend; it is
registered for erasure; and the delete lives in `prune_old_rows` itself rather
than in a separate sweeper that could silently stop running.

Residual risk genuinely not mitigated: a row whose source is pruned first is
briefly orphaned. It is still keyed by `user_email`, so erasure still finds it,
but the corpus can carry a snippet whose source row is gone.

### 9.4 Uncertainties, flagged rather than asserted

- **pgvector version and availability.** `hnsw` needs 0.5.0 or newer. The
  owner's version, and whether their plan permits enabling `vector` at all, are
  owner facts and not repo facts. Hence the try / fallback / notice index block
  and "behaves exactly as today" as the default outcome.
- **Gemini embedding rate limits.** The proposed ceilings are deliberate
  under-shoots in the spirit of the existing table's own comment, not published
  figures.
- **Embedding dimension.** `vector(768)` assumes `text-embedding-004`. If the
  model changes, the column and the lexical projection change together; the
  `dim` column exists so a mismatch is visible in the data rather than inferred.

---

## What the owner is being asked to decide

1. Ship the corpus and offline readers first, then the live call second - or
   both together.
2. Enable the `vector` extension in Supabase (Database -> Extensions), which is
   the one action no code can take.
3. Whether the 33% increase in governed AI calls per turn, degrading to a
   keyless lexical vector when a traveller is over-cap, is an acceptable price
   for live suppression and narrowing.
