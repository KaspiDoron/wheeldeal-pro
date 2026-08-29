import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

// ONE ENGINE, INTERCHANGEABLE WIRES - THE WIRING THAT MAKES IT TRUE.
//
// resolveTransport's contract says the thread's own stamp outranks the mode.
// That is only a fact if (a) something writes the stamp exactly once, at the
// moment the wire became real, and (b) both first-contact routes actually ask
// resolveTransport before falling into the Evolution lane. (a) is executable
// below; (b) is pinned, because the routes are request handlers.

let selectRows: unknown[] = [];
const updates: { table: string; filter: string; values: Record<string, unknown> }[] = [];
let updateRows: unknown[] = [];

vi.mock("../runtime-config", () => ({
  sbSelect: async () => selectRows,
  sbUpdateReturning: async (table: string, filter: string, values: Record<string, unknown>) => {
    updates.push({ table, filter, values });
    return updateRows;
  },
}));

beforeEach(() => {
  selectRows = [];
  updates.length = 0;
  updateRows = [{ thread_key: "t@example.com:66812345678" }];
});

describe("stampThreadTransport is write-once by FILTER, not by hope", () => {
  it("a fresh thread row (null fields) takes the stamp", async () => {
    selectRows = [{ fields: null }];
    const { stampThreadTransport } = await import("./transport-stamp");
    const ok = await stampThreadTransport("t@example.com:66812345678", "waba");
    expect(ok).toBe(true);
    expect(updates[0].values.fields).toEqual({ transport: "waba" });
    // The guard that makes two racing contacts unable to both stamp: the
    // PATCH itself refuses a row whose transport is already set (and
    // NULL->>x is NULL, so a null fields column passes the same filter).
    expect(updates[0].filter).toContain("fields->>transport=is.null");
  });

  it("an already-stamped thread is immutable - no write is even attempted", async () => {
    selectRows = [{ fields: { transport: "evolution", digest: { keep: true } } }];
    const { stampThreadTransport } = await import("./transport-stamp");
    expect(await stampThreadTransport("t@example.com:66812345678", "waba")).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it("engine-owned fields survive the stamp (merge, never replace)", async () => {
    selectRows = [{ fields: { digest: { rounds: 3 }, phase: "negotiating" } }];
    const { stampThreadTransport } = await import("./transport-stamp");
    await stampThreadTransport("t@example.com:66812345678", "evolution");
    expect(updates[0].values.fields).toEqual({
      digest: { rounds: 3 },
      phase: "negotiating",
      transport: "evolution",
    });
  });

  it("a missing row stamps nothing - delivery creates the row first", async () => {
    selectRows = [];
    const { stampThreadTransport } = await import("./transport-stamp");
    expect(await stampThreadTransport("t@example.com:66812345678", "waba")).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it("losing the guarded PATCH race reports false, never a lie", async () => {
    selectRows = [{ fields: null }];
    updateRows = [];
    const { stampThreadTransport } = await import("./transport-stamp");
    expect(await stampThreadTransport("t@example.com:66812345678", "waba")).toBe(false);
  });
});

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("the stamp is written where delivery is recorded", () => {
  it("advanceThreadStage stamps the wire at `contacted`, and only there", () => {
    const stages = readCode("src/lib/funnel/stages.ts");
    expect(stages).toMatch(/if \(to === "contacted"\) \{[\s\S]{0,200}stampThreadTransport/);
    // Exactly one call site inside the ledger - a stamp per stage would make
    // the reply leg (advanced with transport "evolution") fight the handoff.
    expect((stages.match(/stampThreadTransport\(/g) ?? []).length).toBe(1);
  });
});

describe("both first-contact routes ask resolveTransport before the Evolution lane", () => {
  const outreach = readCode("src/app/api/outreach/route.ts");
  const mass = readCode("src/app/api/outreach/mass/route.ts");

  it("the single Ask routes a cold RFQ through the resolver", () => {
    expect(outreach).toMatch(/resolveTransport\(session\.email, digits\)/);
    // WABA resolution sits ABOVE guardOutbound: the guard governs the
    // traveller's number; a company-wire send is governed by the WABA
    // governor + admission inside dispatchHandoff.
    expect(outreach.indexOf("resolveTransport(")).toBeLessThan(outreach.indexOf("guardOutbound({"));
    expect(outreach).toMatch(/dispatchHandoff\(\{/);
  });

  it("the mass batch resolves PER SHOP, above the intro budget and the stagger", () => {
    expect(mass).toMatch(/resolveTransport\(session\.email, digits\)/);
    // A company-wire lead spends neither the traveller's Evolution intro
    // allowance nor a stagger slot - so the branch must come before both.
    expect(mass.indexOf("resolveTransport(")).toBeLessThan(mass.indexOf("isNewIntro && newIntrosLeft <= 0"));
    expect(mass.indexOf("resolveTransport(")).toBeLessThan(mass.indexOf("const slot = sendIndex++"));
  });

  it("a DRY RUN rehearsal falls through - the traveller's real enquiry still goes out", () => {
    // The rehearsal records the WABA funnel moving; swallowing the real send
    // behind it would make TRANSPORT_MODE=waba-first + default dry-run a
    // product outage.
    for (const code of [outreach, mass]) {
      expect(code).toMatch(/out\.outcome === "sent" && out\.reason === "dry-run"/);
      expect(code).toMatch(/out\.outcome === "sent" && !rehearsal/);
    }
  });

  it("both routes pass the rfq so the dispatcher can write a truthful anchor", () => {
    expect(outreach).toMatch(/rfq: settledRfq \?\? undefined/);
    expect(mass).toMatch(/rfq: settledRfq \?\? undefined/);
  });

  it("a fleet-suppressed shop is refused with honest copy, on both routes", () => {
    expect(outreach).toMatch(/out\.reason === "suppressed"/);
    expect(mass).toMatch(/out\.reason === "suppressed"/);
    expect(mass).toMatch(/not-contactable/);
  });
});

describe("the architecture switchboard writes honestly", () => {
  const route = readCode("src/app/api/admin/waba/route.ts");

  it("POST is OWNER-gated - starting a live sender is above the management tier", () => {
    expect(route).toMatch(/export async function POST[\s\S]{0,200}requireOwner\(\)/);
  });

  it("only the named toggles are writable - the vault stays the door for keys", () => {
    for (const k of ["TRANSPORT_MODE", "WABA_ENABLED", "WABA_DRY_RUN", "WABA_KILL", "CLOUD_API_ENABLED"]) {
      expect(route).toContain(k);
    }
    expect(route).toMatch(/unknown toggle/);
  });

  it("the response echoes the vault's READ-BACK, never the request", () => {
    expect(route).toMatch(/const stored = \(await getConfig\(key\)/);
    expect(route).toMatch(/ok: wrote\.ok && stored === value/);
  });

  it("TRANSPORT_MODE only accepts the three real modes", () => {
    expect(route).toMatch(/parseTransportMode\(v\) === v/);
  });
});
