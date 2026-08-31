import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  budgetFrames,
  MAX_FRAME_B64_CHARS,
  MAX_REQUEST_B64_CHARS,
  MAX_FRAMES_PER_CALL,
} from "../media/frame-budget";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// OWNER REPORT 4, ITEM 4: "a lot of images (5+) together, and every other
// media type." The worker pipeline that coalesced bursts is deployed nowhere;
// this suite covers the coalescer that runs on the runtime that actually
// serves travellers, and the honesty rails around it.

// ---- the DB-backed burst protocol, executed ------------------------------

const db = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  queries: 0,
}));
vi.mock("server-only", () => ({}));
vi.mock("../runtime-config", () => ({
  sbSelect: vi.fn(async () => {
    db.queries++;
    return db.rows;
  }),
}));

import { assembleImageBurst, newerSibling } from "./image-burst";

const frame = (id: number, msgId: string) => ({
  id,
  wa_message_id: msgId,
  received_at: new Date().toISOString(),
  type: "image",
  raw: { media: { key: { id: msgId }, kind: "image", mime: "image/jpeg" } },
});

const bytes = (tag: string) => ({ mime: "image/jpeg", base64: `b64-${tag}` });

beforeEach(() => {
  db.rows = [];
  db.queries = 0;
});

describe("assembleImageBurst - the newest frame runs ONE turn for the album", () => {
  it("a LONE photo proceeds immediately: no defer, one extra read", async () => {
    db.rows = [frame(10, "m-10")];
    const sleep = vi.fn(async () => {});
    const v = await assembleImageBurst({
      email: "u@x.com",
      fromDigits: "66111",
      ownMsgId: "m-10",
      fetchOwn: async () => bytes("own"),
      fetchByKey: async () => null,
      sleep,
    });
    expect(v.standDown).toBe(false);
    if (!v.standDown) {
      expect(v.frames).toEqual([{ ...bytes("own"), waMessageId: "m-10" }]);
      expect(v.burstSize).toBe(1);
    }
    // The whole fast-path contract: a single photo never waits the album out.
    expect(sleep).not.toHaveBeenCalled();
    expect(db.queries).toBe(2); // initial + one re-check
  });

  it("an older frame of a burst STANDS DOWN to the newest sibling", async () => {
    db.rows = [frame(10, "m-10"), frame(11, "m-11"), frame(12, "m-12")];
    const v = await assembleImageBurst({
      email: "u@x.com",
      fromDigits: "66111",
      ownMsgId: "m-10",
      fetchOwn: async () => bytes("own"),
      fetchByKey: async () => null,
    });
    expect(v).toEqual({ standDown: true, leaderId: "m-12" });
  });

  it("the newest frame assembles EVERY sibling's bytes, arrival order", async () => {
    db.rows = [frame(10, "m-10"), frame(11, "m-11"), frame(12, "m-12")];
    const fetched: string[] = [];
    const v = await assembleImageBurst({
      email: "u@x.com",
      fromDigits: "66111",
      ownMsgId: "m-12",
      fetchOwn: async () => bytes("own"),
      fetchByKey: async (key) => {
        const id = (key as { id: string }).id;
        fetched.push(id);
        return bytes(id);
      },
      sleep: async () => {},
    });
    expect(v.standDown).toBe(false);
    if (!v.standDown) {
      expect(v.frames.map((f) => f.waMessageId)).toEqual(["m-10", "m-11", "m-12"]);
      expect(v.burstSize).toBe(3);
      expect(v.fetchFailures).toBe(0);
    }
    expect(fetched).toEqual(["m-10", "m-11"]); // own bytes come from fetchOwn
  });

  it("a multi-frame burst defers ONCE and hands over to a straggler", async () => {
    db.rows = [frame(10, "m-10"), frame(11, "m-11")];
    const sleep = vi.fn(async () => {
      // The straggler lands during the deferral window.
      db.rows = [frame(10, "m-10"), frame(11, "m-11"), frame(12, "m-12")];
    });
    const v = await assembleImageBurst({
      email: "u@x.com",
      fromDigits: "66111",
      ownMsgId: "m-11",
      fetchOwn: async () => bytes("own"),
      fetchByKey: async () => bytes("sib"),
      sleep,
    });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(v).toEqual({ standDown: true, leaderId: "m-12" });
  });

  it("a failed sibling download is COUNTED, never silently absent", async () => {
    db.rows = [frame(10, "m-10"), frame(11, "m-11")];
    const v = await assembleImageBurst({
      email: "u@x.com",
      fromDigits: "66111",
      ownMsgId: "m-11",
      fetchOwn: async () => bytes("own"),
      fetchByKey: async () => null,
      sleep: async () => {},
    });
    expect(v.standDown).toBe(false);
    if (!v.standDown) {
      expect(v.fetchFailures).toBe(1);
      expect(v.frames.map((f) => f.waMessageId)).toEqual(["m-11"]);
    }
  });

  it("newerSibling never stands a frame down when its own row is not visible", () => {
    // A replication blip that hides our own row must not delete the turn.
    expect(newerSibling([{ id: 5, wa_message_id: "other" }], "mine")).toBeNull();
  });
});

// ---- the vision request budget, executed ---------------------------------

describe("budgetFrames - what fits in one vision call, honestly", () => {
  const f = (chars: number) => ({ mime: "image/jpeg", base64: "x".repeat(chars) });

  it("keeps order and everything that fits", () => {
    const b = budgetFrames([f(100), f(200), f(300)]);
    expect(b.kept.map((k) => k.base64.length)).toEqual([100, 200, 300]);
    expect(b.dropped).toEqual([]);
  });

  it("an oversized frame is dropped ALONE, with its reason", () => {
    const b = budgetFrames([f(100), f(MAX_FRAME_B64_CHARS + 1), f(200)]);
    expect(b.kept.map((k) => k.base64.length)).toEqual([100, 200]);
    expect(b.dropped).toEqual([
      { index: 1, reason: "frame-too-large", chars: MAX_FRAME_B64_CHARS + 1 },
    ]);
  });

  it("the 9th frame is dropped as over-cap - 8 matches the worker coalescer", () => {
    const b = budgetFrames(Array.from({ length: 10 }, () => f(10)));
    expect(MAX_FRAMES_PER_CALL).toBe(8);
    expect(b.kept.length).toBe(8);
    expect(b.dropped.map((d) => d.reason)).toEqual(["over-frame-cap", "over-frame-cap"]);
  });

  it("the request budget stops admitting frames once spent", () => {
    // Five frames at the per-frame ceiling: four fit (16.7M chars), the fifth
    // would cross the 18M request budget and is dropped with its reason.
    const b = budgetFrames(Array.from({ length: 5 }, () => f(MAX_FRAME_B64_CHARS)));
    expect(b.kept.length).toBe(4);
    expect(b.dropped).toEqual([
      { index: 4, reason: "request-budget", chars: MAX_FRAME_B64_CHARS },
    ]);
  });

  it("the caps sit inside the provider's real ~20MB inline ceiling", () => {
    expect(MAX_REQUEST_B64_CHARS).toBeLessThan(20 * 1024 * 1024);
    expect(MAX_FRAME_B64_CHARS).toBeLessThan(MAX_REQUEST_B64_CHARS);
  });
});

// ---- the wiring, pinned ---------------------------------------------------

describe("the inline ingest path is the one that coalesces", () => {
  const ingest = readCode("src/lib/wa/ingest.ts");

  it("image turns go through assembleImageBurst and budgetFrames", () => {
    expect(ingest).toMatch(/assembleImageBurst\(\{/);
    expect(ingest).toMatch(/budgetFrames\(verdict\.frames\)/);
    // A coalesced frame leaves a trace - never mistaken for a dropped one.
    expect(ingest).toMatch(/"image-coalesced"/);
    // A budget exclusion leaves a trace too.
    expect(ingest).toMatch(/"image-batch-truncated"/);
  });

  it("every fetched frame gets an audit copy before WhatsApp expires it", () => {
    expect(ingest).toMatch(/storeMediaAudit\(f\.waMessageId, f\)/);
    const audit = readCode("src/lib/media/audit.ts");
    expect(audit).toMatch(/wa-media\/\$\{waMessageId\}\.\$\{ext\}/);
    // ...and the serving route knows the new extensions.
    expect(readCode("src/app/api/wa/media/route.ts")).toMatch(/"pdf", "mp4", "ogg"/);
  });

  it("VIDEO: mp4/3gpp ride the Gemini rung; anything else gets an honest ask", () => {
    expect(ingest).toMatch(/\^video\\\/\(mp4\|3gpp\)/);
    expect(ingest).toMatch(/videoClarifyExtraction\(\)/);
    // The media key is stamped for video so the bytes stay redeemable.
    expect(ingest).toMatch(/hasVideo \? "video" : "document"/);
    const loop = readCode("src/lib/agent-loop.ts");
    expect(loop).toMatch(/export function videoClarifyExtraction/);
    expect(loop).toMatch(/could not watch the video/);
  });

  it("PDF rate cards ride the vision rung instead of dying as 'unreadable'", () => {
    // Read RAW: the widened docIsImage line holds a regex literal whose `//`
    // the comment-stripping reader would truncate.
    const raw = readFileSync(join(process.cwd(), "src/lib/wa/ingest.ts"), "utf8");
    expect(raw).toMatch(/application\\\/pdf\\b/);
  });

  it("VOICE: captioned notes transcribe too, and the language hint is wired", () => {
    // The `!syntheticText` guard silently discarded the spoken half (usually
    // the actual price) of any voice note sent with a caption.
    expect(ingest).not.toMatch(/hasAudio && email && !syntheticText/);
    expect(ingest).toMatch(/if \(hasAudio && email\)/);
    expect(ingest).toMatch(/localLang,/);
    expect(ingest).toMatch(/threadLanguageMode\(email, from\)/);
  });

  it("a shared contact becomes a durable suggestion event, never an auto-thread", () => {
    expect(ingest).toMatch(/"contact-suggested"/);
    expect(ingest).not.toMatch(/contact-suggested[\s\S]{0,400}sendFromUser/);
  });
});

describe("whisper failures are classified before falling to Gemini", () => {
  const t = readCode("src/lib/graph/transcribe.ts");

  it("retryable failures (429/timeout/5xx) earn ONE Groq retry", () => {
    expect(t).toMatch(/RETRYABLE_VISION\.has\(visionFailureFromStatus\(res\.status\)\)/);
    expect(t).toMatch(/RETRYABLE_VISION\.has\(visionFailureFromThrown\(e\)\)/);
    const attempts = t.match(/await attemptGroq\(\)/g) ?? [];
    expect(attempts.length).toBe(2);
  });

  it("whisper-large-v3 stays the accent-strong first rung", () => {
    expect(t).toMatch(/whisper-large-v3/);
    expect(t).not.toMatch(/whisper-large-v3-turbo/);
  });
});

describe("a board photographed in thread A is leverage in thread B", () => {
  it("sessionTable folds stamped MediaReading prices into priceless rows", () => {
    const engine = readCode("src/lib/graph/engine.ts");
    expect(engine).toMatch(/raw->reading=not\.is\.null/);
    // A typed quote beats a board we read - only priceless rows are filled.
    expect(engine).toMatch(/typeof r\.pricePerDay !== "number" && numberByVendor\.has\(r\.vendorId\)/);
    // Tolerant number matching, like every cross-spelling comparison.
    expect(engine).toMatch(/sameNumber\(m\.from_number, digits\)/);
  });

  it("...and a CROSSED-OUT row never becomes a rival price", () => {
    // The selection itself is executed in src/lib/media/reading-quotes.test.ts
    // ("a crossed-out row is LISTED, and is never the quote"); what can only be
    // pinned here is that this call site uses it. `prices[0]` was a struck-out
    // row whenever the board's cheapest model was the one they had stopped
    // renting - and this table is quoted AT other shops as "another shop does
    // 150", so one strike moved every rival negotiation's floor.
    const engine = readCode("src/lib/graph/engine.ts");
    // W12f: THIS TEST PINNED THE DEFECT IN PLACE. It asserted the RIVAL path
    // used `cheapestQuotable`, which filters ONLY crossed-out rows - while the
    // three assertions below it correctly demanded the CARD path pick through
    // cc and duration. So the cheapest LONG-STAY tier, a column a short
    // traveller cannot buy, became this shop's cross-thread rival price, and
    // the cite-the-rival rail then obliged the agent to name it at another
    // shop. pickBoardPrice's own docstring names that exact victim. Both paths
    // pick the same cell now.
    expect(engine).toMatch(/const cheapest = pickBoardPrice\(/);
    expect(engine).toMatch(/spec\?\.engineSizeCc \?\? 0/);
    expect(engine).toMatch(/spec\?\.durationDays \?\? 0/);
    expect(engine).not.toMatch(/cheapestQuotable/);
    expect(engine).not.toMatch(/reading\?\.prices\?\.\[0\]/);
    // ...and the card-facing route picks through the same shared arithmetic -
    // now via the ONE effective-price resolver (owner report 6 D2), which
    // still hands the board rows plus cc AND duration to pickBoardPrice.
    const replies = readCode("src/app/api/replies/route.ts");
    expect(replies).toMatch(/effectivePriceFor\(\{/);
    expect(replies).toMatch(/boardPrices: readingPricesByVendor\.get\(r\.vendor_id\)/);
    expect(replies).toMatch(/engineSizeCc: specCc/);
    expect(replies).toMatch(/durationDays: specDays/);
    const effective = readCode("src/lib/effective-price.ts");
    expect(effective).toMatch(/pickBoardPrice\(/);
    expect(effective).toMatch(/args\.engineSizeCc \?\? 0/);
    expect(effective).toMatch(/args\.durationDays \?\? 0/);
  });
});
