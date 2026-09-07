// AUDIT F153 - a voice note nobody could hear must leave a breadcrumb AND an
// honest ask, like every other media failure class.
//
// The photo path writes media-fetch-failed, the video path writes
// media-unreadable, and the vision ladder writes five vision-* kinds. The audio
// branch wrote nothing at all: a download that returned null fell through the
// `if (media)` and a transcription that returned null fell through an empty
// catch. With GROQ_TOKEN revoked and no Gemini key the whole fleet's voice
// notes silently became the bare label "[voice note]", extraction ran over a
// bracket, and Admin -> Health showed a confident zero over a dead capability.
//
// These tests EXECUTE processEvolutionWebhook over a voice note that cannot be
// heard, in both failure classes.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const events: Array<{ kind: string; detail: string; to?: string }> = [];
const turns: Array<Record<string, any>> = [];
let mediaBytes: { mime: string; base64: string } | null = {
  mime: "audio/ogg; codecs=opus",
  base64: "T2dnUwACAA==",
};
let transcript: { text: string; source: string } | null = null;

vi.mock("@/lib/runtime-config", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getConfig: async () => undefined,
  sbSelect: async () => [],
  sbSelectStrict: async () => ({ rows: [] as unknown[] }),
  sbInsert: async () => true,
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
  fetchMediaBase64: async () => mediaBytes,
}));
vi.mock("@/lib/media/audit", () => ({ storeMediaAudit: () => Promise.resolve(undefined) }));
vi.mock("@/lib/graph/transcribe", () => ({ transcribeAudio: async () => transcript }));
vi.mock("@/lib/agent-loop", async (orig) => {
  const real = await orig<Record<string, any>>();
  return {
    ...real,
    processVendorReply: async (args: Record<string, any>) => {
      turns.push(args);
      return {};
    },
  };
});
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
vi.mock("@/lib/events", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  insertUserEvent: async (_email: string, row: any) => {
    events.push({ kind: row.kind, detail: String(row.detail ?? ""), to: row.to_number });
    return true;
  },
}));
vi.mock("@/lib/wa-guard", () => ({ drainOutbox: async () => 0 }));
vi.mock("@/lib/graph/engine", () => ({ drainGraphWakeups: async () => 0 }));

import { processEvolutionWebhook } from "./ingest";
import { AGENT_EVENT_KINDS } from "../events";

const payload = (id: string) => ({
  event: "messages.upsert",
  instance: "wd-traveller",
  data: {
    key: { remoteJid: "66812345678@s.whatsapp.net", fromMe: false, id },
    message: { audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt: true } },
    messageTimestamp: Math.floor(Date.now() / 1000),
  },
});

beforeEach(() => {
  events.length = 0;
  turns.length = 0;
  mediaBytes = { mime: "audio/ogg; codecs=opus", base64: "T2dnUwACAA==" };
  transcript = null;
});

describe("a voice note nobody could transcribe is never silent", () => {
  it("registers the breadcrumb kind so a panel can count it", () => {
    expect(AGENT_EVENT_KINDS).toContain("transcribe-failed");
  });

  it("writes a breadcrumb when the transcriber answers with nothing", async () => {
    await processEvolutionWebhook(payload("MSG-VOICE-T1"));
    const row = events.find((e) => e.kind === "transcribe-failed");
    expect(row, "a dead transcription capability must leave a countable row").toBeTruthy();
    expect(row?.detail).toMatch(/transcri/i);
  }, 30_000);

  it("writes the same breadcrumb when the audio could not even be downloaded", async () => {
    mediaBytes = null;
    await processEvolutionWebhook(payload("MSG-VOICE-T2"));
    const row = events.find((e) => e.kind === "transcribe-failed");
    expect(row, "a voice note we could not download is the same loss to the traveller").toBeTruthy();
    expect(row?.detail).toMatch(/download/i);
  }, 30_000);

  it("asks the shop for the price in words instead of extracting from a bare label", async () => {
    await processEvolutionWebhook(payload("MSG-VOICE-T3"));
    expect(turns.length).toBe(1);
    expect(turns[0].text).toBe("[voice note]");
    const pre = turns[0].preExtracted;
    expect(pre, "an unheard voice note must carry the never-silent clarify").toBeTruthy();
    expect(String(pre?.clarifyMessage ?? "")).toMatch(/\w/);
    expect(pre?.found).toBe(false);
    expect(pre?.matchesSpec).toBe(true);
    // A voice note is not an image: stamping an imageRead here would arm the
    // deferred IMAGE re-read and render a photo reading panel under audio.
    expect(pre?.imageRead).toBeUndefined();
  }, 30_000);

  it("stays quiet when the transcription actually worked", async () => {
    transcript = { text: "five hundred baht per day", source: "groq" };
    await processEvolutionWebhook(payload("MSG-VOICE-T4"));
    expect(events.some((e) => e.kind === "transcribe-failed")).toBe(false);
    expect(turns[0]?.preExtracted).toBeUndefined();
  }, 30_000);
});
