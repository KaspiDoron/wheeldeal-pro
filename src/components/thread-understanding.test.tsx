import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { I18N_CATALOG } from "@/lib/i18n-catalog";
import { readingHeadline } from "@/lib/media/reading";

// THE CONVERSATION PAGE SHOWS WHAT THE AI UNDERSTOOD - and until now it showed
// that for photos only. Per-message understanding already existed
// (AgenticSummary under every inbound image); five specific things were
// missing, and every one of them was data the app had already stored.

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\/.*$/gm, "");

describe("EXECUTED: the failure headlines are back in the catalogue", () => {
  // Three strings were REPLACED in readingHeadline (a collapsed row may not
  // promise a retry that already finished inside the turn) and i18n-extras kept
  // the superseded wording. So the catalogue held three strings nothing renders
  // while the three that DO render were absent - and a non-English traveller
  // got raw English at exactly the moment a reading failed, which is the moment
  // the honest taxonomy exists for.
  const reading = (outcome: string) =>
    ({
      outcome,
      prices: [],
      vehicles: [],
      conditions: [],
      confidence: "low",
    }) as never;

  it("every headline readingHeadline can return is translatable", () => {
    for (const outcome of [
      "unavailable",
      "parse-failed",
      "truncated",
      "sanity-nulled",
      "empty",
    ]) {
      const line = readingHeadline(reading(outcome));
      expect(I18N_CATALOG, `${outcome} -> "${line}"`).toContain(line);
    }
  });

  it("the superseded wording is gone, not merely superseded in code", () => {
    for (const dead of [
      "Too long to read in one go - re-reading",
      "One price here looks wrong - checking",
    ]) {
      expect(I18N_CATALOG).not.toContain(dead);
    }
  });
});

describe("EXECUTED: the new understanding copy is translatable too", () => {
  it("every string the new panels render is in the catalogue", () => {
    for (const s of [
      "What your agent read here",
      "What your agent heard",
      "Forwarded - this may be another shop's price, not theirs",
      "Not the vehicle you asked for",
      "Matches your spec",
      "They have one - no price yet",
      "Price",
      "day",
    ]) {
      expect(I18N_CATALOG).toContain(s);
    }
  });
});

describe("the facts reach the surface that shows them", () => {
  const route = readCode("src/app/api/thread/route.ts");
  const bubble = readCode("src/components/MessageBubble.tsx");

  it("the vendor_replies facts are finally joined to the transcript", () => {
    // Stored per reply since the schema shipped; nothing ever read them back.
    expect(route).toMatch(/"vendor_replies"/);
    expect(route).toMatch(/select=reply_text,found,price_per_day,matches_spec,confidence/);
    expect(route).toMatch(/replyRead:/);
  });

  it("a photo's OWN reading is never second-guessed by the text pass", () => {
    expect(route).toMatch(/replyRead: m\.raw\?\.reading\s*\?\s*undefined/);
  });

  it("the voice transcript and the forwarded flag are selected", () => {
    expect(route).toMatch(/transcript: m\.raw\?\.transcript\?\.text/);
    expect(route).toMatch(/forwarded: m\.raw\?\.forwarded/);
  });

  it("the bubble renders all three", () => {
    expect(bubble).toMatch(/m\.replyRead && <TextRead read=\{m\.replyRead\}/);
    expect(bubble).toMatch(/\{m\.transcript && \(/);
    expect(bubble).toMatch(/\{m\.forwarded && \(/);
  });

  it("a panel with nothing in it is not rendered - that would be a claim", () => {
    expect(bubble).toMatch(
      /if \(!price && read\.found !== true && read\.matchesSpec == null\) return null;/
    );
  });
});

describe("shop-controlled strings cannot break the layout, in either direction", () => {
  const bubble = read("src/components/MessageBubble.tsx");
  const summary = read("src/components/AgenticSummary.tsx");

  it("the raw reading of a price board wraps - the longest string in the app", () => {
    const block = summary.slice(summary.indexOf("Text lifted from the image"));
    expect(block.slice(0, 700)).toMatch(/break-words/);
  });

  it("the product card, the contact name and the quote block wrap", () => {
    for (const anchor of ["m.product.title", "m.product.description", "m.quoted"]) {
      // The LAST occurrence is the render site; earlier ones are the comment
      // and the derived-value block above it.
      const i = bubble.lastIndexOf(anchor);
      expect(i, anchor).toBeGreaterThan(-1);
      expect(bubble.slice(Math.max(0, i - 300), i + 60), anchor).toMatch(/break-words/);
    }
  });

  it("the bubble tail uses LOGICAL corners, so RTL points at the speaker", () => {
    // The row that positions the bubble is already logical (`justify-end`
    // flips under dir="rtl"); a physical rounded-br/bl does not, so every
    // Arabic and Hebrew bubble grew its tail on the wrong side.
    expect(bubble).toMatch(/rounded-ee-md/);
    expect(bubble).toMatch(/rounded-es-md/);
    expect(bubble).not.toMatch(/rounded-br-md|rounded-bl-md/);
  });

  it("the summary chevron mirrors with the document direction", () => {
    expect(summary).toMatch(/rtl:-scale-x-100/);
  });
});
