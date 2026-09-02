import { describe, it, expect } from "vitest";
import {
  waMessageText,
  waMediaKind,
  waUnwrap,
  waPlaceholderOnly,
  waForwarded,
} from "./message-text";
import { onlyForwardedContent, isMediaPlaceholder } from "./coalesce";

// A MESSAGE THAT ARRIVED IS NEVER NOTHING - this file's own stated rule.
//
// Seven frame shapes broke it. Each one produced either a turn with no content
// (which burns a reply, because `wa/coalesce` strips a bare bracket label) or
// no turn at all, so a shop that had just answered looked silent.

const msg = (m: Record<string, unknown>) => ({ message: m });

describe("EXECUTED: frames that produced no turn at all", () => {
  it("a round video note is a video", () => {
    // `ptvMessage` matched nothing: not the text branches, not waMediaKind, and
    // not `hasVideoMessage` - so no media job ran either.
    expect(waMediaKind(msg({ ptvMessage: { mimetype: "video/mp4" } }))).toBe("ptv");
    expect(waMessageText(msg({ ptvMessage: { mimetype: "video/mp4" } }))).toBe("[video note]");
  });

  it("a live location is the most time-critical pin a shop can send", () => {
    const m = msg({ liveLocationMessage: { degreesLatitude: 8.1, degreesLongitude: 98.9 } });
    expect(waMediaKind(m)).toBe("location");
    expect(waMessageText(m)).toBe("[live location]");
  });

  it("an album is a turn", () => {
    expect(waMediaKind(msg({ albumMessage: { expectedImageCount: 3 } }))).toBe("album");
  });

  it("a message composed on the shop's laptop is still the shop talking", () => {
    // `deviceSentMessage` was not in the envelope list, so every detector saw
    // an unknown wrapper and the turn was read as empty.
    const wrapped = msg({
      deviceSentMessage: { message: { conversation: "300 baht per day" } },
    });
    expect(waUnwrap(wrapped).conversation).toBe("300 baht per day");
    expect(waMessageText(wrapped)).toBe("300 baht per day");
  });
});

describe("EXECUTED: frames that were labelled but never decoded", () => {
  it("a poll is a price question in disguise, and V2/V3 are what clients send", () => {
    const poll = {
      name: "Which do you want?",
      options: [{ optionName: "125cc - 300" }, { optionName: "150cc - 400" }],
    };
    for (const key of ["pollCreationMessage", "pollCreationMessageV2", "pollCreationMessageV3"]) {
      const m = msg({ [key]: poll });
      expect(waMediaKind(m)).toBe("poll");
      expect(waMessageText(m)).toBe("[poll] Which do you want?: 125cc - 300 / 150cc - 400");
    }
  });

  it("only the UNVERSIONED poll key used to match - V3 was an unknown frame", () => {
    // Non-vacuous: the decoded text carries the prices, so the extraction pass
    // can actually see them.
    const text = waMessageText(
      msg({ pollCreationMessageV3: { name: "Rate", options: [{ optionName: "300/day" }] } })
    );
    expect(text).toContain("300/day");
    expect(isMediaPlaceholder(text)).toBe(false);
  });

  it("a shop tapping its own Business-flow button is answering us", () => {
    const m = msg({
      interactiveResponseMessage: {
        nativeFlowResponseMessage: {
          name: "quick_reply",
          paramsJson: JSON.stringify({ id: "opt1", description: "125cc - 300 per day" }),
        },
      },
    });
    expect(waMediaKind(m)).toBe("interactive");
    expect(waMessageText(m)).toContain("125cc - 300 per day");
  });

  it("a malformed flow payload degrades to the label, never to a throw", () => {
    const m = msg({
      interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: "{not json" } },
    });
    expect(() => waMessageText(m)).not.toThrow();
    expect(waMediaKind(m)).toBe("interactive");
  });
});

describe("EXECUTED: 'no real text' is not the same as 'empty string'", () => {
  it("every bracket label this reader emits is recognised as a label", () => {
    for (const t of [
      "[photo]", "[video]", "[video note]", "[voice note]", "[document]",
      "[sticker]", "[location]", "[live location]", "[album]", "[contact]", "[poll]",
    ]) {
      expect(waPlaceholderOnly(t)).toBe(true);
    }
  });
  it("real words, and a DECODED label, are not placeholders", () => {
    expect(waPlaceholderOnly("300 baht per day")).toBe(false);
    expect(waPlaceholderOnly("[document: rate-card.pdf]")).toBe(false);
    expect(waPlaceholderOnly("[poll] Rate: 300/day")).toBe(false);
    expect(waPlaceholderOnly("")).toBe(false);
  });
  it("THIS is why three enrichments were unreachable", () => {
    // ingest guarded describeShopLocation / the contact card / the document
    // filename on `!syntheticText`, and waMessageText returns "[location]" /
    // "[contact]" / "[document]" for exactly those frames - it never returns
    // empty for a frame it recognises. So the guard was false by construction.
    expect(waMessageText(msg({ locationMessage: { degreesLatitude: 1, degreesLongitude: 2 } }))).toBe("[location]");
    expect(waMessageText(msg({ contactMessage: { displayName: "Krabi Bikes" } }))).toBe("[contact]");
    expect(waMessageText(msg({ documentMessage: { fileName: "rates.pdf" } }))).toBe("[document]");
    for (const t of ["[location]", "[contact]", "[document]"]) {
      expect(t).toBeTruthy(); // the old guard's condition
      expect(waPlaceholderOnly(t)).toBe(true); // the new one
    }
  });
});

describe("EXECUTED: a forwarded price board is somebody else's price", () => {
  it("reads isForwarded and forwardingScore, which nothing in this repo did", () => {
    expect(waForwarded(msg({ imageMessage: { contextInfo: { isForwarded: true } } }))).toEqual({
      forwarded: true,
      score: 0,
    });
    expect(waForwarded(msg({ conversation: "hi", extendedTextMessage: { contextInfo: { forwardingScore: 7 } } })).score).toBe(7);
    expect(waForwarded(msg({ conversation: "hi" })).forwarded).toBe(false);
  });

  it("it peels the envelope first - a forwarded view-once board still counts", () => {
    const m = msg({
      viewOnceMessageV2: { message: { imageMessage: { contextInfo: { isForwarded: true } } } },
    });
    expect(waForwarded(m).forwarded).toBe(true);
  });
});

describe("EXECUTED: onlyForwardedContent - conservative on purpose", () => {
  const at = (n: number) => new Date(1700000000000 + n * 1000).toISOString();
  const out = (n: number) => ({ direction: "outbound" as const, body: "hi", received_at: at(n) });
  const inb = (n: number, body: string | null, extra: { forwarded?: boolean; hasMedia?: boolean } = {}) => ({
    direction: "inbound" as const,
    body,
    received_at: at(n),
    ...extra,
  });

  it("a bare 'here you go' plus a forwarded board attributes NOTHING", () => {
    const thread = [
      out(1),
      inb(2, "here you go"),
      inb(3, "[photo]", { forwarded: true, hasMedia: true }),
    ];
    expect(onlyForwardedContent(thread, at(1))).toBe(true);
  });

  it("...but a shop that STATES a price keeps its offer, forwarded board or not", () => {
    const thread = [
      out(1),
      inb(2, "our rate is 300"),
      inb(3, "[photo]", { forwarded: true, hasMedia: true }),
    ];
    expect(onlyForwardedContent(thread, at(1))).toBe(false);
  });

  it("...and the shop's OWN photo is never treated as forwarded content", () => {
    const thread = [
      out(1),
      inb(2, "[photo]", { hasMedia: true }),
      inb(3, "[photo]", { forwarded: true, hasMedia: true }),
    ];
    expect(onlyForwardedContent(thread, at(1))).toBe(false);
  });

  it("nothing forwarded at all -> false, so today's behaviour is unchanged", () => {
    expect(onlyForwardedContent([out(1), inb(2, "300 per day")], at(1))).toBe(false);
    expect(onlyForwardedContent([], at(1))).toBe(false);
  });

  it("a Thai-numeral price the shop typed itself still counts as its own", () => {
    const thread = [
      out(1),
      inb(2, "\u0e53\u0e50\u0e50 \u0e1a\u0e32\u0e17"),
      inb(3, "[photo]", { forwarded: true, hasMedia: true }),
    ];
    expect(onlyForwardedContent(thread, at(1))).toBe(false);
  });

  it("frames from BEFORE our last outbound are not in the window", () => {
    const thread = [
      inb(1, "[photo]", { forwarded: true, hasMedia: true }),
      out(5),
      inb(6, "yes"),
    ];
    expect(onlyForwardedContent(thread, at(5))).toBe(false);
  });
});
