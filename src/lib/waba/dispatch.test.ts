import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

const config: Record<string, string | null> = {};
let agencyRows: unknown = { rows: [] };
/** The compliance gate's read (waba_agencies.opted_in_at). Defaults to opted
 *  in so the lane tests exercise the lanes; the gate has its own cases. */
let optedIn = true;
/** The TRAVELLER's consent to having their number disclosed to a shop. Same
 *  shape as optedIn: granted by default so the lane tests reach the lanes, with
 *  its own case below - it is the second compliance gate, and it is about the
 *  person, not the business. */
let numberSharing = true;
const inserted: { table: string; rows: Record<string, unknown>[] }[] = [];
const updated: { table: string; filter: string; values: Record<string, unknown> }[] = [];
let nextLeadId = 1;

vi.mock("../runtime-config", () => ({
  getConfig: async (k: string) => config[k] ?? null,
  sbSelectStrict: async (table: string) => (table === "waba_agencies" ? agencyRows : { rows: [] }),
  sbSelect: async (table: string, q: string) => {
    if (table === "waba_agencies" && q.includes("opted_in_at")) {
      return optedIn ? [{ opted_in_at: "2026-08-01T00:00:00Z" }] : [];
    }
    return [];
  },
  sbInsert: async (table: string, rows: Record<string, unknown>[]) => {
    inserted.push({ table, rows });
    return true;
  },
  sbInsertReturning: async (table: string, rows: Record<string, unknown>[]) => {
    inserted.push({ table, rows });
    return [{ ...rows[0], id: nextLeadId++, created_at: new Date().toISOString() }];
  },
  sbUpdate: async (table: string, filter: string, values: Record<string, unknown>) => {
    updated.push({ table, filter, values });
    return true;
  },
}));

vi.mock("../consent", () => ({
  consentFor: async (_e: string, kind: string) =>
    kind === "number_sharing" ? numberSharing : true,
}));

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

const dispatch = readCode("src/lib/waba/dispatch.ts");

const INPUT = {
  userEmail: "t@example.com",
  agencyNumber: "66812345678",
  agencyName: "Sunrise Rentals",
  vehicle: "scooter",
  dates: "12 Aug for 4 days",
  freeformText: "Hey - got someone looking for a scooter, can you message them?",
};

const live = () => {
  config.WABA_ENABLED = "on";
  config.WABA_BASE_URL = "https://example.test";
  config.WABA_API_KEY = "k";
  config.WABA_SENDER_ID = "s";
  config.WABA_TEMPLATE_FIRST_CONTACT = "first_contact";
  config.WABA_LINK_BASE = "https://wheeldeal.test/h";
};

beforeEach(() => {
  for (const k of Object.keys(config)) delete config[k];
  agencyRows = { rows: [] };
  inserted.length = 0;
  updated.length = 0;
  nextLeadId = 1;
  optedIn = true;
  numberSharing = true;
});

const HOUR = 3600_000;

describe("the traveller's own consent gates the disclosure", () => {
  it("EXECUTED: without number_sharing consent the lane falls back, it does not refuse", async () => {
    // This lane hands a rental shop the traveller's WhatsApp number and invites
    // an unsolicited inbound - the exact disclosure `number_sharing` records.
    // Nothing read it before: the column and the ledger kind were both dead, so
    // arming the lane disclosed a phone number with no provable consent.
    //
    // FALL BACK, never refuse. The enquiry still goes out on the traveller's
    // own wire, so a missing record costs nobody their search.
    config.WABA_ENABLED = "on";
    config.WABA_DRY_RUN = "on";
    numberSharing = false;
    const { dispatchHandoff } = await import("./dispatch");
    const out = await dispatchHandoff(INPUT);
    expect(out.outcome).toBe("fallback-legacy");
    expect(out.reason).toBe("no-number-sharing-consent");
    // Nothing was written: no lead, no template claim, no spend.
    expect(inserted).toHaveLength(0);
  });

  it("EXECUTED: the consent is checked BEFORE any budget is spent or read", async () => {
    // Ordering matters: a governor refusal writes events and a lead write is a
    // durable row. The consent question is about whether we may act at all.
    config.WABA_ENABLED = "on";
    config.WABA_KILL = "on";
    numberSharing = false;
    const { dispatchHandoff } = await import("./dispatch");
    const out = await dispatchHandoff(INPUT);
    expect(out.reason).toBe("no-number-sharing-consent");
  });
});

describe("with the flag off the dispatcher steps aside entirely", () => {
  it("it returns the legacy fallback and writes nothing", async () => {
    // Not an error and not a refusal: the official path simply is not the live
    // path, and the caller takes the legacy route exactly as it does today.
    const { dispatchHandoff } = await import("./dispatch");
    const out = await dispatchHandoff(INPUT);
    expect(out.outcome).toBe("fallback-legacy");
    expect(out.reason).toBe("flag-off");
    expect(inserted).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });
});

describe("the ladder picks the free lane whenever it can", () => {
  it("an open window sends free-form, and never pays for a template", async () => {
    live();
    const now = Date.now();
    agencyRows = {
      rows: [{ agency_tail: "812345678", window_expires_at: new Date(now + HOUR).toISOString(), template_capped_until: null, last_template_at: null }],
    };
    const { dispatchHandoff } = await import("./dispatch");
    const out = await dispatchHandoff(INPUT);
    expect(out.outcome).toBe("sent");
    expect(out.lane).toBe("freeform");
    // Free-form content is unconstrained, so the informal register the owner
    // asked for is fully available on this lane.
    expect(out.preview).toContain("can you message them?");
  });

  it("a cold agency sends the template - and a DRY RUN spends NOTHING", async () => {
    // WABA_DRY_RUN defaults ON, so this send is a rehearsal - and a rehearsal
    // used to record the 24h cooldown anyway, so rehearsing against ten
    // agencies locked real travellers out of all ten for a day. The isolation
    // is the fix: no cooldown, no TRUTH-RULE anchor row, dry_run persisted on
    // the lead, and never the "dry-run" sentinel as a provider id.
    live();
    const { dispatchHandoff } = await import("./dispatch");
    const out = await dispatchHandoff(INPUT);
    expect(out.outcome).toBe("sent");
    expect(out.lane).toBe("template");
    expect(out.reason).toBe("dry-run");
    const agencyWrite = inserted.find((i) => i.table === "waba_agencies");
    expect(agencyWrite).toBeUndefined();
    expect(inserted.find((i) => i.table === "whatsapp_messages")).toBeUndefined();
    const leadAdvance = updated.find(
      (u) => u.table === "waba_leads" && u.values.state === "template_sent"
    );
    expect(leadAdvance?.values.dry_run).toBe(true);
    expect(leadAdvance?.values.provider_message_id).toBeNull();
  });

  it("the template carries the traveller's link, not their number in the body", async () => {
    // The tap is what removes the agency's work. Without it we are asking a
    // stranger to transcribe a phone number, which is MORE friction than the
    // cold contact this design replaces - and reply rate would fall.
    live();
    const { dispatchHandoff } = await import("./dispatch");
    const out = await dispatchHandoff(INPUT);
    expect(out.preview).toContain("https://wheeldeal.test/h/");
    expect(out.preview).toContain("Sunrise Rentals");
  });

  it("template variables never include a bare phone number", async () => {
    const { templateVariables } = await import("./dispatch");
    const vars = templateVariables({ agencyName: "Shop", vehicle: "scooter", dates: "12 Aug" });
    for (const v of vars) expect(v).not.toMatch(/\d{7,}/);
  });

  it("an unnamed agency still gets a usable greeting", async () => {
    const { templateVariables } = await import("./dispatch");
    expect(templateVariables({ agencyName: null, vehicle: "car", dates: "x" })[0]).toBe("there");
  });
});

describe("held is a real state, not a silent queue", () => {
  it("a cooled-down agency HOLDS the lead and tells the traveller why", async () => {
    live();
    const now = Date.now();
    agencyRows = {
      rows: [{ agency_tail: "812345678", window_expires_at: null, template_capped_until: null, last_template_at: new Date(now - HOUR).toISOString() }],
    };
    const { dispatchHandoff } = await import("./dispatch");
    const out = await dispatchHandoff(INPUT);
    expect(out.outcome).toBe("held");
    expect(out.reason).toBe("agency-cooldown");
    // Part 5.5: a shop dropped before the loop is counted nowhere and cannot be
    // explained. Every held lead has a row and a sentence.
    expect(out.leadId).toBeTruthy();
    expect(out.userMessage).toContain("Sunrise Rentals");
  });

  it("an unreadable agency read refuses rather than guessing", async () => {
    live();
    agencyRows = { error: "unavailable" };
    const { dispatchHandoff } = await import("./dispatch");
    const out = await dispatchHandoff(INPUT);
    expect(out.outcome).toBe("refused");
    expect(out.reason).toBe("unreadable");
    // Fail closed: no lead row, nothing sent, nothing recorded.
    expect(inserted).toHaveLength(0);
  });
});

describe("the traveller-facing copy obeys constraint 5", () => {
  it("no ban, risk or restriction language anywhere in the dispatcher", () => {
    // That vocabulary belongs on the linking/consent screen and nowhere else.
    // What is happening to our messaging account is our problem, not theirs.
    const copy = dispatch.slice(dispatch.indexOf("const USER_COPY"), dispatch.indexOf("const say ="));
    expect(copy).not.toMatch(/\bban\b|\brisk\b|restrict|blocked|flagged|spam/i);
  });

  it("every outcome has a sentence - none renders as a bare failure", () => {
    for (const k of ["sent", "held", "fallback", "refused"]) {
      expect(dispatch).toMatch(new RegExp(`${k}:\\s*"`));
    }
  });

  it("a refusal says it will retry rather than just failing", () => {
    expect(dispatch).toMatch(/we will try again shortly/);
  });
});

describe("the window flush is what makes a popular agency cheap", () => {
  it("an inbound opens the window and releases the held leads", async () => {
    // Traveller 1 pays the template; travellers 2..9 are held; the agency
    // answers once and they all flush on the free lane. Without this a popular
    // agency costs one template per traveller and 131049 eats the third.
    expect(dispatch).toMatch(/export async function onAgencyReplied/);
    expect(dispatch).toMatch(/await openWindow\(tail, agencyNumber\)/);
    expect(dispatch).toMatch(/sendForLead\(lead, "freeform"/);
  });

  it("a lead that already got a template is NOT re-sent", async () => {
    // It is waiting on the AGENCY to contact the traveller, not on us to send
    // again - re-sending would double-message the agency about one person.
    expect(dispatch).toMatch(/if \(lead\.state !== "held"\) continue;/);
  });

  it("an unusable number cannot open a window", async () => {
    const { onAgencyReplied } = await import("./dispatch");
    const r = await onAgencyReplied("123", () => INPUT);
    expect(r).toEqual({ opened: false, flushed: 0 });
  });
});

describe("131049 is handled as a cap, not a failure", () => {
  it("a capped send holds the lead and records the cap", () => {
    // Marking the agency is what stops the governor choosing it again today;
    // holding the lead is what lets it ride the free lane once the agency
    // answers anyone at all.
    expect(dispatch).toMatch(/if \(result\.recipientCapped\) \{[\s\S]{0,240}markTemplateCapped/);
    expect(dispatch).toMatch(/reason: "recipient-capped"/);
  });

  it("it is not marked failed, so it is not retried into the cap", () => {
    const block = dispatch.slice(
      dispatch.indexOf("if (result.recipientCapped)"),
      dispatch.indexOf('await advanceLead(lead.id, "failed"')
    );
    expect(block).not.toMatch(/"failed"/);
  });
});
