import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

// THERE WERE TWO OFFICIAL SENDERS AND ONLY ONE OF THEM HAD A SWITCH.
//
// The owner's rule is one sentence: only Evolution sends today; the official
// WhatsApp Business lane starts only when real credentials arrive and the flag
// is deliberately turned on.
//
// The Part-12 handoff lane in lib/waba/ honours that at three independent
// levels - WABA_ENABLED, a dry-run that ships ON, and credential presence.
//
// `lib/whatsapp.ts` is a SECOND, older Meta Cloud API sender, wired into three
// routes (outreach, mass outreach, and the Cloud webhook's auto-reply), and
// none of those three levels governed it. It was off for exactly one reason:
// two Key Vault fields happened to be blank. Pasting a Cloud API token into
// Admin to "see if it works" would have switched a live second sender on across
// all three routes - no dry run, no anti-ban lane budget (lane-split.test.ts
// records that it has none), and no owner decision anywhere in the loop.
//
// And `/h/[token]`, the handoff link the agency taps, read the config into `c`
// and ended with the literal line `void c;`. Every link ever minted still
// resolved with the lane off: it stamped link_tapped_at, wrote a `tap` event,
// and redirected a real agency into a chat with a real traveller.

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

/** Load lib/whatsapp with a stubbed vault. */
async function loadSender(cfg: Record<string, string | undefined>) {
  vi.resetModules();
  vi.doMock("server-only", () => ({}));
  vi.doMock("./runtime-config", () => ({
    getConfig: async (k: string) => cfg[k],
  }));
  return import("./whatsapp");
}

const CREDS = {
  WHATSAPP_ACCESS_TOKEN: "tok",
  WHATSAPP_PHONE_NUMBER_ID: "123",
};

describe("the legacy Cloud sender obeys the master switch", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("REPRODUCTION: credentials alone used to be the whole gate", async () => {
    // Executed against the CURRENT code, so this documents the old rule by
    // showing the new one refusing it: credentials present, flag absent.
    const wa = await loadSender({ ...CREDS });
    expect(
      await wa.whatsappConfigured(),
      "pasting a Cloud API key must not switch on a second live sender"
    ).toBe(false);
    expect(await wa.whatsappCredentialsPresent()).toBe(true);
  });

  it("with the flag off, a send degrades to click-to-chat and touches no network", async () => {
    const wa = await loadSender({ ...CREDS });
    const spy = vi.spyOn(globalThis, "fetch");
    try {
      const r = await wa.sendWhatsApp("+66812345678", "hello");
      expect(r.channel).toBe("click-to-chat");
      expect(r.waLink).toContain("wa.me/66812345678");
      expect(spy, "the Graph API must not be called at all").not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("the flag alone is not enough either - credentials still required", async () => {
    const wa = await loadSender({ CLOUD_API_ENABLED: "on" });
    expect(await wa.whatsappConfigured()).toBe(false);
    const r = await wa.sendWhatsApp("+66812345678", "hello");
    expect(r.channel).toBe("click-to-chat");
  });

  it("flag ON plus credentials is the only live combination", async () => {
    const wa = await loadSender({ ...CREDS, CLOUD_API_ENABLED: "on" });
    expect(await wa.whatsappConfigured()).toBe(true);
  });

  it("the switch is its OWN - a WABA dry-run rehearsal cannot arm this sender", async () => {
    // Rehearsing the governed handoff lane means WABA_ENABLED on + dry-run on.
    // When this module shared WABA_ENABLED, that rehearsal armed THIS sender
    // for real (it reads neither the dry-run nor the governor) - the exact
    // pasting-a-key accident the original switch was built to end, recreated
    // one door over. CLOUD_API_ENABLED is a separate, deliberate decision.
    const wa = await loadSender({ ...CREDS, WABA_ENABLED: "on", WABA_DRY_RUN: "on" });
    expect(
      await wa.whatsappConfigured(),
      "WABA_ENABLED must not arm the legacy Cloud sender"
    ).toBe(false);
    const r = await wa.sendWhatsApp("+66812345678", "hello");
    expect(r.channel).toBe("click-to-chat");
  });

  it("an UNREADABLE vault closes the lane, never opens it", async () => {
    vi.resetModules();
    vi.doMock("server-only", () => ({}));
    vi.doMock("./runtime-config", () => ({
      getConfig: async () => {
        throw new Error("supabase down");
      },
    }));
    const wa = await import("./whatsapp");
    expect(await wa.whatsappConfigured()).toBe(false);
    const r = await wa.sendWhatsApp("+66812345678", "hello");
    expect(r.channel).toBe("click-to-chat");
  });

  it.each(["on", "ON", "1", "true", "yes"])("accepts %s as on", async (v) => {
    const wa = await loadSender({ ...CREDS, CLOUD_API_ENABLED: v });
    expect(await wa.whatsappConfigured()).toBe(true);
  });

  it.each(["off", "", "no", "0", "false", "maybe"])("treats %s as off", async (v) => {
    const wa = await loadSender({ ...CREDS, CLOUD_API_ENABLED: v });
    expect(await wa.whatsappConfigured()).toBe(false);
  });
});

describe("the handoff link is dead while the lane is off", () => {
  const route = readCode("src/app/h/[token]/route.ts");

  it("REGRESSION: `void c;` is gone", () => {
    expect(
      route,
      "the config was read and discarded - the flag governed nothing on this route"
    ).not.toMatch(/void c;/);
  });

  it("the flag is checked, and before the lead is looked up", () => {
    expect(route).toMatch(/if \(!c\.enabled\) return dead\(\)/);
    expect(route.indexOf("if (!c.enabled)")).toBeLessThan(route.indexOf('sbSelectStrict<LeadRow'));
  });

  it("no tap is recorded and no redirect is issued on the off path", () => {
    // `dead()` is the shared neutral redirect used by every other refusal here,
    // so an off lane is indistinguishable from a token that never existed.
    // Compare against the CALL, not the identifier: `noteWabaEvent` first
    // appears in the import line at the top of the file, which is before every
    // guard by construction and would make this assertion unfalsifiable.
    expect(route.indexOf("if (!c.enabled)")).toBeLessThan(route.indexOf("noteWabaEvent(\"tap\""));
    expect(route.indexOf("if (!c.enabled)")).toBeLessThan(route.indexOf("NextResponse.redirect(target"));
  });
});

describe("exactly one live send path with the flags off", () => {
  it("every caller of the Cloud sender goes through the gated predicate", () => {
    for (const p of [
      "src/app/api/outreach/route.ts",
      "src/app/api/outreach/mass/route.ts",
    ]) {
      const code = readCode(p);
      expect(code, p).toMatch(/whatsappConfigured\(\)/);
    }
  });

  it("the gate lives in the module, so no call site can forget it", () => {
    const wa = readCode("src/lib/whatsapp.ts");
    // Both the predicate and the send itself check it. A future caller that
    // skips whatsappConfigured still degrades to click-to-chat.
    expect(wa).toMatch(/officialSendingEnabled\(\)/);
    const send = wa.slice(wa.indexOf("export async function sendWhatsApp"));
    expect(send).toMatch(/if \(!token \|\| !phoneId \|\| !on\) return clickToChat/);
  });

  it("Evolution remains the one unconditional sender", () => {
    // sendFromUser is the Evolution path. It has no WABA flag and must not grow
    // one - it is the engine that actually runs today.
    const evo = readCode("src/lib/evolution.ts");
    expect(evo).toMatch(/export async function sendFromUser/);
    expect(evo).not.toMatch(/WABA_ENABLED/);
  });

  it("Admin can answer 'who can send right now' without reading the source", () => {
    const route = readCode("src/app/api/admin/waba/route.ts");
    expect(route).toMatch(/senders: \[/);
    for (const id of ["evolution", "waba-handoff", "cloud-api"]) {
      expect(route, id).toMatch(new RegExp(`id: "${id}"`));
    }
    // The state this deployment is meant to sit in has to be nameable:
    // credentials in, switch off - and the switch named is this sender's OWN.
    expect(route).toMatch(/credentials ARE set, but CLOUD_API_ENABLED is not on/);
    const ui = readCode("src/components/admin/WabaConsole.tsx");
    expect(ui).toMatch(/Who can send right now/);
    expect(ui).toMatch(/s\.live \? "LIVE" : "OFF"/);
  });
});
