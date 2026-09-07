// AUDIT F152 - a voice note's bytes must get an audit copy, like every other
// media kind on the inline path.
//
// storeMediaAudit is called for burst image frames and for native video, and
// never for audio. /api/wa/media's AUDIT_EXTS lists "ogg" and media/audit.ts's
// ext map produces it, so the reader probes `<id>.ogg` for a copy no writer
// ever produced: once the mandatory wd-evo-prune cron and the WhatsApp CDN
// expire the original, the <audio> element in "Full conversation" is
// permanently dead while a photo from the same thread still plays.
//
// This test EXECUTES processEvolutionWebhook over an inbound voice note.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const audits: Array<{ id: string; mime: string; base64: string }> = [];
const inserts: Array<{ table: string; rows: any[] }> = [];

vi.mock("@/lib/runtime-config", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getConfig: async () => undefined,
  sbSelect: async () => [],
  sbSelectStrict: async () => ({ rows: [] as unknown[] }),
  sbInsert: async (table: string, rows: any[]) => {
    inserts.push({ table, rows });
    return true;
  },
  sbUpdate: async () => true,
  sbDelete: async () => true,
}));

vi.mock("@/lib/evolution", () => ({
  resolveInstanceEmail: async () => ({ ok: true, email: "traveller@example.com" }),
  emailForInstance: async () => "traveller@example.com",
  sendFromUser: async () => ({ ok: true }),
  markMessageAsRead: async () => true,
  readReceiptDelayMs: () => 0,
  pauseIdleSessions: async () => 0,
  notePairingRotation: async () => {},
  markOpen: async () => {},
  fetchMediaBase64: async () => ({ mime: "audio/ogg; codecs=opus", base64: "T2dnUwACAA==" }),
}));
vi.mock("@/lib/media/audit", () => ({
  storeMediaAudit: (id: string, media: { mime: string; base64: string }) => {
    audits.push({ id, mime: media.mime, base64: media.base64 });
    return Promise.resolve(undefined);
  },
}));
vi.mock("@/lib/graph/transcribe", () => ({
  transcribeAudio: async () => ({ text: "five hundred baht per day", source: "groq" as const }),
}));
vi.mock("@/lib/agent-loop", () => ({
  processVendorReply: async () => ({}),
  photoClarifyExtraction: () => ({}),
  videoClarifyExtraction: () => ({}),
  voiceClarifyExtraction: () => ({}),
}));
vi.mock("@/lib/drill", () => ({ isVendorThread: async () => true }));
vi.mock("@/lib/wa/lid-alias", () => ({
  resolveChatIdentity: async () => ({ phone: "66812345678", lid: "" }),
  rememberAlias: () => {},
  lidAliasForShop: async () => "",
}));
vi.mock("@/lib/wa/inbound-claim", () => ({
  claimInboundStore: async () => true,
  claimIsDeadTurn: () => false,
  claimKey: (email: string, id: string) => `${email}:${id}`,
  quotedInList: (ids: string[]) => ids.join(","),
}));
vi.mock("@/lib/wa/kick", () => ({ kickDispatcher: async () => true }));
vi.mock("@/lib/events", () => ({ insertUserEvent: async () => true }));
vi.mock("@/lib/wa-guard", () => ({ drainOutbox: async () => 0 }));
vi.mock("@/lib/graph/engine", () => ({ drainGraphWakeups: async () => 0 }));

import { processEvolutionWebhook } from "./ingest";

const payload = {
  event: "messages.upsert",
  instance: "wd-traveller",
  data: {
    key: { remoteJid: "66812345678@s.whatsapp.net", fromMe: false, id: "MSG-VOICE-1" },
    message: { audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt: true } },
    messageTimestamp: Math.floor(Date.now() / 1000),
  },
};

beforeEach(() => {
  audits.length = 0;
  inserts.length = 0;
});

describe("the inline path audits voice-note bytes", () => {
  it("stores a redeemable copy of the audio it just downloaded", async () => {
    await processEvolutionWebhook(payload);
    expect(inserts.some((i) => i.table === "whatsapp_messages")).toBe(true);
    expect(
      audits.map((a) => a.id),
      "a voice note we held bytes for must get an audit copy, like a photo or a video"
    ).toContain("MSG-VOICE-1");
    const copy = audits.find((a) => a.id === "MSG-VOICE-1");
    expect(copy?.mime).toMatch(/ogg/);
    expect(copy?.base64).toBe("T2dnUwACAA==");
  }, 30_000);
});
