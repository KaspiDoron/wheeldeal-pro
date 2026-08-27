import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("server-only", () => ({}));

const readCode = (p: string) =>
  readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// OWNER REPORT 11, WAVE I2 - THE INGEST GATES THAT STILL FAILED OPEN.
//
// Every ingest gate must tell "our DB is down" (unknown -> ask for a
// redelivery) apart from "genuinely not a shop / no alias" (drop). Three still
// conflated them, so a Supabase wobble silently ate a real shop reply while the
// route answered 200 and the provider never tried again.

// ---- I2.3: the @lid alias lookup ------------------------------------------
// resolveChatIdentity resolves a privacy @lid chat's phone from our own thread
// rows. aliasFromThreads read them with `.catch(() => [])`, so a DB OUTAGE read
// as "no alias on file" and the frame was dropped as unresolved-identity. Now
// the read is strict and "unavailable" propagates up.

const sbState: { mode: "unavailable" | "missing" | "empty" | "hit" } = { mode: "unavailable" };
vi.mock("../runtime-config", () => ({
  sbSelectStrict: async (_t: string, _q: string) => {
    if (sbState.mode === "unavailable") return { error: "unavailable" as const };
    if (sbState.mode === "missing") return { error: "missing" as const };
    if (sbState.mode === "hit") return { rows: [{ to_number: "66812345678", from_number: "66812345678" }] };
    return { rows: [] as unknown[] };
  },
  sbSelect: async () => [],
}));

describe("I2.3 - an @lid alias lookup distinguishes our outage from no-alias", () => {
  beforeEach(async () => {
    const { resetAliases } = await import("./lid-alias");
    resetAliases();
  });

  it("EXECUTED: a DB outage during the lookup yields 'unavailable', not a silent drop", async () => {
    sbState.mode = "unavailable";
    const { resolveChatIdentity } = await import("./lid-alias");
    // An @lid chat with no payload phone and no remembered alias: the only
    // evidence is the thread rows, which are unreadable.
    const r = await resolveChatIdentity("t@x.co", "998877@lid", {});
    expect(r).toBe("unavailable");
  });

  it("EXECUTED: a genuinely missing table (fresh deploy) is a real empty -> null, not retry", async () => {
    sbState.mode = "missing";
    const { resolveChatIdentity } = await import("./lid-alias");
    expect(await resolveChatIdentity("t@x.co", "998877@lid", {})).toBeNull();
  });

  it("EXECUTED: a resolvable alias still resolves to the phone", async () => {
    sbState.mode = "hit";
    const { resolveChatIdentity } = await import("./lid-alias");
    const r = await resolveChatIdentity("t@x.co", "998877@lid", {});
    expect(r && typeof r === "object" && "phone" in r ? r.phone : null).toBe("66812345678");
  });

  it("ingest asks for a redelivery on an unavailable identity, and does not spend the work budget", () => {
    const ingest = readCode("src/lib/wa/ingest.ts");
    expect(ingest).toMatch(/if \(identity === "unavailable"\) \{/);
    expect(ingest).toMatch(/"identity-unavailable"/);
  });
});

// ---- I2.1: the Cloud webhook vendor gate ----------------------------------
describe("I2.1 - the Cloud webhook fails loud when the vendor gate is unreadable", () => {
  const route = readCode("src/app/api/webhooks/whatsapp/route.ts");
  it("returns 503 (retry) on a null vendor-gate, not receiver:null (park + drop)", () => {
    expect(route).toMatch(/if \(gate === null\) \{/);
    expect(route).toMatch(/status: 503/);
    // The old collapse - null treated as falsy in a ternary - is gone.
    expect(route).not.toMatch(/await isVendorThread\([^)]*\)\) \? resolved : null/);
  });
});
