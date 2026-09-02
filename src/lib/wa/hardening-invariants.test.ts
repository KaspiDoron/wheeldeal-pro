import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// Source-level regression pins for fixes whose behavior is integration-bound
// (SQL filters, external-fetch timeouts, instance-create bodies) and cannot be
// exercised as a pure unit. These assert the dangerous pattern stays GONE and
// the safe one stays present, so a future edit cannot silently reintroduce the
// confirmed defect.

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
// Strip line + block comments so structural assertions match CODE, not the
// explanatory prose (which deliberately names the patterns being guarded).
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
const count = (hay: string, needle: RegExp) => (hay.match(needle) ?? []).length;

describe("privacy: no unescaped SQL LIKE wildcard on user identity (cross-user leak)", () => {
  it("no `thread_key=like.` QUERY remains in src (graph_wakeups uses user_email=eq.)", () => {
    // Match the actual query form (template interpolation), not the prose in
    // the explanatory comments that document why the pattern was removed.
    for (const f of [
      "src/app/api/session/close/route.ts",
      "src/app/api/negotiate/close-deal/route.ts",
      "src/app/api/deals/route.ts",
      "src/app/api/activity/route.ts",
      "src/lib/will-answers.ts",
    ]) {
      expect(read(f)).not.toMatch(/thread_key=like\.\$\{/);
    }
  });

  it("wa_sessions reads use exact `email=eq.`, never `email=ilike.` (an `_` is a SQL wildcard)", () => {
    const evo = read("src/lib/evolution.ts");
    expect(evo).not.toMatch(/email=ilike\./);
  });
});

describe("privacy/data-minimization: syncFullHistory is never requested true", () => {
  it("evolution.ts declares syncFullHistory only as false, on every instance/create path", () => {
    const evo = read("src/lib/evolution.ts");
    expect(evo).not.toMatch(/syncFullHistory:\s*true/);
    // and it IS declared (so the create bodies actively opt out, not just omit)
    expect(count(evo, /syncFullHistory:\s*false/g)).toBeGreaterThanOrEqual(3);
  });
});

describe("pairing: a live handshake is never destroyed by a code refresh", () => {
  it("connect/route.ts does NOT pre-reset the instance (that killed the connecting-guard)", () => {
    // resetInstance() wrote status "disconnected", so connectInstance's
    // `existing === "connecting"` guard could never fire and EVERY refresh took
    // the logout+delete+recreate path - wiping the pairing the phone was
    // completing, and churning the Evolution container into a crash loop.
    const route = readCode("src/app/api/wa/connect/route.ts");
    expect(route).not.toMatch(/resetInstance\(/);
    // `fresh` is forwarded as permission for connectInstance to decide.
    expect(route).toMatch(/connectInstance\([\s\S]{0,200}fresh:/);
  });

  it("connectInstance re-issues on the SAME instance for a non-fresh connecting session", () => {
    const evo = readCode("src/lib/evolution.ts");
    // The guard is reachable (gated on !opts.fresh, not on a code-age window
    // that expired into the destructive path) - and since the 3.4 churn guard,
    // a "Try again" INSIDE the teardown cooldown also takes this
    // non-destructive branch instead of rebuilding twice in 90 seconds.
    expect(evo).toMatch(/existing === "connecting" && \(!opts\?\.fresh \|\| inTeardownCooldown\(email\)\)/);
    // ...and the destructive pair still exists only BELOW it, as the last
    // resort - stamped into the risk ledger each time it fires.
    expect(evo).toMatch(/instance\/logout\//);
    expect(evo).toMatch(/markTeardown\(email, opts\?\.fresh \? "user-try-again"/);
  });

  it("the client's automatic code refresh never asks for a hard reset", () => {
    const ui = readCode("src/components/WaConnect.tsx");
    // The lapsed-code timer re-issues with fresh=false. A literal connect(true)
    // on a timer is exactly the regression this pins against.
    expect(ui).toMatch(/connect\(false\)/);
    expect(ui).not.toMatch(/autoRefreshes/);
  });
});

describe("inbound: a live thread can never die of a missing RFQ anchor", () => {
  it("resolveThreadContext self-heals from the traveller's recent search", () => {
    const ctx = readCode("src/lib/wa/thread-context.ts");
    // Recovery is attempted ONLY for a thread we actually messaged and whose
    // gate passed - never as a way to invent an outreach that never happened.
    // Owner report 6 B added the third condition: the CURRENT search must have
    // touched this shop, or the heal would adopt a dead thread into a new hunt.
    expect(ctx).toMatch(/if \(!anchor && gate\.ok && rows\.some\(inSession\)\)/);
    expect(ctx).toMatch(/recoverRfqForSender/);
    // ...and the heal is persisted, so it is one repair per thread, not one
    // per inbound message.
    expect(ctx).toMatch(/rfqRecovered: true/);
  });

  it("the WA doctor asks the ENGINE for the anchor verdict, not the newest row", () => {
    const doc = readCode("src/app/api/admin/wa-doctor/route.ts");
    // The old `outbound[0]?.raw?.rfq != null` is the exact predicate the
    // resolver replaced; a doctor using it reports failures the agent does not
    // have (and misses ones it does).
    expect(doc).not.toMatch(/newestCtx\?\.rfq/);
    expect(doc).toMatch(/resolveThreadContext\(number, email\)/);
    // A drop trace from ANOTHER number must never be shown as this thread's.
    expect(doc).not.toMatch(/\?\? dropTrace\[0\]/);
  });

  it("number matching is tolerant on EVERY read path (engine, doctor, echo, gate)", () => {
    // `threadNumberOr` builds the or() value; `numberFilter` is the complete
    // query fragment built on top of it. Either proves the path is tolerant -
    // an exact `=eq.<digits>` is what made a real shop's reply invisible.
    for (const f of [
      "src/lib/wa/thread-context.ts",
      "src/app/api/admin/wa-doctor/route.ts",
      "src/lib/wa/ingest.ts",
      "src/lib/drill.ts",
      "src/lib/wa-guard.ts",
      "src/app/api/thread/route.ts",
      "src/app/api/wa/avatar/route.ts",
    ]) {
      expect(readCode(f)).toMatch(/threadNumberOr\(|numberFilter\(/);
    }
  });
});

describe("gating: the Find-Deals blur-lock actually renders when unpaired", () => {
  it("waits FOR hydration (`restored`), never `!restored`", () => {
    // `restored` is a hydration-DONE flag - setRestored(true) runs
    // unconditionally on mount. The lock condition was written `!restored`, so
    // it was false within a tick of mount and the veil never appeared: an
    // unpaired user got the full search form and a live "Find my deal" button
    // that could not possibly send. Pin the corrected polarity.
    const page = readCode("src/app/page.tsx");
    expect(page).not.toMatch(/!restored\s*&&\s*phase === "idle"/);
    // The condition now also requires a REACHABLE server (see the gate suite
    // below), so pin each conjunct rather than one brittle source string.
    const decl = page.slice(page.indexOf("const waLocked"), page.indexOf("const waLocked") + 260);
    expect(decl).toMatch(/waConnected !== true/);
    expect(decl).toMatch(/\brestored\b/);
    expect(decl).toMatch(/phase === "idle"/);
    expect(decl).toMatch(/vendors\.length === 0/);
  });

  it("the veil and the blur wrapper share ONE derived flag", () => {
    const page = readCode("src/app/page.tsx");
    expect(page).toMatch(/const waLocked =/);
    expect(page).toMatch(/\{waLocked && <WaLockVeil/);
    expect(page).toMatch(/waLocked \? "pointer-events-none/);
  });

  it("startSearch refuses a confirmed-unpaired search (Will bypasses the veil)", () => {
    const page = readCode("src/app/page.tsx");
    // Must gate on the CONFIRMED false, not on a pending null read.
    expect(page).toMatch(/if \(waConnected === false\) \{/);
  });
});

describe("anti-ban: pairing-layer client fingerprint (the ban happened AT pairing)", () => {
  it("presents a standard Chrome-on-macOS fingerprint, never the flagged default", () => {
    const evo = read("src/lib/evolution.ts");
    // The standard desktop WhatsApp-Web fingerprint is declared...
    expect(evo).toMatch(/\[\s*"Mac OS"\s*,\s*"Chrome"\s*,\s*"[\d.]+"\s*\]/);
    // ...and pinned to the WEB protocol (not the flagged mobile API).
    expect(evo).toMatch(/mobile:\s*false/);
    // ...and it is actually SPREAD into the primary create bodies (main create +
    // failover recreate). The last-resort flat-retry body DELIBERATELY omits it
    // so a strict validator that 400s on unknown fields can still pair via the
    // minimal legacy shape - hence >= 2, not every create path.
    const code = readCode("src/lib/evolution.ts");
    expect(count(code, /\.\.\.CONNECT_FINGERPRINT/g)).toBeGreaterThanOrEqual(2);
  });
});

describe("inbound recovery: webhook re-arm is non-destructive (never touches the session)", () => {
  it("reassertWebhook only calls /webhook/find + /webhook/set - never create/logout/delete", () => {
    const evo = readCode("src/lib/evolution.ts");
    const start = evo.indexOf("export async function reassertWebhook");
    expect(start).toBeGreaterThan(-1);
    // Bound the scan to the function body (up to the next top-level export).
    const body = evo.slice(start, evo.indexOf("\nexport ", start + 40));
    expect(body).toMatch(/\/webhook\/set\//);
    // The destructive session ops must NOT appear anywhere in the re-arm path.
    expect(body).not.toMatch(/instance\/create/);
    expect(body).not.toMatch(/instance\/logout/);
    expect(body).not.toMatch(/instance\/delete/);
  });

  it("connectInstance re-arms the webhook on the already-open early-return", () => {
    const evo = readCode("src/lib/evolution.ts");
    // The open-early-return block must reference reassertWebhook (a stale URL is
    // otherwise never refreshed for an already-linked user).
    expect(evo).toMatch(/existing === "open"[\s\S]{0,320}reassertWebhook/);
  });

  it("ensureConnected's failover recreate carries a webhook field (no webhook-less instance)", () => {
    const evo = readCode("src/lib/evolution.ts");
    expect(evo).toMatch(/recreateWebhook/);
    // and the derivation is present so the body can include it
    expect(evo).toMatch(/canonicalWebhookOrigin\(\)/);
  });
});

describe("observability: formerly-silent inbound drops now leave a throttled trace", () => {
  it("the vendor-gate, no-rfq, takeover and pause gates emit inbound-dropped", () => {
    // ingest.ts vendor-gate + empty-media
    expect(readCode("src/lib/wa/ingest.ts")).toMatch(/noteInboundDropped\([^)]*"vendor-gate"/);
    // agent-loop no-rfq-thread + takeover-hold + pause-hold
    const loop = readCode("src/lib/agent-loop.ts");
    expect(loop).toMatch(/noteInboundDropped\([^)]*"no-rfq-thread"/);
    expect(loop).toMatch(/noteInboundDropped\([^)]*"takeover-hold"/);
    expect(loop).toMatch(/noteInboundDropped\([^)]*"pause-hold"/);
    // wa-sync gate + error catch
    const sync = readCode("src/lib/wa-sync.ts");
    expect(sync).toMatch(/noteInboundDropped\([^)]*"vendor-gate"/);
    expect(sync).toMatch(/noteInboundDropped\([^)]*"sync-error"/);
  });

  it("the webhook verifiers trace accept + 403 without logging the full token", () => {
    const route = readCode("src/app/api/webhooks/evolution/route.ts");
    expect(route).toMatch(/noteWebhook403/);
    expect(route).toMatch(/noteWebhookAccepted/);
    const gateway = readCode("apps/gateway/src/server.ts");
    expect(gateway).toMatch(/noteWebhook403/);
    // The 403 path must NOT read the request body before authing.
    expect(route).not.toMatch(/req\.json\(\)[\s\S]{0,120}noteWebhook403/);
  });
});

describe("anti-ban: send-side STOP-LOSS wired into the one send chokepoint", () => {
  it("wa-guard exports noteSendOutcome and evolution.ts feeds it on every outcome", () => {
    expect(read("src/lib/wa-guard.ts")).toMatch(/export async function noteSendOutcome/);
    const evo = read("src/lib/evolution.ts");
    // A clean send resets the streak; a hard failure feeds the breaker. The
    // hard/soft split now goes through the pure isHardSendFailure classifier
    // (OR11 H2.1) so an Evolution 401/403 apikey rejection is soft, not a strike
    // on the number.
    expect(evo).toMatch(/noteSendOutcome\(email,\s*"ok"\)/);
    expect(evo).toMatch(
      /noteSendOutcome\(email,\s*isHardSendFailure\(res\.status,\s*errText\)\s*\?\s*"hard"\s*:\s*"soft"\)/
    );
  });
});

describe("defense-in-depth: RLS enabled on sensitive tables (deny-all for non-service-role)", () => {
  it("every sensitive table opts into row level security in schema.sql", () => {
    const sql = read("supabase/schema.sql");
    for (const tbl of [
      "offers",
      "searches",
      "bookings",
      "app_users",
      "whatsapp_messages",
      "wa_outbox",
      "wa_recipient_state",
      // The semantic corpus sidecar holds a capped copy of shop reply text
      // keyed by user_email. It lives inside schema.sql's pg_extension branch,
      // which does not exempt it from the deny-all posture.
      "corpus_embeddings",
    ]) {
      expect(sql).toMatch(new RegExp(`alter table public\\.${tbl}\\s+enable row level security`));
    }
  });
});

describe("resilience: external fetches are bounded by a hard timeout", () => {
  it("evoFetch aborts on a timeout (a cold Evolution host cannot hang the drain)", () => {
    const evo = read("src/lib/evolution.ts");
    const start = evo.indexOf("async function evoFetch");
    expect(start).toBeGreaterThan(-1);
    const body = evo.slice(start, evo.indexOf("async function", start + 10));
    expect(body).toMatch(/AbortController/);
    expect(body).toMatch(/ctrl\.abort\(\)/);
    expect(body).toMatch(/signal:\s*ctrl\.signal/);
  });

  it("every Supabase helper goes through timedFetch (only timedFetch's own call is a raw fetch)", () => {
    const code = readCode("src/lib/runtime-config.ts");
    expect(code).toMatch(/async function timedFetch/);
    // Exactly one raw lowercase `fetch(` survives in code: the one inside
    // timedFetch itself (all helpers call via `timedFetch(` - capital F).
    expect(count(code, /fetch\(/g)).toBe(1);
  });

  it("google.ts routes every Places call through its timedFetch wrapper", () => {
    const code = readCode("src/lib/google.ts");
    expect(code).toMatch(/async function timedFetch/);
    // Only the wrapper's own internal call is a raw lowercase fetch(.
    expect(count(code, /fetch\(/g)).toBe(1);
  });

  it("whatsapp.ts Cloud send is abort-bounded", () => {
    const code = readCode("src/lib/whatsapp.ts");
    expect(code).toMatch(/AbortController/);
    expect(code).toMatch(/signal:\s*ctrl\.signal/);
  });

  it("timedFetch keeps its deadline armed across the body read (no header-boundary clear)", () => {
    // The abort deadline must span headers+body: fetch() resolves at headers but
    // the read helpers then `await res.json()`. Clearing the timer at the header
    // boundary left the body read unbounded (a mid-body DB stall hung the handler
    // and, on the drain path, lost an already-claimed row).
    const code = readCode("src/lib/runtime-config.ts");
    expect(code).not.toMatch(/clearTimeout/);
    expect(code).toMatch(/\.unref\?\.\(\)/);
  });
});

// The v1 fallback body fired on ANY definitive send failure. On the pinned v2
// host that body is invalid, so a first failure of any kind was followed by a
// request that could only ever answer `instance requires property "text"` - and
// that schema complaint replaced the real reason and was shown to the traveller.
describe("WhatsApp send: the legacy retry cannot mask the real failure", () => {
  it("the v1 body is only tried on a SHAPE rejection", () => {
    const evo = readCode("src/lib/evolution.ts");
    expect(evo).toMatch(/looksLikeShapeRejection\(r\)/);
    // The old unconditional form is gone.
    expect(evo).not.toMatch(/if \(!r\.ok && r\.status !== 0\) \{\s*r = await evo/);
  });

  it("a failed legacy attempt reports the FIRST error, not its own", () => {
    expect(readCode("src/lib/evolution.ts")).toMatch(/legacy\.ok \? legacy : r/);
  });

  it("shape rejection is judged on status AND message, not status alone", () => {
    const evo = readCode("src/lib/evolution.ts");
    const fn = evo.slice(evo.indexOf("export function looksLikeShapeRejection"));
    expect(fn).toMatch(/status !== 400 && r\.status !== 422/);
    expect(fn).toMatch(/requires property/);
  });

  it("the card renders a translated message, never the upstream string", () => {
    const card = readCode("src/components/VendorCard.tsx");
    expect(card).toMatch(/friendlySendError\(/);
    // No bare `d.error` left as the thing a traveller reads.
    expect(card).not.toMatch(/setRfqError\(d\.error \?\? null\)/);
  });
});

describe("shop avatars: a miss is diagnosable, and both id shapes are tried", () => {
  it("checks res.ok instead of reading a URL off an error body", () => {
    const evo = readCode("src/lib/evolution.ts");
    const fn = evo.slice(
      evo.indexOf("export async function fetchProfilePicture("),
      evo.indexOf("export async function fetchProfilePicture(") + 3000
    );
    expect(fn).toMatch(/if \(!res\.ok\)/);
    expect(fn).toMatch(/console\.warn/);
  });

  it("tries every identifier AND every route a build might serve it from", () => {
    const evo = readCode("src/lib/evolution.ts");
    const fn = evo.slice(
      evo.indexOf("export async function fetchProfilePicture("),
      evo.indexOf("export async function fetchProfilePicture(") + 3000
    );
    expect(fn).toMatch(/resolveChatJid|s\.whatsapp\.net/);
    // One endpoint's opinion is not an answer: builds disagree about which
    // route serves a picture, so a miss must have been asked for four ways.
    expect(fn).toMatch(/fetchProfile\//);
    expect(fn).toMatch(/findContacts\//);
  });

  it("still writes nothing to any database", () => {
    const evo = readCode("src/lib/evolution.ts");
    const fn = evo.slice(
      evo.indexOf("export async function fetchProfilePicture("),
      evo.indexOf("export async function fetchProfilePicture(") + 3000
    );
    expect(fn).not.toMatch(/\bsb(Insert|Update|Upsert|Delete)\s*\(/);
  });
});

// The blur-lock accuses the traveller of not having linked WhatsApp. It showed
// over a CONNECTED account because a single un-retried status fetch failed and
// the catch handler wrote that failure down as `false`. These pin the shape of
// the fix, which no unit can express: there must be no un-probed status read
// left, and no path from "the read failed" to "you are not linked".
describe("WhatsApp gate: a failed status read never reads as 'not linked'", () => {
  it("every UI surface asks through the shared probe, not a raw fetch", () => {
    for (const f of [
      "src/app/page.tsx",
      "src/app/profile/page.tsx",
      "src/components/WaConnect.tsx",
    ]) {
      const code = readCode(f);
      expect(code).toMatch(/probeWaStatus\(/);
    }
    // The one-shot reads that caused this are gone from the gate itself.
    expect(readCode("src/app/page.tsx")).not.toMatch(/fetch\(\s*["'`]\/api\/wa\/status/);
    expect(readCode("src/app/profile/page.tsx")).not.toMatch(/fetch\(\s*["'`]\/api\/wa\/status/);
  });

  it("the probe distinguishes unreachable from unlinked", () => {
    const probe = readCode("src/lib/wa-status.ts");
    expect(probe).toMatch(/reachable:\s*false/);
    expect(probe).toMatch(/cache:\s*["']no-store["']/);
    expect(probe).toMatch(/AbortController/);
  });

  it("the lock requires a reachable server, not merely a non-true flag", () => {
    const page = readCode("src/app/page.tsx");
    const decl = page.slice(page.indexOf("const waLocked"), page.indexOf("const waLocked") + 260);
    expect(decl).toMatch(/waReachable/);
  });

  it("the gate re-asks when the traveller comes back from linking", () => {
    const page = readCode("src/app/page.tsx");
    expect(page).toMatch(/visibilitychange/);
    expect(page).toMatch(/refreshWaStatus/);
  });

  it("the status endpoint is never cacheable and cannot be held by a cold host", () => {
    const route = readCode("src/app/api/wa/status/route.ts");
    expect(route).toMatch(/private,\s*no-store/);
    // The durable pairing read must not queue behind the Evolution probe.
    expect(route).toMatch(/Promise\.all\(/);
    expect(route).toMatch(/Promise\.race\(/);
    expect(route).toMatch(/SOCKET_PROBE_MS/);
  });
});

// A shop's price board is one traveller's negotiation intel. The media proxy
// hands out bytes, so its gates are pinned here for the same reason the SQL
// filters above are: they are integration-bound and cannot fail as a unit.
describe("shop media proxy: scoped to your own thread, never cached publicly", () => {
  const MEDIA = "src/app/api/wa/media/route.ts";

  it("requires a session and refuses another user's message", () => {
    const code = readCode(MEDIA);
    expect(code).toMatch(/getSession\(\)/);
    expect(code).toMatch(/status:\s*401/);
    // The privacy keystone: inbound rows are scoped by receiver, never by
    // message id alone - the same id in someone else's thread must 404.
    expect(code).toMatch(/raw->>receiver=eq\./);
    expect(code).toMatch(/direction=eq\.inbound/);
  });

  it("validates the id with a strict regex BEFORE any upstream call", () => {
    const code = readCode(MEDIA);
    const idCheck = code.indexOf("ID_RX.test");
    const firstFetch = code.indexOf("fetchMediaBase64");
    expect(idCheck).toBeGreaterThan(-1);
    expect(idCheck).toBeLessThan(firstFetch);
    expect(code).toMatch(/status:\s*400/);
  });

  it("is private with a browser-only cache - never the public max-age of /api/photo", () => {
    const code = readCode(MEDIA);
    // `private, max-age=3600` (owner report 6 A4): the bytes behind one
    // message id are immutable, and `no-store` forced the full multi-second
    // redemption on every reopen of the panel - the 10s photo pop. The
    // invariant that matters survives unchanged: never `public`, never a
    // shared cache; one traveller's price board stays theirs.
    expect(code).toMatch(/private,\s*max-age=3600/);
    expect(code).not.toMatch(/public,\s*max-age/);
    expect(code).not.toMatch(/s-maxage/);
  });

  it("falls back to the Storage audit copy when WhatsApp has expired the media", () => {
    const code = readCode(MEDIA);
    expect(code).toMatch(/storage\/v1\/object\/wa-media\//);
    // Deterministic path: the worker must key the audit copy on the message id
    // alone, or this fallback can never find it.
    const worker = readCode("services/workers/src/vision.worker.ts");
    expect(worker).toMatch(/wa-media\/\$\{waMessageId/);
  });

  it("bounds the upstream wait, like every other outbound proxy here", () => {
    expect(readCode(MEDIA)).toMatch(/AbortController/);
  });
});

// Not avatars, but the same class of invariant and the same reason it is pinned
// at the source: page.tsx documents a REAL production leak where a stale device
// GPS fix was posted from the browser and relayed verbatim to a rental shop.
describe("location sharing: the browser never posts coordinates", () => {
  it("the consent request body carries no lat/lng - only a place NAME", () => {
    const page = readCode("src/app/page.tsx");
    const call = page.slice(page.indexOf("/api/negotiate/consent"));
    const body = call.slice(call.indexOf("JSON.stringify("), call.indexOf("});"));
    expect(body).not.toMatch(/\blat\b|\blng\b|latitude|longitude|coords/i);
    expect(body).toMatch(/shareQuery/);
  });

  it("the share sheet never reads geolocation itself", () => {
    const sheet = readCode("src/components/LocationShareSheet.tsx");
    expect(sheet).not.toMatch(/getCurrentPosition|watchPosition/);
  });

  it("the consent route still ignores any lat/lng a tampered client sends", () => {
    const route = readCode("src/app/api/negotiate/consent/route.ts");
    expect(route).not.toMatch(/body\.(lat|lng|latitude|longitude)/);
  });

  it("a one-off share is re-resolved server-side, never trusted as typed", () => {
    const route = readCode("src/app/api/negotiate/consent/route.ts");
    // The label handed to the engine comes from Google, not from the request.
    expect(route).toMatch(/searchPlaces|placeDetails/);
    expect(route).toMatch(/stayLabelOverride/);
  });
});

describe("scale: the webhook tail drains SCOPED and BOUNDED, never fleet-wide", () => {
  const ingest = readCode("src/lib/wa/ingest.ts");

  it("drainOutbox in the tail carries a per-sender scope, not an unscoped call", () => {
    // The old defect: `drainOutbox((..)=>..)` with no opts, running every user's
    // sends inside one webhook. The tail now scopes to a touched sender.
    expect(ingest).toMatch(/drainOutbox\([\s\S]{0,200}?replyOnly:\s*true[\s\S]{0,80}?senderKey:\s*sender/);
    // No unscoped fleet-wide drain remains in the tail.
    expect(ingest).not.toMatch(/await drainOutbox\(\(senderKey, to, text, lane\) =>\s*\n\s*sendFromUser\([^)]*\)\s*\n\s*\);/);
  });

  it("both tail drains run under a time-bounded race", () => {
    expect(ingest).toMatch(/DRAIN_BUDGET_MS\s*=\s*3_000/);
    expect(ingest).toMatch(/boundedDrain\(\s*drainOutbox/);
    expect(ingest).toMatch(/boundedDrain\(\s*drainGraphWakeups/);
  });

  it("graph wakeups in the tail are scoped to the touched sender", () => {
    expect(ingest).toMatch(/drainGraphWakeups\([\s\S]{0,200}?userEmail:\s*sender/);
  });
});
