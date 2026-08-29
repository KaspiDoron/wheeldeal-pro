import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

const config: Record<string, string | null> = {};
const selects: { table: string; query: string }[] = [];
let selectResult: unknown = { rows: [] };
/** The fleet suppression read (wa_suppressions). Defaults to none. */
let suppressionResult: unknown = { rows: [] };
/** The compliance gate's read (waba_agencies.opted_in_at). Defaults to opted
 *  in so the lane tests exercise the lanes; the gate has its own cases. */
let optedIn = true;

vi.mock("../runtime-config", () => ({
  getConfig: async (k: string) => config[k] ?? null,
  sbSelectStrict: async (table: string, query: string) => {
    selects.push({ table, query });
    if (table === "wa_suppressions") return suppressionResult;
    return selectResult;
  },
  sbSelect: async (table: string, query: string) => {
    if (table === "waba_agencies" && query.includes("opted_in_at")) {
      return optedIn ? [{ opted_in_at: "2026-08-01T00:00:00Z" }] : [];
    }
    return [];
  },
  sbInsert: async () => true,
  sbInsertReturning: async () => [],
  sbUpdate: async () => true,
}));

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

const leads = readCode("src/lib/waba/leads.ts");
const drill = readCode("src/lib/drill.ts");
const expectation = readCode("src/lib/waba/expectation.ts");

beforeEach(() => {
  for (const k of Object.keys(config)) delete config[k];
  selects.length = 0;
  selectResult = { rows: [] };
  suppressionResult = { rows: [] };
  optedIn = true;
});

const HOUR = 3600_000;

// THE ONE MECHANIC EVERYTHING TURNS ON.
//
// Outside a 24h service window we may only send a pre-approved TEMPLATE -
// priced, metered against the portfolio tier, and subject to the per-recipient
// cap that produces error 131049. INSIDE an open window we may send free-form
// text: unlimited, free, and outside the tier entirely.
//
// So a popular agency must cost at most one template per day, not one per
// traveller. Our ranking is a pure total order with no user-dependent term, so
// every traveller in a district sees the SAME top shops - without the cooldown
// the third traveller of the day is silently undelivered at exactly the agencies
// that matter most.

describe("the two lanes are chosen, never guessed", () => {
  it("an open window picks the FREE lane", async () => {
    const { windowOpen } = await import("./leads");
    const now = Date.now();
    expect(windowOpen({ agency_tail: "t", window_expires_at: new Date(now + HOUR).toISOString(), template_capped_until: null, last_template_at: null }, now)).toBe(true);
  });

  it("an expired window does not", async () => {
    const { windowOpen } = await import("./leads");
    const now = Date.now();
    expect(windowOpen({ agency_tail: "t", window_expires_at: new Date(now - 1).toISOString(), template_capped_until: null, last_template_at: null }, now)).toBe(false);
    expect(windowOpen(null, now)).toBe(false);
  });

  it("a never-contacted agency may be templated", async () => {
    const { templateAllowed } = await import("./leads");
    expect(templateAllowed(null, 24)).toBe(true);
  });

  it("our own cooldown blocks a second template inside 24h", async () => {
    // This is the guard that keeps us clear of the platform cap in the first
    // place, rather than discovering it through a 131049.
    const { templateAllowed } = await import("./leads");
    const now = Date.now();
    const s = {
      agency_tail: "t",
      window_expires_at: null,
      template_capped_until: null,
      last_template_at: new Date(now - 2 * HOUR).toISOString(),
    };
    expect(templateAllowed(s, 24, now)).toBe(false);
    expect(templateAllowed(s, 1, now)).toBe(true);
  });

  it("a platform cap is absolute - our cooldown cannot shorten it", async () => {
    const { templateAllowed } = await import("./leads");
    const now = Date.now();
    expect(
      templateAllowed(
        {
          agency_tail: "t",
          window_expires_at: null,
          template_capped_until: new Date(now + 6 * HOUR).toISOString(),
          last_template_at: null,
        },
        0.1,
        now
      )
    ).toBe(false);
  });
});

describe("admission is one decision in one place", () => {
  it("an open window yields freeform, and never a paid template", async () => {
    // Sending a template into an open window pays for something that is free.
    const { admitLead } = await import("./leads");
    const now = Date.now();
    selectResult = {
      rows: [{ agency_tail: "812345678", window_expires_at: new Date(now + HOUR).toISOString(), template_capped_until: null, last_template_at: null }],
    };
    expect(await admitLead("66812345678", now)).toEqual({ lane: "freeform", reason: "window-open" });
  });

  it("a cold agency yields a template", async () => {
    const { admitLead } = await import("./leads");
    expect(await admitLead("66812345678")).toEqual({ lane: "template", reason: "cold" });
  });

  it("a capped recipient HOLDS rather than failing", async () => {
    // Held is a first-class state the traveller can be told about. Part 5.5:
    // a shop dropped before the loop is counted nowhere and cannot be explained.
    const { admitLead } = await import("./leads");
    const now = Date.now();
    selectResult = {
      rows: [{ agency_tail: "812345678", window_expires_at: null, template_capped_until: new Date(now + HOUR).toISOString(), last_template_at: null }],
    };
    expect(await admitLead("66812345678", now)).toEqual({ hold: true, reason: "recipient-capped" });
  });

  it("an unreadable agency row REFUSES - fail closed", async () => {
    // Opposite direction from the warm-up gate, and for the opposite reason:
    // the asset at risk here is a rented WABA shared by every user at once, and
    // a wrong send costs quality rating we cannot buy back.
    const { admitLead } = await import("./leads");
    selectResult = { error: "unavailable" };
    expect(await admitLead("66812345678")).toEqual({ refuse: true, reason: "unreadable" });
  });

  it("an unusable number refuses rather than defaulting to a key", async () => {
    const { admitLead } = await import("./leads");
    expect(await admitLead("123")).toEqual({ refuse: true, reason: "no-tail" });
  });

  it("COMPLIANCE: a shop that never opted in is refused the COLD lane - and fails closed", async () => {
    // Meta's rule as structure: outside an open window the only lane left is a
    // cold template, and that needs opt-in. The dispatcher maps this refusal
    // to fallback-legacy, so the traveller's own number contacts the shop as
    // always - the shop is refused THIS LANE, not service.
    const { admitLead } = await import("./leads");
    optedIn = false;
    expect(await admitLead("66812345678")).toEqual({ refuse: true, reason: "not-opted-in" });
  });

  it("...but an OPEN WINDOW needs no opt-in: the shop messaged us first", async () => {
    // The inbound that opened the window IS the opt-in Meta's rules recognise.
    const { admitLead } = await import("./leads");
    optedIn = false;
    const now = Date.now();
    selectResult = {
      rows: [{ agency_tail: "812345678", window_expires_at: new Date(now + HOUR).toISOString(), template_capped_until: null, last_template_at: null }],
    };
    expect(await admitLead("66812345678", now)).toEqual({ lane: "freeform", reason: "window-open" });
  });

  it("FLEET SUPPRESSION outranks everything: a shop that said stop is refused every lane", async () => {
    const { admitLead } = await import("./leads");
    suppressionResult = { rows: [{ reason: "stop-intent" }] };
    const now = Date.now();
    selectResult = {
      rows: [{ agency_tail: "812345678", window_expires_at: new Date(now + HOUR).toISOString(), template_capped_until: null, last_template_at: null }],
    };
    // Even an open window does not readmit a suppressed shop.
    expect(await admitLead("66812345678", now)).toEqual({ refuse: true, reason: "suppressed" });
  });
});

describe("the ledger is keyed and guarded like the rest of the repo", () => {
  it("agencies are keyed on the phone tail", () => {
    // Re-splitting rows across phone spellings here would reproduce the exact
    // bug the recipient ledger was just fixed for.
    expect(leads).toMatch(/nationalTail\(/);
    expect(leads).toMatch(/agency_tail/);
  });

  it("a terminal lead cannot be moved by a late webhook", () => {
    // Enforced in the FILTER, not by read-then-write: duplicate webhooks arrive
    // concurrently often enough that a check-then-act would let a late
    // `expired` overwrite `handed_off` and un-hand-off a live negotiation.
    expect(leads).toMatch(/state=not\.in\.\(\$\{terminalList\}\)/);
  });

  it("the link token is unguessable and carries no phone number", () => {
    // Anyone who receives a forwarded template can tap the button.
    expect(leads).toMatch(/randomBytes\(18\)\.toString\("base64url"\)/);
  });

  it("telemetry can never break a send", () => {
    expect(leads).toMatch(/noteWabaEvent[\s\S]{0,600}catch\(\(\) => false\)/);
  });

  it("only DISPATCHED leads are flushed when a window opens", () => {
    expect(leads).toMatch(/state=in\.\(held,template_sent\)/);
  });
});

// TASKS #67 AND #85 BUILT THE INBOUND GATE TO REJECT EXACTLY THIS MESSAGE.
//
// The handoff needs the traveller's system to accept an inbound from a number
// they have never written to - which is the thing those tasks made impossible,
// correctly. The resolution is a pre-authorised, scoped, expiring exception,
// NOT a looser gate.

describe("the handoff exception is narrow, and provably so", () => {
  it("it runs only AFTER the original gate has already said no", () => {
    const idx = drill.indexOf("const verdict = classifyIngest");
    const exc = drill.indexOf("wabaExpectsInbound");
    expect(idx).toBeGreaterThan(-1);
    expect(exc).toBeGreaterThan(idx);
    // A non-false verdict returns before the exception is ever consulted, so it
    // cannot weaken a "yes" or a "retry" either.
    expect(drill).toMatch(/if \(verdict !== false\) return verdict;/);
  });

  it("it can only ever turn a no into a yes", () => {
    // The tail of the function returns the exception's own answer, and the only
    // reachable prior verdict at that point is false.
    expect(drill).toMatch(/return expected \? true : false;/);
  });

  it("the original predicate's rules are untouched", () => {
    // The RFQ anchor, the recency rule and the drill window all still gate every
    // other number. If this assertion fails someone merged the two.
    expect(drill).toMatch(/direction=eq\.outbound/);
    expect(drill).toMatch(/classifyIngest\(res\.rows, Date\.now\(\)\)/);
    expect(drill).toMatch(/numberFilter\("to_number", fromDigits\)/);
  });

  it("it is scoped to ONE traveller and ONE agency", () => {
    expect(expectation).toMatch(/user_email=eq\./);
    expect(expectation).toMatch(/agency_tail=eq\./);
  });

  it("it EXPIRES - a handoff from last month authorises nothing", () => {
    expect(expectation).toMatch(/created_at=gte\./);
    expect(expectation).toMatch(/EXPECTATION_TTL_HOURS_DEFAULT = 72/);
  });

  it("only leads we actually DISPATCHED authorise anything", () => {
    // A draft was never sent and a failed/expired one never reached the agency;
    // neither is a reason to expect a message.
    expect(expectation).toMatch(/state=in\.\(template_sent,handoff_sent,handed_off\)/);
    expect(expectation).not.toMatch(/draft/);
  });

  it("with the flag off it short-circuits before touching any table", async () => {
    // The "nothing changes while the flag is off" invariant, made literal.
    const { wabaExpectsInbound } = await import("./expectation");
    expect(await wabaExpectsInbound("66812345678", "a@b.com")).toBe(false);
    expect(selects).toHaveLength(0);
  });

  it("with the flag on and a live lead, it authorises", async () => {
    const { wabaExpectsInbound } = await import("./expectation");
    config.WABA_ENABLED = "on";
    selectResult = { rows: [{ id: 1 }] };
    expect(await wabaExpectsInbound("66812345678", "a@b.com")).toBe(true);
    expect(selects[0].table).toBe("waba_leads");
  });

  it("with the flag on and no lead, it does not", async () => {
    const { wabaExpectsInbound } = await import("./expectation");
    config.WABA_ENABLED = "on";
    selectResult = { rows: [] };
    expect(await wabaExpectsInbound("66812345678", "a@b.com")).toBe(false);
  });

  it("an unreadable expectation is RETRYABLE, never 'not authorised'", async () => {
    // Mirrors the gate's own null contract. Swallowing a genuine handoff reply
    // on our own outage is permanent: the webhook's 200 stops the provider
    // redelivering.
    const { wabaExpectsInbound } = await import("./expectation");
    config.WABA_ENABLED = "on";
    selectResult = { error: "unavailable" };
    expect(await wabaExpectsInbound("66812345678", "a@b.com")).toBeNull();
    expect(drill).toMatch(/if \(expected === null\) return null;/);
  });

  it("a MISSING table means no handoff was ever dispatched", async () => {
    const { wabaExpectsInbound } = await import("./expectation");
    config.WABA_ENABLED = "on";
    selectResult = { error: "missing" };
    expect(await wabaExpectsInbound("66812345678", "a@b.com")).toBe(false);
  });

  it("the two spellings of one agency agree", async () => {
    // Discovery's national form and WhatsApp's international form must resolve
    // to the same authorisation, or the handoff authorises a number that never
    // messages and drops the one that does.
    const { wabaExpectsInbound } = await import("./expectation");
    config.WABA_ENABLED = "on";
    selectResult = { rows: [{ id: 1 }] };
    // The TTL cutoff is stamped from the wall clock, so the two calls differ by
    // a millisecond. That is not what this test is about - blank it out rather
    // than let a real invariant fail on a clock tick.
    const stable = (q: string) => q.replace(/created_at=gte\.[^&]*/, "created_at=gte.<t>");
    await wabaExpectsInbound("66812345678", "a@b.com");
    const first = stable(selects[0].query);
    expect(first).toMatch(/agency_tail=eq\.812345678/);
    expect(first).toMatch(/created_at=gte\.<t>/);
    selects.length = 0;
    await wabaExpectsInbound("0812345678", "a@b.com");
    expect(stable(selects[0].query)).toBe(first);
  });
});
