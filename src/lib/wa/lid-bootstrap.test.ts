import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

// THE @lid BOOTSTRAP HOLE, closed. Qui Motorbike Rental replied three times
// with prices; the frames arrived under an @lid identity, the payload phone
// field did not parse, and BOTH fallbacks were structurally unreachable on a
// fresh thread: the process-memory alias was empty (new instance) and the
// thread-alias read looked only at INBOUND rows - which only a previously
// successful ingest could have written. First reply of every privacy-migrated
// thread: unresolvable by construction. The alias now bootstraps from OUR OWN
// outbound anchor (raw.lid stamped at send time from the provider's
// key.remoteJid), and the payload parser accepts any plausible phone spelling
// while still refusing to ever read digits out of an @lid.

// Controllable thread rows for aliasFromThreads/lidAliasForShop.
const state = {
  outbound: [] as Array<{ to_number: string; raw: { lid?: string } }>,
  inbound: [] as Array<{ from_number: string }>,
};
vi.mock("../runtime-config", () => ({
  // lidAliasForShop still reads with sbSelect...
  sbSelect: async (_t: string, q: string) => {
    if (q.includes("direction=eq.outbound")) return state.outbound;
    if (q.includes("direction=eq.inbound")) return state.inbound;
    return [];
  },
  // ...and aliasFromThreads now reads STRICT so it can tell our outage apart
  // from an empty result (OR11 I2.3). Same rows, wrapped in the strict shape.
  sbSelectStrict: async (_t: string, q: string) => {
    if (q.includes("direction=eq.outbound")) return { rows: state.outbound };
    if (q.includes("direction=eq.inbound")) return { rows: state.inbound };
    return { rows: [] };
  },
}));

import {
  phoneFromPayload,
  resolveChatIdentity,
  lidAliasForShop,
  resetAliases,
} from "./lid-alias";

beforeEach(() => {
  resetAliases();
  state.outbound = [];
  state.inbound = [];
});

describe("phoneFromPayload - any plausible phone spelling, never an @lid", () => {
  it("accepts the human-formatted spelling providers actually send", () => {
    expect(phoneFromPayload({ key: { senderPn: "+63 977 662 0146" } })).toBe("639776620146");
    expect(phoneFromPayload({ key: { participantPn: "63-977-662-0146" } })).toBe("639776620146");
  });

  it("reads the participant/contextInfo fields some builds use", () => {
    expect(phoneFromPayload({ key: { participant: "639776620146@s.whatsapp.net" } })).toBe("639776620146");
    expect(phoneFromPayload({ contextInfo: { participant: "639776620146@s.whatsapp.net" } })).toBe("639776620146");
  });

  it("PRIVACY KEYSTONE: an @lid candidate never yields a phone, in any field", () => {
    expect(phoneFromPayload({ key: { participant: "84912435006@lid" } })).toBe("");
    expect(phoneFromPayload({ contextInfo: { participant: "84912435006@lid" } })).toBe("");
  });

  it("implausible digit runs are rejected (too short / too long)", () => {
    expect(phoneFromPayload({ key: { senderPn: "1234567" } })).toBe("");
    expect(phoneFromPayload({ key: { senderPn: "order 12345678901234567890" } })).toBe("");
  });
});

describe("resolveChatIdentity - the first reply resolves from our own anchor", () => {
  it("an @lid frame with NO payload phone resolves via the outbound raw.lid", async () => {
    state.outbound = [{ to_number: "639776620146", raw: { lid: "84912435006" } }];
    const id = await resolveChatIdentity("owner@x.com", "84912435006@lid", { key: {} });
    expect(id).toEqual({ phone: "639776620146", via: "thread", lid: "84912435006" });
  });

  it("still fails CLOSED with no evidence anywhere", async () => {
    const id = await resolveChatIdentity("owner@x.com", "84912435006@lid", { key: {} });
    expect(id).toBe(null);
  });
});

describe("lidAliasForShop - the reverse lookup the recovery sweep uses", () => {
  it("finds the lid our outbound anchor recorded", async () => {
    state.outbound = [{ to_number: "639776620146", raw: { lid: "84912435006" } }];
    expect(await lidAliasForShop("owner@x.com", "639776620146")).toBe("84912435006");
    expect(await lidAliasForShop("owner@x.com", "")).toBe("");
  });
});

const readCode = (p: string) =>
  readFileSync(p, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("the bootstrap chain is wired end to end (source pins)", () => {
  it("sends surface the provider's chat JID and every sent-row writer stamps raw.lid", () => {
    expect(readCode("src/lib/evolution.ts")).toMatch(/chatJid: chatJid \|\| undefined/);
    expect(readCode("src/lib/wa-guard.ts")).toMatch(/lidKey\(r\.chatJid\) \? \{ lid: lidKey\(r\.chatJid\) \}/);
    expect(readCode("src/app/api/outreach/mass/route.ts")).toMatch(/sentChatLid \? \{ lid: sentChatLid \}/);
    expect(readCode("src/app/api/outreach/route.ts")).toMatch(/lidKey\(result\.chatJid\)/);
  });

  it("the thread-alias read covers BOTH directions", () => {
    const alias = readCode("src/lib/wa/lid-alias.ts");
    expect(alias).toMatch(/direction=eq\.outbound/);
    expect(alias).toMatch(/direction=eq\.inbound/);
  });

  it("ingest fails LOUD on its own outage instead of eating the message", () => {
    const ingest = readCode("src/lib/wa/ingest.ts");
    expect(ingest).toMatch(/retryable = true/);
    expect(ingest).toMatch(/vendor-gate-unavailable/);
    expect(ingest).toMatch(/store-failed/);
    expect(ingest).toMatch(/releaseInboundStore/);
    expect(ingest).toMatch(/batch-truncated/);
    expect(ingest).toMatch(/store-claim-lost/);
    // The strict gate is real, not a truthiness accident.
    expect(ingest).toMatch(/const gate = await isVendorThread\(from, email\);/);
    expect(ingest).toMatch(/if \(gate === null\)/);
    const drill = readCode("src/lib/drill.ts");
    expect(drill).toMatch(/Promise<boolean \| null>/);
    expect(drill).toMatch(/sbSelectStrict/);
  });

  it("both transports honor the retryable outcome", () => {
    expect(readCode("src/app/api/webhooks/evolution/route.ts")).toMatch(/status: 503/);
    expect(readCode("services/workers/src/incoming.worker.ts")).toMatch(/outcome\?\.retryable/);
  });

  it("the recovery sweep pulls the @lid form when the phone-jid pull is empty", () => {
    const sync = readCode("src/lib/wa-sync.ts");
    expect(sync).toMatch(/lidAliasForShop/);
    expect(sync).toMatch(/@lid/);
    // The per-candidate origin assertion stays strict.
    expect(sync).toMatch(/m\.remoteJid === cand \|\| sameNumber\(m\.remoteJid, digits\)/);
  });
});
