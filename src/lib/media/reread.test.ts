import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MediaReading } from "./reading";
import {
  REREADABLE,
  REREAD_COOLDOWN_MS,
  REREAD_MAX_AGE_MS,
  REREAD_MAX_ATTEMPTS,
  attemptStarted,
  recovered,
  rereadDue,
  rereadSkipReason,
  withAttempt,
} from "./reread";

// THE OCR ASK, ANSWERED WITHOUT AN IMAGE LIBRARY.
//
// Only three rungs accepted images and only ONE accepted PDFs, so with no
// Gemini key - or during a Gemini 429 - a price board went unread and stayed
// unread for ever. This repo bans sharp/jimp/canvas/tesseract.js on memory
// grounds, so the fix is a fourth rung (ai.ts) plus this: retry later, once the
// per-minute budgets have reset.

const NOW = Date.parse("2026-09-02T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const reading = (r: Partial<MediaReading> = {}): MediaReading => ({
  outcome: "unavailable",
  prices: [],
  vehicles: [],
  conditions: [],
  confidence: "low",
  ...r,
});

const cand = (r: Partial<MediaReading> = {}, over: Record<string, unknown> = {}) => ({
  reading: reading(r),
  receivedAt: ago(60_000),
  waMessageId: "wamid.1",
  ...over,
});

describe("EXECUTED: which failures are about the minute, not the photo", () => {
  it("retries the three that are about the ATTEMPT", () => {
    for (const outcome of ["unavailable", "truncated", "parse-failed"] as const) {
      expect(REREADABLE.has(outcome)).toBe(true);
      expect(rereadDue(cand({ outcome }), NOW)).toBe(true);
    }
  });

  it("never retries a number we read and REFUSED - it comes back the same", () => {
    expect(REREADABLE.has("sanity-nulled")).toBe(false);
    expect(rereadSkipReason(cand({ outcome: "sanity-nulled" }), NOW)).toBe("not-retryable");
  });

  it("never retries a photo that genuinely had no price on it", () => {
    // Asking a fourth provider to confirm an empty photo spends money to learn
    // nothing.
    expect(REREADABLE.has("empty")).toBe(false);
    expect(rereadSkipReason(cand({ outcome: "empty" }), NOW)).toBe("not-retryable");
  });

  it("never retries a reading that already worked", () => {
    expect(rereadSkipReason(cand({ outcome: "read" }), NOW)).toBe("not-retryable");
  });
});

describe("EXECUTED: the bounds, which are what keep vision spend sane", () => {
  it("stops after REREAD_MAX_ATTEMPTS", () => {
    expect(
      rereadSkipReason(
        cand({ reread: { attempts: REREAD_MAX_ATTEMPTS, lastAt: ago(REREAD_COOLDOWN_MS * 3) } }),
        NOW
      )
    ).toBe("attempts-spent");
    expect(
      rereadDue(
        cand({ reread: { attempts: REREAD_MAX_ATTEMPTS - 1, lastAt: ago(REREAD_COOLDOWN_MS * 3) } }),
        NOW
      )
    ).toBe(true);
  });

  it("waits out the cooldown - retrying in the same exhausted minute is pointless", () => {
    expect(
      rereadSkipReason(cand({ reread: { attempts: 1, lastAt: ago(REREAD_COOLDOWN_MS - 1000) } }), NOW)
    ).toBe("cooling-down");
    expect(
      rereadDue(cand({ reread: { attempts: 1, lastAt: ago(REREAD_COOLDOWN_MS + 1000) } }), NOW)
    ).toBe(true);
  });

  it("gives up on a board the negotiation has moved past", () => {
    expect(rereadSkipReason(cand({}, { receivedAt: ago(REREAD_MAX_AGE_MS + 60_000) }), NOW)).toBe("too-old");
  });

  it("an undatable row is bounded rather than retried for ever", () => {
    expect(rereadSkipReason(cand({}, { receivedAt: null }), NOW)).toBe("too-old");
    expect(rereadSkipReason(cand({}, { receivedAt: "not a date" }), NOW)).toBe("too-old");
  });

  it("no archived bytes to fetch without a message id", () => {
    expect(rereadSkipReason(cand({}, { waMessageId: null }), NOW)).toBe("no-message-id");
  });

  it("a burst FOLLOWER is never retried - it carries the leader's reading", () => {
    // Retrying it would re-read a photo the leader owns and stamp a second,
    // competing answer onto the same album.
    expect(rereadSkipReason(cand({ fromBurstLeader: "wamid.leader" }), NOW)).toBe("burst-follower");
  });

  it("no reading at all is not a candidate", () => {
    expect(rereadSkipReason({ reading: null, receivedAt: ago(1), waMessageId: "x" }, NOW)).toBe("no-reading");
  });
});

describe("EXECUTED: the try is burned BEFORE the attempt runs", () => {
  it("attemptStarted increments and stamps, so a crash still costs a try", () => {
    const s1 = attemptStarted(undefined, ago(0));
    expect(s1.attempts).toBe(1);
    expect(s1.lastAt).toBe(ago(0));
    const s2 = attemptStarted(s1, ago(0));
    expect(s2.attempts).toBe(2);
  });

  it("the last attempt marks itself exhausted - the counter the OCR question needs", () => {
    let s = attemptStarted(undefined, ago(0));
    for (let i = 1; i < REREAD_MAX_ATTEMPTS; i++) s = attemptStarted(s, ago(0));
    expect(s.exhausted).toBe(true);
  });

  it("it carries the RFQ and text forward, so the sweep needs no thread context", () => {
    const s = attemptStarted({ attempts: 0, lastAt: ago(0), rfq: { durationDays: 4 }, text: "300?" }, ago(0));
    expect(s.rfq).toEqual({ durationDays: 4 });
    expect(s.text).toBe("300?");
  });

  it("a failed attempt keeps the ORIGINAL failure verbatim", () => {
    // A retry that failed does not change WHAT went wrong the first time, and
    // overwriting the outcome would erase the one fact the panel is telling the
    // traveller.
    const r = reading({ outcome: "truncated", unavailableReason: "ceiling" });
    const after = withAttempt(r, attemptStarted(undefined, ago(0)));
    expect(after.outcome).toBe("truncated");
    expect(after.unavailableReason).toBe("ceiling");
    expect(after.reread?.attempts).toBe(1);
  });
});

describe("EXECUTED: a retry that failed again is not a recovery", () => {
  it("only a non-retryable outcome counts as recovered", () => {
    expect(recovered(reading({ outcome: "read" }))).toBe(true);
    expect(recovered(reading({ outcome: "empty" }))).toBe(true); // the photo answered
    expect(recovered(reading({ outcome: "unavailable" }))).toBe(false);
    expect(recovered(reading({ outcome: "truncated" }))).toBe(false);
    expect(recovered(null)).toBe(false);
  });
});

// ---- the wiring, which a pure policy cannot prove on its own ---------------
const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("the sweep is armed, driven and bounded", () => {
  it("agent-loop arms the retry with the RFQ and the text the read used", () => {
    const loop = readCode("src/lib/agent-loop.ts");
    expect(loop).toMatch(/REREADABLE\.has\(mediaReading\.outcome\)/);
    expect(loop).toMatch(/rfq,/);
    expect(loop).toMatch(/text: \(extractText \?\? text \?\? ""\)\.slice\(0, 1200\)/);
    // A burst follower must not arm its own retry.
    expect(loop).toMatch(/!mediaReading\.fromBurstLeader/);
  });

  it("the cron drives it, on the route that already fires every minute", () => {
    const ping = readCode("src/app/api/wa/ping/route.ts");
    expect(ping).toMatch(/sweepMediaRereads/);
    expect(ping).toMatch(/import\("@\/lib\/media\/reread-sweep"\)/);
  });

  it("bytes come from the AUDIT copy, never from a second Evolution download", () => {
    // WhatsApp expires media, storeMediaAudit keeps a redeemable copy for
    // exactly this, and re-downloading would spend a request on the linked
    // number for no gain.
    const sweep = readCode("src/lib/media/reread-sweep.ts");
    expect(sweep).toMatch(/storage\/v1\/object\/wa-media/);
    expect(sweep).not.toMatch(/fetchMediaBase64/);
  });

  it("a fresher reading stamped by the live path is never overwritten", () => {
    const sweep = readCode("src/lib/media/reread-sweep.ts");
    expect(sweep).toMatch(/if \(freshReading && recovered\(freshReading\)\) continue;/);
  });

  it("the fourth vision rung exists and runs LAST", () => {
    const ai = readCode("src/lib/ai.ts");
    expect(ai).toMatch(/openaiVisionAttempt\(/);
    expect(ai).toMatch(/provider: "openai",/);
    // After the paid Anthropic rescue - it is the rescue's rescue.
    expect(ai.indexOf('provider: "openai",')).toBeGreaterThan(ai.indexOf('provider: "anthropic",'));
  });

  it("no image library was added - the ban this answers is still intact", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    for (const banned of ["sharp", "jimp", "canvas", "@napi-rs/canvas", "tesseract.js"]) {
      expect(deps[banned]).toBeUndefined();
    }
  });
});
