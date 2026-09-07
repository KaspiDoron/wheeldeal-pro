// AUDIT F154 - the never-silent clarify guard must cover every media label the
// shared reader can emit, not just "[photo]" and "[image]".
//
// waMessageText returns "[document]" for a captionless PDF rate card and
// "[video note]" for a round ptvMessage. The guard compared syntheticText
// against three string literals, so both frames skipped BOTH clarify arms and
// ran a turn that extracted from a bare bracket label with no reading stamped -
// and the one breadcrumb the PDF did produce called it a "Photo".
//
// The decision is a pure function now, so it is executed rather than grepped,
// and the webhook tests below drive the two frames that used to fall through.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const events: Array<{ kind: string; detail: string }> = [];
const turns: Array<Record<string, any>> = [];
let media: { mime: string; base64: string } | null = null;

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
  fetchMediaBase64: async () => media,
}));
vi.mock("@/lib/media/audit", () => ({ storeMediaAudit: () => Promise.resolve(undefined) }));
vi.mock("@/lib/graph/transcribe", () => ({ transcribeAudio: async () => null }));
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
    events.push({ kind: row.kind, detail: String(row.detail ?? "") });
    return true;
  },
}));
vi.mock("@/lib/wa-guard", () => ({ drainOutbox: async () => 0 }));
vi.mock("@/lib/graph/engine", () => ({ drainGraphWakeups: async () => 0 }));

import { processEvolutionWebhook } from "./ingest";
import { mediaClarifyKind } from "./media-clarify";

const OVERSIZED = "A".repeat(4 * 1024 * 1024 + 32);

const frame = (id: string, message: Record<string, unknown>) => ({
  event: "messages.upsert",
  instance: "wd-traveller",
  data: {
    key: { remoteJid: "66812345678@s.whatsapp.net", fromMe: false, id },
    message,
    messageTimestamp: Math.floor(Date.now() / 1000),
  },
});

beforeEach(() => {
  events.length = 0;
  turns.length = 0;
  media = null;
});

describe("mediaClarifyKind (pure)", () => {
  const base = {
    mediaFetchFailed: false,
    videoUnreadable: false,
    audioUnreadable: false,
  };
  it("covers every label the shared reader can emit, not two of them", () => {
    expect(mediaClarifyKind({ ...base, text: "[photo]", mediaFetchFailed: true })).toBe("photo");
    expect(mediaClarifyKind({ ...base, text: "[image]", mediaFetchFailed: true })).toBe("photo");
    expect(mediaClarifyKind({ ...base, text: "[document]", mediaFetchFailed: true })).toBe("photo");
    expect(mediaClarifyKind({ ...base, text: "", mediaFetchFailed: true })).toBe("photo");
    expect(mediaClarifyKind({ ...base, text: "[video]", videoUnreadable: true })).toBe("video");
    expect(mediaClarifyKind({ ...base, text: "[video note]", videoUnreadable: true })).toBe("video");
    expect(mediaClarifyKind({ ...base, text: "[voice note]", audioUnreadable: true })).toBe("voice");
  });

  it("never overrides words the shop actually wrote", () => {
    // A caption carries the price far more often than the clarify would get it,
    // so a frame with real words is a text turn even when its media failed.
    expect(mediaClarifyKind({ ...base, text: "500 baht per day", mediaFetchFailed: true })).toBeNull();
    expect(mediaClarifyKind({ ...base, text: "[photo]" })).toBeNull();
  });
});

describe("the frames that used to fall through the guard", () => {
  it("a captionless PDF rate card gets an ask, and an honest failure class", async () => {
    media = { mime: "application/pdf", base64: OVERSIZED };
    await processEvolutionWebhook(frame("MSG-DOC-1", {
      documentMessage: { mimetype: "application/pdf", fileName: "rates.pdf" },
    }));
    expect(turns.length).toBe(1);
    expect(turns[0].text).toBe("[document]");
    const pre = turns[0].preExtracted;
    expect(pre, "a PDF nobody could read must still get the never-silent ask").toBeTruthy();
    expect(pre?.imageRead?.seen).toBe(false);
    // The frame was never sent to the reader because OUR ceiling excluded it -
    // saying "media download failed" here is a lie in the traveller's panel.
    expect(pre?.imageRead?.failure).not.toBe("network");
    expect(pre?.imageRead?.retryable).toBe(false);
    const note = events.find((e) => e.kind === "media-unreadable");
    expect(note?.detail, "the breadcrumb called a PDF a Photo").not.toMatch(/^Photo/);
  }, 30_000);

  it("a round video note that cannot be watched gets the video ask", async () => {
    media = { mime: "video/webm", base64: "AAAA" };
    await processEvolutionWebhook(frame("MSG-PTV-1", {
      ptvMessage: { mimetype: "video/webm" },
    }));
    expect(turns.length).toBe(1);
    expect(turns[0].text).toBe("[video note]");
    const pre = turns[0].preExtracted;
    expect(pre, "an unwatchable video note must still get the never-silent ask").toBeTruthy();
    expect(String(pre?.clarifyMessage ?? "")).toMatch(/video/i);
  }, 30_000);
});
