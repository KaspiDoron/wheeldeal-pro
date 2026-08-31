// The Transport abstraction's contract, executed: capability truth, adapter
// delegation (verbatim, zero wire change), and resolveTransport's two-level
// authority (thread stamp > mode > default) with every unreadable input
// degrading to the transport that has carried every message to date.
import { describe, it, expect, vi, beforeEach } from "vitest";

const sends: unknown[][] = [];
let sendResult: Record<string, unknown> = { ok: true, messageId: "m1" };
const wabaSends: unknown[] = [];
let wabaResult: Record<string, unknown> = { ok: true, lane: "freeform", preview: "p", dryRun: false, messageId: "w1" };
let threadRows: { fields: Record<string, unknown> | null }[] = [];
const config: Record<string, string | null> = {};
let wabaBlock: string | null = "no config";
let evoLinked = true;

vi.mock("../../evolution", () => ({
  sendFromUser: async (...a: unknown[]) => {
    sends.push(a);
    return sendResult;
  },
  evolutionConfigured: async () => evoLinked,
  hasSessionRow: async () => evoLinked,
}));
vi.mock("../../waba/send", () => ({
  wabaSend: async (m: unknown) => {
    wabaSends.push(m);
    return wabaResult;
  },
}));
vi.mock("../../waba/config", () => ({
  wabaConfig: async () => ({}),
  wabaBlockReason: () => wabaBlock,
}));
vi.mock("../../runtime-config", () => ({
  sbSelect: async () => threadRows,
  getConfig: async (k: string) => config[k] ?? null,
}));

beforeEach(() => {
  sends.length = 0;
  wabaSends.length = 0;
  sendResult = { ok: true, messageId: "m1" };
  wabaResult = { ok: true, lane: "freeform", preview: "p", dryRun: false, messageId: "w1" };
  threadRows = [];
  for (const k of Object.keys(config)) delete config[k];
  wabaBlock = "no config";
  evoLinked = true;
});

describe("capabilities tell the truth", () => {
  it("evolution: per-traveller identity, cold contact allowed, no service window", async () => {
    const { EVOLUTION_CAPABILITIES } = await import("./evolution");
    expect(EVOLUTION_CAPABILITIES.identity).toBe("per-traveller");
    expect(EVOLUTION_CAPABILITIES.coldFirstContact).toBe(true);
    expect(EVOLUTION_CAPABILITIES.serviceWindowHours).toBeNull();
    expect(EVOLUTION_CAPABILITIES.presence).toBe(true);
  });

  it("waba: company number, NO cold first contact, 24h window - Meta's rules as structure", async () => {
    const { WABA_CAPABILITIES } = await import("./waba");
    expect(WABA_CAPABILITIES.identity).toBe("company-number");
    expect(WABA_CAPABILITIES.coldFirstContact).toBe(false);
    expect(WABA_CAPABILITIES.serviceWindowHours).toBe(24);
    expect(WABA_CAPABILITIES.presence).toBe(false);
  });
});

describe("the evolution adapter delegates verbatim", () => {
  it("sendText passes lane/fast/skipJitter straight through to sendFromUser", async () => {
    const { evolutionTransport } = await import("./evolution");
    const r = await evolutionTransport.sendText("t@x.com", "6681", "hi", {
      lane: "reply",
      fast: true,
      skipJitter: true,
    });
    expect(r.ok).toBe(true);
    expect(sends[0]).toEqual(["t@x.com", "6681", "hi", true, { skipJitter: true, lane: "reply" }]);
  });

  it("defaults are the conservative ones: fast=false, intro metering left to the callee", async () => {
    const { evolutionTransport } = await import("./evolution");
    await evolutionTransport.sendText("t@x.com", "6681", "hi");
    expect(sends[0]).toEqual(["t@x.com", "6681", "hi", false, { skipJitter: undefined, lane: undefined }]);
  });
});

describe("the waba adapter maps its result honestly", () => {
  it("a dry run reads as unconfirmed - no checkmark for a rehearsal", async () => {
    const { wabaTransport } = await import("./waba");
    wabaResult = { ok: true, lane: "freeform", preview: "p", dryRun: true, messageId: "dry-run" };
    const r = await wabaTransport.sendText("t@x.com", "6681", "hi");
    expect(r.ok).toBe(true);
    expect(r.unconfirmed).toBe(true);
  });

  it("the 131049 per-user cap reads as rateLimited - hold, never blind-retry", async () => {
    const { wabaTransport } = await import("./waba");
    wabaResult = { ok: false, lane: "freeform", preview: "p", dryRun: false, recipientCapped: true, error: "cap" };
    const r = await wabaTransport.sendText("t@x.com", "6681", "hi");
    expect(r.ok).toBe(false);
    expect(r.rateLimited).toBe(true);
  });

  it("sends free-form text - the reply leg, never a template", async () => {
    const { wabaTransport } = await import("./waba");
    await wabaTransport.sendText("t@x.com", "6681", "hello shop");
    expect(wabaSends[0]).toEqual({ lane: "freeform", to: "6681", text: "hello shop" });
  });
});

describe("resolveTransport - stamp beats mode beats default", () => {
  it("a thread stamped waba stays waba whatever the mode says", async () => {
    const { resolveTransport } = await import("./index");
    threadRows = [{ fields: { transport: "waba" } }];
    config.TRANSPORT_MODE = "evolution";
    const r = await resolveTransport("t@x.com", "+66 81 234 5678");
    expect(r.transport.kind).toBe("waba");
    expect(r.source).toBe("thread-stamp");
  });

  it("waba-first routes to waba ONLY when the lane is ready", async () => {
    const { resolveTransport } = await import("./index");
    config.TRANSPORT_MODE = "waba-first";
    wabaBlock = "no config"; // not ready -> the working transport, not dead air
    expect((await resolveTransport("t@x.com", "6681")).transport.kind).toBe("evolution");
    wabaBlock = null; // ready
    const r = await resolveTransport("t@x.com", "6681");
    expect(r.transport.kind).toBe("waba");
    expect(r.source).toBe("mode");
  });

  it("waba-fallback: waba only when the traveller's Evolution is NOT linked", async () => {
    const { resolveTransport } = await import("./index");
    config.TRANSPORT_MODE = "waba-fallback";
    wabaBlock = null;
    evoLinked = true;
    expect((await resolveTransport("t@x.com", "6681")).transport.kind).toBe("evolution");
    evoLinked = false;
    expect((await resolveTransport("t@x.com", "6681")).transport.kind).toBe("waba");
  });

  it("no stamp, no mode -> the default that carried every message to date", async () => {
    const { resolveTransport } = await import("./index");
    const r = await resolveTransport("t@x.com", "6681");
    expect(r.transport.kind).toBe("evolution");
    expect(r.source).toBe("default");
  });

  it("an unknown mode string parses to evolution - a typo never arms a lane", async () => {
    const { parseTransportMode } = await import("./index");
    expect(parseTransportMode("waba")).toBe("evolution");
    expect(parseTransportMode("WABA-FIRST")).toBe("waba-first");
    expect(parseTransportMode(null)).toBe("evolution");
  });

  it("'cloud' never resolves from the registry - the ungoverned sender stays unarmed", async () => {
    const { transportByKind } = await import("./index");
    expect(transportByKind("cloud").kind).toBe("evolution");
  });
});
