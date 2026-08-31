import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("server-only", () => ({}));

// FUNDING DAY IS A PASTE-AND-FLIP, OR IT IS A CODE CHANGE.
//
// The owner's requirement is precise: the beta runs 100% on Evolution, and the
// day funding lands, arming the company-WABA lane must be pasting keys into
// Admin -> Keys and tapping a switch. An audit found four things that were
// neither: a template LANGUAGE hardcoded in the source, a verify token welded
// to the HMAC signing secret, an opt-in that could only be written by hand in
// SQL, and two Meta URLs that appeared on no screen and in no document.
//
// These tests execute the config resolution and pin the wiring for the rest.

const config: Record<string, string | null> = {};
vi.mock("../runtime-config", () => ({
  getConfig: async (k: string) => config[k] ?? null,
}));

const loadConfig = async () => (await import("./config")).wabaConfig;

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("F1: the template language is pastable, and defaults to today's behaviour", () => {
  it("EXECUTED: unset resolves to 'en' - the change is purely additive", async () => {
    for (const k of Object.keys(config)) delete config[k];
    const c = await (await loadConfig())();
    expect(c.templateLanguage).toBe("en");
  });

  it("EXECUTED: a Meta locale is carried through verbatim", async () => {
    for (const k of Object.keys(config)) delete config[k];
    config.WABA_TEMPLATE_LANGUAGE = "  en_US  ";
    const c = await (await loadConfig())();
    // Meta stores an approved template under the EXACT code it was created
    // with. A mismatch is error 132001 on 100% of sends, and it was previously
    // fixable only by a redeploy.
    expect(c.templateLanguage).toBe("en_US");
  });

  it("EXECUTED: an empty string still falls back rather than sending a blank locale", async () => {
    for (const k of Object.keys(config)) delete config[k];
    config.WABA_TEMPLATE_LANGUAGE = "   ";
    expect((await (await loadConfig())()).templateLanguage).toBe("en");
  });

  it("the send site reads the config instead of a literal", () => {
    const dispatch = readCode("src/lib/waba/dispatch.ts");
    expect(dispatch).toMatch(/language: input\.language \?\? c\.templateLanguage/);
    expect(dispatch).not.toMatch(/language: input\.language \?\? "en"/);
  });

  it("the key is pastable and the key test rejects a non-locale", () => {
    const cfg = readCode("src/lib/config.ts");
    expect(cfg).toMatch(/name: "WABA_TEMPLATE_LANGUAGE"/);
    const test = readCode("src/app/api/admin/key-test/route.ts");
    expect(test).toMatch(/\^\[a-z\]\{2\}\(_\[A-Z\]\{2\}\)\?\$/);
    expect(test).toMatch(/case "WABA_TEMPLATE_LANGUAGE":/);
  });
});

describe("F2: the verify token is not the signing secret", () => {
  it("the handshake reads its own key, with a reseller-compatible fallback", () => {
    const hook = readCode("src/app/api/webhooks/waba/route.ts");
    // Meta sends hub.verify_token as a URL QUERY PARAMETER. Demanding it equal
    // WABA_WEBHOOK_SECRET - which for Meta is the HMAC app secret - meant the
    // only way to pass the handshake was to publish the signing key into every
    // access log in the path.
    expect(hook).toMatch(/getConfig\("WABA_VERIFY_TOKEN"\)/);
    expect(hook).toMatch(/token === verify/);
    expect(hook).not.toMatch(/token === secret/);
  });

  it("the POST signature check still uses the SIGNING secret, unchanged", () => {
    const hook = readCode("src/app/api/webhooks/waba/route.ts");
    expect(hook).toMatch(/const secret = \(await getConfig\("WABA_WEBHOOK_SECRET"\)\) \?\? ""/);
    expect(hook).toMatch(/verifyHmac\(raw, req\.headers\.get\("x-hub-signature-256"\), secret\)/);
  });

  it("both keys are pastable and the labels say which is which", () => {
    const cfg = readCode("src/lib/config.ts");
    expect(cfg).toMatch(/name: "WABA_VERIFY_TOKEN"/);
    expect(cfg).toMatch(/APP SECRET/);
    expect(cfg).toMatch(/never reuse the app secret/);
  });
});

describe("F3: a partner shop can be opted in from the console", () => {
  it("the owner-gated route writes the opt-in and reports the READ-BACK", () => {
    const route = readCode("src/app/api/admin/waba/route.ts");
    // Without this, admitLead refuses every cold template with
    // `not-opted-in` and 100% of traffic silently stays on Evolution - with a
    // hand-written INSERT as the only recourse.
    expect(route).toMatch(/action \?\? ""\) === "opt-in"/);
    expect(route).toMatch(/recordAgencyOptIn\(tail, number\)/);
    // HONEST WRITE: the answer is the read-back, never the request.
    expect(route).toMatch(/const stored = await agencyOptedIn\(tail\)/);
    expect(route).toMatch(/ok: wrote && stored/);
    expect(route).toMatch(/requireOwner/);
  });

  it("the console renders the form", () => {
    const ui = readCode("src/components/admin/WabaConsole.tsx");
    expect(ui).toMatch(/Opt a partner shop in/);
    expect(ui).toMatch(/action: "opt-in"/);
  });
});

describe("F4: the emergency stop covers every company-number lane", () => {
  it("the window flush honours the kill switch, and only the kill switch", () => {
    const dispatch = readCode("src/lib/waba/dispatch.ts");
    const flush = dispatch.slice(dispatch.indexOf("export async function sendForLead"));
    // sendForLead is the SECOND entry point - reached from the webhook when an
    // agency replies - and it consulted no governor at all, so a shop writing
    // in during an incident still put free-form messages on the rented number.
    expect(flush).toMatch(/gov\.binding === "kill-switch"/);
    expect(flush).toMatch(/reason: "kill-switch"/);
    // Deliberately NOT the spend/tier bindings: those meter the paid template
    // lane, and a flush inside an already-open service window costs neither.
    const killBlock = flush.slice(0, flush.indexOf("THE TEMPLATE-LANE CLAIM"));
    expect(killBlock).not.toMatch(/binding === "spend"/);
  });
});

describe("F5: the traveller consented to the disclosure this lane makes", () => {
  it("the one clickwrap records the siblings its label names", () => {
    const accept = readCode("src/app/api/legal/accept/route.ts");
    // legal.ts documents the signup consents as collected through a single
    // labelled action - but only `terms` was written, so consentFor(...,
    // "number_sharing") was false for every user alive.
    expect(accept).toMatch(/"wa_risk", "ai_responsibility", "number_sharing"/);
    expect(accept).toMatch(/via: "terms-clickwrap"/);
  });

  it("the dispatcher gates on it and FALLS BACK rather than refusing", () => {
    const dispatch = readCode("src/lib/waba/dispatch.ts");
    expect(dispatch).toMatch(/consentFor\(input\.userEmail, "number_sharing"\)/);
    expect(dispatch).toMatch(/reason: "no-number-sharing-consent"/);
    // Falling back costs nobody their search; refusing would.
    const idx = dispatch.indexOf("no-number-sharing-consent");
    expect(dispatch.slice(idx - 200, idx)).toMatch(/outcome: "fallback-legacy"/);
  });
});

describe("F6/F7: the card an owner reads to confirm what is live", () => {
  it("an unreadable vault is UNKNOWN, not 'unset (default)'", () => {
    // For WABA_KILL "unset" reads as "not killed"; for TRANSPORT_MODE it reads
    // as "evolution". A vault brownout looked exactly like a healthy
    // Evolution-only deployment on the one screen that answers that question.
    expect(readCode("src/app/api/admin/waba/route.ts")).toMatch(/unreadable = true/);
    expect(readCode("src/components/admin/WabaConsole.tsx")).toMatch(/t\.unreadable/);
  });

  it("arming a live sender is a RED tap, like killing one", () => {
    const ui = readCode("src/components/admin/WabaConsole.tsx");
    // CLOUD_API_ENABLED has no dry run, no governor and no anti-ban lane
    // budget: one neutral-looking tap started a second live sender across
    // three call sites. Turning the dry run off is the same class of decision.
    expect(ui).toMatch(/t\.key === "CLOUD_API_ENABLED" \? "on"/);
    expect(ui).toMatch(/t\.key === "WABA_DRY_RUN" \? "off"/);
    expect(ui).toMatch(/arms !== null && v === arms/);
  });
});

describe("F8: the two URLs that go into Meta are on the screen and in the guide", () => {
  it("the route resolves them from APP_DOMAIN and flags a link-base mismatch", () => {
    const route = readCode("src/app/api/admin/waba/route.ts");
    expect(route).toMatch(/callbackUrl: `\$\{origin\}\/api\/webhooks\/waba`/);
    expect(route).toMatch(/expectedLinkBase: `\$\{origin\}\/h`/);
    // A button base that does not EQUAL WABA_LINK_BASE is rejected on every
    // send, with nothing anywhere to explain why.
    expect(route).toMatch(/linkBaseMatches: c\.linkBase === `\$\{origin\}\/h`/);
  });

  it("the guide has a WABA go-live section naming every key", () => {
    const guide = readFileSync(join(process.cwd(), "GUIDE.md"), "utf8");
    expect(guide).toMatch(/WhatsApp Business \(WABA\) go-live/);
    for (const key of [
      "WABA_ACCOUNT_ID",
      "WABA_TEMPLATE_LANGUAGE",
      "WABA_VERIFY_TOKEN",
      "WABA_LINK_BASE",
      "TRANSPORT_MODE",
    ]) {
      expect(guide, key).toContain(key);
    }
    // And it has to say the beta needs none of it.
    expect(guide).toMatch(/Nothing here is needed for the beta/);
  });
});

describe("F9: nothing promises behaviour that does not exist", () => {
  it("the re-engage template is labelled RESERVED", () => {
    const cfg = readCode("src/lib/config.ts");
    // Nothing sends it - the owner would have got a Meta template approved for
    // a code path that does not exist.
    expect(cfg).toMatch(/WABA_TEMPLATE_REENGAGE[^\n]*RESERVED/);
  });

  it("the account id exists so the template can be verified before the first send", () => {
    expect(readCode("src/lib/config.ts")).toMatch(/name: "WABA_ACCOUNT_ID"/);
    const test = readCode("src/app/api/admin/key-test/route.ts");
    expect(test).toMatch(/message_templates\?name=/);
    expect(test).toMatch(/132001/);
  });
});

describe("F10: the ledger records the wire that actually carried the message", () => {
  it("mass outreach stamps `evolution` at SELECTION, like the single Ask", () => {
    const mass = readCode("src/app/api/outreach/mass/route.ts");
    const idx = mass.indexOf('"selected"');
    expect(idx).toBeGreaterThan(0);
    // Everything below selection can still fall through to Evolution - a dry
    // run, an un-opted-in shop, any servable refusal - so "waba" here put a
    // transport on the ledger and the product_events projection that nothing
    // carried. The real wire is stamped at `contacted`, by the lane that
    // delivered it.
    expect(mass.slice(idx - 400, idx)).toMatch(/transport: "evolution"/);
    expect(mass.slice(idx - 400, idx)).not.toMatch(/transport: "waba"/);
  });
});

describe("F11: the flag-off invariant holds, without stranding held leads", () => {
  it("the sweep gates on CONFIGURED, not on the on/off switch", () => {
    const dispatch = readCode("src/lib/waba/dispatch.ts");
    const sweep = dispatch.slice(dispatch.indexOf("export async function sweepExpiredHolds"));
    expect(sweep).toMatch(/if \(!cfg\.senderId && !cfg\.apiKey\) return \{ expired: 0, redispatched: 0 \}/);
    // Gating on `enabled` would strand exactly the leads rung 4 exists to
    // rescue when the owner turns the lane off or kills it mid-incident.
    expect(sweep.slice(0, sweep.indexOf("expiredHolds"))).not.toMatch(/\.enabled\)/);
  });
});

describe("the beta default is unchanged: nothing here is armed", () => {
  it("EXECUTED: with nothing pasted the lane is off and the dry run is on", async () => {
    for (const k of Object.keys(config)) delete config[k];
    const c = await (await loadConfig())();
    expect(c.enabled).toBe(false);
    expect(c.dryRun).toBe(true);
  });

  it("EXECUTED: the dry run stays on until somebody deliberately turns it off", async () => {
    for (const k of Object.keys(config)) delete config[k];
    config.WABA_ENABLED = "on";
    expect((await (await loadConfig())()).dryRun).toBe(true);
    config.WABA_DRY_RUN = "off";
    expect((await (await loadConfig())()).dryRun).toBe(false);
  });
});
