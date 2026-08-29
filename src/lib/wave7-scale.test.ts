import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// WAVE 7 - THE SCALE GUIDE AND THE HEALTH PANELS THAT MAKE IT CHECKABLE.
//
// Two jobs, one file, because they are the same job: SCALING.md tells the owner
// which ceiling bites first, and the Keys page has to be able to SHOW them the
// distance to it. A guide whose numbers drift from the code is worse than no
// guide (it gets trusted), so every claim this document makes ABOUT THE CODE is
// asserted here against the code.
//
// Probe LOGIC is executed. Panel WIRING is source-pinned - a Next client
// component and a route handler are not reachable from vitest, and a pin that
// holds the wiring in place is worth more than a mock that proves nothing.

vi.mock("server-only", () => ({}));

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// ---------------------------------------------------------------------------
// 1. THE CHOKE POINTS - executed, because every threshold here is a decision
//    someone will be tempted to soften.
// ---------------------------------------------------------------------------

describe("choke point: WhatsApp host occupancy", () => {
  it("is green well under the cap", async () => {
    const { hostOccupancy } = await import("./chokepoints");
    const o = hostOccupancy([{ url: "https://a", users: 10 }, { url: "https://b", users: 12 }], 40);
    expect(o.state).toBe("ok");
    expect(o.users).toBe(22);
    expect(o.capacity).toBe(80);
    expect(o.pct).toBe(28);
    expect(o.hot).toEqual([]);
  });

  it("THE FLEET AVERAGE IS NOT THE MEASURE - one host at 80% is an alarm even when the pool is half empty", async () => {
    const { hostOccupancy } = await import("./chokepoints");
    const o = hostOccupancy(
      [
        { url: "https://hot", users: 32 }, // 80% of 40
        { url: "https://cold", users: 0 },
        { url: "https://cold2", users: 0 },
      ],
      40
    );
    // The pool average is 27% - comfortable, and completely beside the point:
    // users stick to the host they paired on, and it is the HOST that bans.
    expect(o.pct).toBe(27);
    expect(o.state).toBe("alarm");
    expect(o.hot).toEqual([{ url: "https://hot", users: 32, pct: 80 }]);
    expect(o.detail).toMatch(/banned number, not a queue/);
  });

  it("just under the alarm share stays green (the threshold is 80%, not 'nearly')", async () => {
    const { hostOccupancy, HOST_OCCUPANCY_ALARM } = await import("./chokepoints");
    expect(HOST_OCCUPANCY_ALARM).toBe(0.8);
    expect(hostOccupancy([{ url: "https://a", users: 31 }], 40).state).toBe("ok");
    expect(hostOccupancy([{ url: "https://a", users: 32 }], 40).state).toBe("alarm");
  });

  it("a host AT the cap says a new traveller has nowhere safe to link", async () => {
    const { hostOccupancy } = await import("./chokepoints");
    const o = hostOccupancy([{ url: "https://a", users: 40 }], 40);
    expect(o.state).toBe("alarm");
    expect(o.detail).toMatch(/AT the 40-user cap/);
  });

  it("no pool at all is UNKNOWN, not a healthy zero", async () => {
    const { hostOccupancy } = await import("./chokepoints");
    const o = hostOccupancy([], 40);
    expect(o.state).toBe("unknown");
    expect(o.pct).toBeNull();
    expect(o.detail).toMatch(/no traveller can link WhatsApp/i);
  });
});

describe("choke point: the drain heartbeat", () => {
  const now = Date.parse("2026-08-15T12:00:00Z");

  it("distinguishes NEVER from STOPPED - they have different fixes", async () => {
    const { drainAlarm } = await import("./chokepoints");
    const never = drainAlarm(null, now);
    expect(never.state).toBe("alarm");
    expect(never.ageMs).toBeNull();
    expect(never.detail).toMatch(/EVER/);

    const stopped = drainAlarm(new Date(now - 30 * 60_000).toISOString(), now);
    expect(stopped.state).toBe("alarm");
    expect(stopped.detail).toMatch(/exists and has stopped/);
  });

  it("warns before it alarms, so a slowing cadence is visible before it is dead", async () => {
    const { drainAlarm, DRAIN_ALARM_MS } = await import("./chokepoints");
    expect(DRAIN_ALARM_MS).toBe(600_000);
    expect(drainAlarm(new Date(now - 60_000).toISOString(), now).state).toBe("ok");
    expect(drainAlarm(new Date(now - 7 * 60_000).toISOString(), now).state).toBe("warn");
    expect(drainAlarm(new Date(now - 11 * 60_000).toISOString(), now).state).toBe("alarm");
  });

  it("an unparseable timestamp is NEVER, not now", async () => {
    const { drainAlarm } = await import("./chokepoints");
    expect(drainAlarm("not a date", now).state).toBe("alarm");
  });
});

describe("choke point: database round trip", () => {
  it("classifies against the pool-queueing thresholds", async () => {
    const { dbLatency } = await import("./chokepoints");
    expect(dbLatency(120).state).toBe("ok");
    expect(dbLatency(500).state).toBe("warn");
    expect(dbLatency(2_000).state).toBe("alarm");
    expect(dbLatency(2_000).detail).toMatch(/connection pool is queueing/);
  });

  it("no answer is UNKNOWN, not fast", async () => {
    const { dbLatency } = await import("./chokepoints");
    const r = dbLatency(null);
    expect(r.state).toBe("unknown");
    expect(r.ms).toBeNull();
  });
});

describe("choke point: the events that should page someone", () => {
  const now = Date.parse("2026-08-15T12:00:00Z");

  it("silence across EVERY watched kind is the only green", async () => {
    // Built from WATCHED_KINDS rather than a hand-written list of three. The
    // hand-written version broke the moment a fourth kind was added - not
    // because the behaviour changed, but because an unlisted kind correctly
    // reads as UNREADABLE rather than as silence. Deriving the fixture keeps
    // the invariant ("all quiet is the only green") and drops the staleness.
    const { pagerDigest, WATCHED_KINDS } = await import("./chokepoints");
    const d = pagerDigest(
      WATCHED_KINDS.map((kind) => ({ kind, count: 0, newestAt: null })),
      now
    );
    expect(d.state).toBe("ok");
    expect(d.headline).toMatch(/No dropped sends/);
  });

  it("a kind the panel could not read is UNKNOWN, not silence", async () => {
    // The reason the fixture above has to be complete: an absent sensor is not
    // good news, and the digest says so.
    const { pagerDigest, WATCHED_KINDS } = await import("./chokepoints");
    const d = pagerDigest(
      WATCHED_KINDS.slice(1).map((kind) => ({ kind, count: 0, newestAt: null })),
      now
    );
    expect(d.state).not.toBe("ok");
    expect(d.events.find((e) => e.kind === WATCHED_KINDS[0])?.count24h).toBeNull();
  });

  it("a paging kind firing is an ALARM and a digest kind firing is only a WARN", async () => {
    const { pagerDigest } = await import("./chokepoints");
    const { WATCHED_KINDS } = await import("./chokepoints");
    const quiet = () => WATCHED_KINDS.map((kind) => ({ kind, count: 0, newestAt: null as string | null }));
    const withFiring = (target: string, count: number, ageMs: number) =>
      quiet().map((r) =>
        r.kind === target ? { ...r, count, newestAt: new Date(now - ageMs).toISOString() } : r
      );

    const paging = pagerDigest(withFiring("wa-send-dropped", 3, 120_000), now);
    expect(paging.state).toBe("alarm");
    expect(paging.events.find((e) => e.kind === "wa-send-dropped")?.newestAgeMs).toBe(120_000);

    const digest = pagerDigest(withFiring("media-fetch-failed", 9, 60_000), now);
    expect(digest.state).toBe("warn");

    // The new digest kind behaves the same way: visible, but not a page.
    const degraded = pagerDigest(withFiring("wa-rep-bump-degraded", 2, 60_000), now);
    expect(degraded.state).toBe("warn");
  });

  it("AN UNREADABLE COUNTER IS UNKNOWN, NEVER ZERO - an absent sensor is not good news", async () => {
    const { pagerDigest } = await import("./chokepoints");
    const d = pagerDigest(
      [
        { kind: "wa-send-dropped", count: null, newestAt: null },
        { kind: "wa-ban-risk", count: 0, newestAt: null },
        { kind: "media-fetch-failed", count: 0, newestAt: null },
      ],
      now
    );
    expect(d.state).toBe("unknown");
    expect(d.events.find((e) => e.kind === "wa-send-dropped")?.count24h).toBeNull();
    expect(d.headline).toMatch(/unknown, not zero/);
  });

  it("a kind that was never asked about reads unknown rather than silently absent", async () => {
    const { pagerDigest, WATCHED_KINDS } = await import("./chokepoints");
    const d = pagerDigest([], now);
    expect(d.events).toHaveLength(WATCHED_KINDS.length);
    expect(d.events.every((e) => e.count24h === null)).toBe(true);
  });
});

describe("worstState - the panel headline cannot be greener than its worst reading", () => {
  it("ranks alarm over unknown over warn over ok", async () => {
    const { worstState } = await import("./chokepoints");
    expect(worstState(["ok", "warn", "alarm", "unknown"])).toBe("alarm");
    expect(worstState(["ok", "warn", "unknown"])).toBe("unknown");
    expect(worstState(["ok", "warn"])).toBe("warn");
    expect(worstState(["ok", "ok"])).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// 2. REDIS - the dependency that appeared on no screen at all.
// ---------------------------------------------------------------------------

describe("redisDiagnostics", () => {
  const original = process.env.REDIS_URL;
  beforeEach(() => {
    vi.resetModules(); // the client is memoized per module instance
  });
  afterEach(() => {
    if (original === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = original;
  });

  it("UNSET is 'off' and names the exact cost - a cap multiplied by the instance count", async () => {
    delete process.env.REDIS_URL;
    const { redisDiagnostics } = await import("./rival-cache");
    const d = await redisDiagnostics();
    expect(d.configured).toBe(false);
    expect(d.ok).toBe(false);
    expect(d.latencyMs).toBeNull();
    // The whole point of surfacing this key: the consequence is invisible
    // otherwise, and it is not "slower", it is "the cap does not exist".
    expect(d.detail).toMatch(/20x/);
    expect(d.detail).toMatch(/per-process counter/);
  });

  it("a real PONG is ok, with a round-trip number", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    vi.doMock("ioredis", () => ({
      default: class {
        on() {}
        async ping() {
          return "PONG";
        }
      },
    }));
    const { redisDiagnostics } = await import("./rival-cache");
    const d = await redisDiagnostics();
    expect(d.configured).toBe(true);
    expect(d.ok).toBe(true);
    expect(typeof d.latencyMs).toBe("number");
    expect(d.detail).toMatch(/PONG in \d+ms/);
    vi.doUnmock("ioredis");
  });

  it("CONFIGURED AND SILENT IS THE DANGEROUS STATE, and it reports as such", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    vi.doMock("ioredis", () => ({
      default: class {
        on() {}
        async ping(): Promise<string> {
          throw new Error("ETIMEDOUT");
        }
      },
    }));
    const { redisDiagnostics } = await import("./rival-cache");
    const d = await redisDiagnostics();
    expect(d.configured).toBe(true);
    expect(d.ok).toBe(false);
    expect(d.detail).toMatch(/silently back to per-process counting/);
    vi.doUnmock("ioredis");
  });
});

// ---------------------------------------------------------------------------
// 3. EMAIL - a configuration check dressed as a liveness check, undressed.
// ---------------------------------------------------------------------------

describe("summariseEmailProbes", () => {
  it("nothing configured is 'off' and is honest that it was only a config check", async () => {
    const { summariseEmailProbes } = await import("./email");
    const s = summariseEmailProbes([
      { provider: "gmail", configured: false, live: false, detail: "Not configured." },
      { provider: "brevo", configured: false, live: false, detail: "Not configured." },
      { provider: "resend", configured: false, live: false, detail: "Not configured." },
    ]);
    expect(s.status).toBe("off");
    expect(s.kind).toBe("config");
  });

  it("A REVOKED CREDENTIAL IS 'down', NOT 'healthy' - the defect this replaced", async () => {
    const { summariseEmailProbes } = await import("./email");
    const s = summariseEmailProbes([
      { provider: "gmail", configured: true, live: false, detail: "SMTP rejected the App Password: 535" },
      { provider: "brevo", configured: false, live: false, detail: "Not configured." },
      { provider: "resend", configured: false, live: false, detail: "Not configured." },
    ]);
    // The old probe asked emailVerificationAvailable(), which only checks that
    // a STRING exists - so exactly this state printed HEALTHY on the path that
    // delivers signup codes.
    expect(s.status).toBe("down");
    expect(s.kind).toBe("live");
    expect(s.detail).toMatch(/LIVE CHECK FAILED/);
  });

  it("one live and one dead is degraded, and names which is which", async () => {
    const { summariseEmailProbes } = await import("./email");
    const s = summariseEmailProbes([
      { provider: "gmail", configured: true, live: true, detail: "SMTP AUTH accepted" },
      { provider: "brevo", configured: true, live: false, detail: "Brevo responded 401." },
      { provider: "resend", configured: false, live: false, detail: "Not configured." },
    ]);
    expect(s.status).toBe("degraded");
    expect(s.detail).toMatch(/gmail/);
    expect(s.detail).toMatch(/Failing: brevo/);
  });

  it("all live is ok", async () => {
    const { summariseEmailProbes } = await import("./email");
    expect(
      summariseEmailProbes([
        { provider: "gmail", configured: true, live: true, detail: "ok" },
        { provider: "brevo", configured: false, live: false, detail: "Not configured." },
        { provider: "resend", configured: false, live: false, detail: "Not configured." },
      ]).status
    ).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// 4. THE SECOND GROQ SKU - one key, two billed products, one test until now.
// ---------------------------------------------------------------------------

describe("the Groq voice-note model id is overridable, like every text model", () => {
  const config: Record<string, string | undefined> = {};
  beforeEach(() => {
    vi.resetModules();
    for (const k of Object.keys(config)) delete config[k];
    // Paths resolve relative to THIS file, not to transcribe.ts - they land on
    // the same module ids either way, and getting it wrong silently mocks
    // nothing (which is exactly how the first run of this test lied).
    vi.doMock("./runtime-config", () => ({ getConfig: async (k: string) => config[k] }));
    vi.doMock("./ai", () => ({ chatVision: async () => null }));
    vi.doMock("./usage", () => ({
      recordApi: async () => {},
      whisperOverSoftCap: async () => false,
    }));
  });
  afterEach(() => {
    vi.doUnmock("./runtime-config");
    vi.doUnmock("./ai");
    vi.doUnmock("./usage");
  });

  it("falls back to the accent-strongest default when unset", async () => {
    const { whisperModel, DEFAULT_WHISPER_MODEL } = await import("./graph/transcribe");
    expect(DEFAULT_WHISPER_MODEL).toBe("whisper-large-v3"); // NOT -turbo
    expect(await whisperModel()).toBe("whisper-large-v3");
  });

  it("a vault override wins, so a retired audio id is fixable without a redeploy", async () => {
    config.GROQ_WHISPER_MODEL = "  whisper-large-v4  ";
    const { whisperModel } = await import("./graph/transcribe");
    expect(await whisperModel()).toBe("whisper-large-v4");
  });

  it("a blank override is not an empty model id", async () => {
    config.GROQ_WHISPER_MODEL = "   ";
    const { whisperModel } = await import("./graph/transcribe");
    expect(await whisperModel()).toBe("whisper-large-v3");
  });

  it("the transcriber sends the resolved id, not a literal", () => {
    const code = readCode("src/lib/graph/transcribe.ts");
    expect(code).toMatch(/fd\.append\("model", await whisperModel\(\)\)/);
    // The literal used to be inline; if it comes back the override is dead.
    expect(code).not.toMatch(/fd\.append\("model", "whisper/);
  });
});

// ---------------------------------------------------------------------------
// 5. THE VAULT ENTRIES.
// ---------------------------------------------------------------------------

describe("the Key Vault lists what it depends on", () => {
  const code = readCode("src/lib/config.ts");

  it("REDIS_URL is listed, and deliberately NOT pasteable", () => {
    expect(code).toMatch(/name: "REDIS_URL"[\s\S]*?editable: false/);
    // A pasteable field would report "configured" and change nothing, because
    // the client reads process.env at first use.
    expect(read("src/lib/config.ts")).toMatch(/env-only ON PURPOSE/);
  });

  it("REDIS_URL is testable even though it is not editable", () => {
    expect(code).toMatch(/TESTABLE_READ_ONLY = new Set\(\[[\s\S]*?"REDIS_URL"/);
    expect(code).toMatch(/testable: k\.editable \|\| TESTABLE_READ_ONLY\.has\(k\.name\)/);
  });

  it("the Groq voice SKU has its own row", () => {
    expect(code).toMatch(/name: "GROQ_WHISPER_MODEL"/);
    // `read`, not `readCode`: the comment stripper eats everything after the
    // `//` in a URL, so a doc-link assertion has to see the raw file.
    expect(read("src/lib/config.ts")).toMatch(/GROQ_WHISPER_MODEL: "https:\/\/console\.groq\.com/);
  });

  it("the model-id rows stay unmasked - a masked model id cannot be corrected", () => {
    expect(code).toMatch(/name: "GROQ_WHISPER_MODEL"[^\n]*secret: false/);
  });
});

// ---------------------------------------------------------------------------
// 6. THE PROBES - source pins for the route handlers.
// ---------------------------------------------------------------------------

describe("key-test: the keys that had no test now have one", () => {
  const code = readCode("src/app/api/admin/key-test/route.ts");

  it("REDIS_URL fires a real PING", () => {
    expect(code).toMatch(/case "REDIS_URL"/);
    expect(code).toMatch(/redisDiagnostics/);
  });

  it("the Groq voice SKU is tested against the AUDIO endpoint, not chat", () => {
    expect(code).toMatch(/case "GROQ_WHISPER_MODEL"/);
    // Raw file: the comment stripper would eat the URL from its `//` onward.
    expect(read("src/app/api/admin/key-test/route.ts")).toMatch(
      /api\.groq\.com\/openai\/v1\/audio\/transcriptions/
    );
    // A real (silent) clip, so this exercises the SKU rather than the key shape.
    expect(code).toMatch(/silentWav\(\)/);
  });

  it("all three vision model ids are tested against the model the ladder would pick", () => {
    for (const k of ["GEMINI_VISION_MODEL", "GROQ_VISION_MODEL", "ANTHROPIC_VISION_MODEL"]) {
      expect(code).toContain(`case "${k}"`);
    }
    expect(code).toMatch(/visionProviderTestTarget/);
    // Each provider's own image grammar - a missing branch is how these fell
    // through to "No test available for this key" in the first place.
    expect(code).toMatch(/inline_data/); // gemini
    expect(code).toMatch(/image_url/); // groq
    expect(code).toMatch(/media_type: "image\/png"/); // anthropic
  });

  it("a blank model override still runs the test - the default is the case most worth checking", () => {
    expect(code).toMatch(/testsWithoutOwnValue/);
    // Broadened to EVERY model override (chat models included) in Wave 7 -
    // vision/whisper ride the same suffix.
    expect(code).toMatch(/name\.endsWith\("_MODEL"\)/);
  });

  it("the WABA block is tested as a set: shape, reachability, and DRIFT", () => {
    expect(code).toMatch(/case "WABA_BASE_URL"/);
    expect(code).toMatch(/case "WABA_TIER_UNIQUE_PER_DAY"/);
    expect(code).toMatch(/shapeProblems/);
    expect(code).toMatch(/messaging_limit_tier/);
    expect(code).toMatch(/quality_rating/);
    // The tier and the rating are owner-typed strings that nothing reconciled.
    expect(code).toMatch(/DRIFT:/);
  });

  it("the Maps test reports the keyless fallback as its own line", () => {
    expect(code).toMatch(/OpenStreetMap fallback/);
  });
});

describe("health: the roll call finally includes what it depends on", () => {
  const code = readCode("src/app/api/admin/health/route.ts");

  it("Redis is a service row, with 'not set' distinguished from 'not answering'", () => {
    expect(code).toMatch(/id: "redis"/);
    expect(code).toMatch(/redisDiagnostics/);
    expect(code).toMatch(/!d\.configured \? "off" : d\.ok \? "ok" : "down"/);
  });

  it("the email row is a LIVE credential check and its label says so", () => {
    expect(code).toMatch(/emailLiveProbe/);
    expect(code).toMatch(/summariseEmailProbes/);
    expect(code).toMatch(/live credential check/);
    expect(code).toMatch(/configuration check only/);
    // The shape check it replaced must be gone from this route.
    expect(code).not.toMatch(/emailVerificationAvailable/);
  });

  it("the keyless geocoder is probed - it is a production path, not a footnote", () => {
    expect(code).toMatch(/id: "geocode-fallback"/);
    expect(code).toMatch(/probeNominatim/);
  });
});

describe("google: Nominatim is probed with AND without a Google key", () => {
  const code = readCode("src/lib/google.ts");

  it("the no-key branch still probes it - with no key it IS the geocoder", () => {
    expect(code).toMatch(/keyConfigured: false,[\s\S]*?nominatim: await probeNominatim\(\)/);
  });

  it("the keyed branch probes it too", () => {
    expect(code).toMatch(/nominatim: osm/);
  });

  it("a datacenter-IP block is named rather than reported as 'no matches'", () => {
    expect(read("src/lib/google.ts")).toMatch(/blocking or throttling this server's IP/);
  });
});

describe("chokepoints route", () => {
  const code = readCode("src/app/api/admin/chokepoints/route.ts");

  it("is management-gated like every other admin route", () => {
    expect(code).toMatch(/requireManagement/);
    expect(code).toMatch(/status: 403/);
  });

  it("measures the database with the same client every request uses", () => {
    expect(code).toMatch(/sbSelectDark/);
    expect(code).toMatch(/dbLatency\(probe === null \? null : Date\.now\(\) - t0\)/);
  });

  it("uses the dark counter, so an unreadable counter cannot read as zero", () => {
    expect(code).toMatch(/sbCountDark/);
  });

  it("the digest is a PULL through the existing email lib - no new dependency", () => {
    expect(code).toMatch(/action !== "digest"/);
    expect(code).toMatch(/sendEmail/);
    // A no-op send must not report success.
    expect(code).toMatch(/ok: out\.sent/);
    expect(code).toMatch(/unconfigured/);
  });
});

// ---------------------------------------------------------------------------
// 7. THE PANEL - conventions, and that it is actually mounted.
// ---------------------------------------------------------------------------

describe("the choke-point card follows the admin card conventions", () => {
  const raw = read("src/components/admin/ChokePointsCard.tsx");
  const code = readCode("src/components/admin/ChokePointsCard.tsx");

  it("is a client component and says why it exists", () => {
    expect(raw.startsWith('"use client";')).toBe(true);
    expect(raw).toMatch(/WHICH CEILING ARE WE CLOSEST TO/);
  });

  it("loads through useEffect + fetch and shows LoadingDots", () => {
    expect(code).toMatch(/useEffect/);
    expect(code).toMatch(/fetch\("\/api\/admin\/chokepoints"\)/);
    expect(code).toMatch(/LoadingDots/);
  });

  it("null means NOT LOADED, and an unreachable probe is an explicit red sentence", () => {
    expect(code).toMatch(/useState<Snapshot \| null>\(null\)/);
    expect(raw).toMatch(/that is unknown, not healthy/);
  });

  it("uses the shared surface/rounded-blob/chip/btn vocabulary", () => {
    expect(code).toMatch(/surface rounded-blob/);
    expect(code).toMatch(/btn btn-sm chip/);
  });

  it("shows the individual hot hosts, not only the fleet number", () => {
    expect(code).toMatch(/hotHosts/);
  });

  it("shows count AND age for the watched events", () => {
    expect(code).toMatch(/newestAgeMs/);
    expect(code).toMatch(/Email me this digest/);
  });
});

describe("the admin Keys tab mounts it, above the roll call", () => {
  const page = readCode("src/app/admin/page.tsx");

  it("imports and renders the card", () => {
    expect(page).toMatch(/import\("@\/components\/admin\/ChokePointsCard"\)/);
    expect(page).toMatch(/<ChokePointsCard \/>/);
  });

  it("sits ABOVE the service health roll call - every service can answer while the pool is one user from the wall", () => {
    const choke = page.indexOf("<ChokePointsCard />");
    const health = page.indexOf("<HealthPanel />");
    expect(choke).toBeGreaterThan(0);
    expect(health).toBeGreaterThan(choke);
  });

  it("the Test API button follows `testable`, so an env-only key can still be probed", () => {
    expect(page).toMatch(/\(k\.testable \?\? k\.editable\) && \(/);
  });

  it("multi-line probe answers stay readable", () => {
    expect(page).toMatch(/whitespace-pre-wrap break-words rounded-lg/);
  });
});

// ---------------------------------------------------------------------------
// 8. SCALING.md - DOC PINS. Every claim the guide makes about this codebase.
//    Change the code without the doc and this goes red, which is the point.
// ---------------------------------------------------------------------------

describe("SCALING.md does not drift from the code it describes", () => {
  const doc = read("SCALING.md");

  it("quotes the Cloud Run shape that is actually deployed", () => {
    const workflow = read(".github/workflows/deploy-gcp.yml");
    for (const flag of ["--memory 1Gi", "--cpu 1", "--concurrency 32", "--min-instances 1", "--max-instances 20"]) {
      expect(workflow).toContain(flag);
      expect(doc).toContain(flag);
    }
  });

  it("quotes the real per-host cap default", () => {
    const evo = readCode("src/lib/evolution.ts");
    // The default lives in maxPerHost(). Lowered 40 -> 25 for the beta: 40 sat
    // at the top of a 512MB box's socket range with no margin, and the failure
    // mode is a banned personal number, not a slow queue.
    expect(evo).toMatch(/Number\.isFinite\(v\) && v > 0 \? v : 25/);
    expect(doc).toMatch(/25 paired users per host/);
    expect(doc).toMatch(/EVOLUTION_MAX_PER_HOST/);
    // ...and the doc must record that the cap REFUSES rather than overfilling.
    expect(doc).toMatch(/at capacity the app now REFUSES/i);
  });

  it("quotes the real inbound concurrency gate", () => {
    const gate = readCode("src/lib/wa/inbound-gate.ts");
    expect(gate).toMatch(/const MAX_INFLIGHT = 4;/);
    expect(doc).toMatch(/MAX_INFLIGHT = 4/);
    expect(doc).toMatch(/heavy turns at 4 concurrent/);
  });

  it("is right that REDIS_URL is OPTIONAL in the deploy - the whole reason the caveat exists", () => {
    const workflow = read(".github/workflows/deploy-gcp.yml");
    expect(workflow).toMatch(/for OPTIONAL in [^\n]*REDIS_URL/);
    expect(doc).toMatch(/optional\*? secret/i);
  });

  it("is right that the deploy does NOT pass --no-cpu-throttling, and says not to 'fix' it", () => {
    const workflow = read(".github/workflows/deploy-gcp.yml");
    expect(workflow).not.toMatch(/^\s*--no-cpu-throttling/m);
    expect(doc).toMatch(/does \*\*not\*\* pass\s*\n?`--no-cpu-throttling`/);
    expect(doc).toMatch(/Do not "fix" this/);
  });

  it("quotes the scheduler cadence the workflow actually creates", () => {
    const workflow = read(".github/workflows/deploy-gcp.yml");
    expect(workflow).toMatch(/--schedule "\* \* \* \* \*"/);
    expect(doc).toMatch(/schedule `\* \* \* \* \*`/);
  });

  it("quotes the Evolution host plan that render.yaml actually ships", () => {
    const render = read("render.yaml");
    expect(render).toMatch(/plan: starter/);
    expect(render).toMatch(/plan: basic-256mb/);
    expect(doc).toMatch(/`starter`/);
    expect(doc).toMatch(/basic-256mb/);
  });

  it("points at the retention script that exists and is not run for you", () => {
    expect(doc).toMatch(/supabase\/retention\.sql/);
    expect(doc).toMatch(/nothing runs it for you/);
  });

  it("names the exact three event kinds the ops doc says should page someone", () => {
    const prod = read("PRODUCTION-READINESS.md");
    for (const kind of ["wa-send-dropped", "wa-ban-risk", "media-fetch-failed"]) {
      expect(prod).toContain(kind);
      expect(doc).toContain(kind);
    }
  });

  it("the guide's watched kinds ARE the ones the panel counts", async () => {
    const { WATCHED_KINDS } = await import("./chokepoints");
    for (const kind of WATCHED_KINDS) expect(doc).toContain(kind);
  });

  it("states the 80% host alarm the panel actually uses", async () => {
    const { HOST_OCCUPANCY_ALARM } = await import("./chokepoints");
    expect(doc).toContain(`${Math.round(HOST_OCCUPANCY_ALARM * 100)}%`);
  });

  it("is honest about what it does not solve", () => {
    expect(doc).toMatch(/What this guide does NOT solve/);
    expect(doc).toMatch(/no error tracking/i);
    expect(doc).toMatch(/workers VM is not provisioned/i);
    expect(doc).toMatch(/Retention is owner-run SQL/i);
  });

  it("carries a cost envelope per user tier, not a single number", () => {
    expect(doc).toMatch(/Monthly total/);
    for (const tier of ["100 simultaneous", "300 simultaneous", "500 simultaneous"]) {
      expect(doc).toContain(tier);
    }
  });

  it("orders the work by consequence, with the WhatsApp wall first", () => {
    const order = doc.indexOf("## The order to do these in");
    const wall = doc.indexOf("Size the WhatsApp (Evolution) tier");
    const redis = doc.indexOf("Set `REDIS_URL`");
    expect(order).toBeGreaterThan(0);
    expect(wall).toBeGreaterThan(order);
    expect(redis).toBeGreaterThan(wall);
  });

  it("uses only plain hyphens, per the repo's copy rule", () => {
    expect(doc).not.toMatch(/[‐-―−]/);
  });
});
