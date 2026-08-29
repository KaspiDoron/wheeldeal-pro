import { describe, it, expect, vi } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

import { offerBadge, OFFER_BADGES } from "./offer-badges";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// FOUR WORDS THE TRAVELLER DID NOT AGREE TO LEARN.
//
// VERIFIED, SHOP QUOTE, UNVERIFIED, DIFFERENT VEHICLE are all terms of art this
// app invented. They carry real distinctions - is this even the vehicle I asked
// for, can I lock this number - and none of it is guessable from the word.

describe("the badge and its explanation cannot drift apart", () => {
  it("every stance has a label AND a plain-language sentence", () => {
    for (const [key, b] of Object.entries(OFFER_BADGES)) {
      expect(b.id, key).toBe(key);
      expect(b.label.length, key).toBeGreaterThan(3);
      expect(b.what.length, key).toBeGreaterThan(40);
    }
  });

  it("REPRODUCTION: the two ALARMING-sounding badges say nothing is wrong", () => {
    // A traveller reading "SHOP QUOTE" or "UNVERIFIED" as a warning hesitates
    // over a good deal. Both are normal states.
    expect(OFFER_BADGES.quote.what).toMatch(/real price a real shop gave/i);
    expect(OFFER_BADGES.quote.next).toMatch(/nothing to do/i);
    expect(OFFER_BADGES.confirming.what).toMatch(/real and lockable/i);
    expect(OFFER_BADGES.confirming.next).toMatch(/resolves itself/i);
  });

  it("...and the one that IS a warning says what is being done about it", () => {
    expect(OFFER_BADGES.mismatch.what).toMatch(/DIFFERENT vehicle/);
    expect(OFFER_BADGES.mismatch.what).toMatch(/not counted as your best deal/i);
    expect(OFFER_BADGES.mismatch.next).toMatch(/asking the shop/i);
  });
});

describe("precedence matches what the card actually shows", () => {
  it("a vehicle mismatch outranks a written confirmation", () => {
    // A price for the wrong bike is not a better deal however well confirmed.
    expect(offerBadge({ stance: "mismatch", verified: true }).id).toBe("mismatch");
  });

  it("an in-flight confirmation outranks the plain quote", () => {
    expect(offerBadge({ stance: "confirming", verified: false }).id).toBe("confirming");
  });

  it("verified wins when nothing is in question", () => {
    expect(offerBadge({ stance: "ok", verified: true }).id).toBe("verified");
  });

  it("and a plain shop price is the calm default, never a scary one", () => {
    expect(offerBadge({}).id).toBe("quote");
    expect(offerBadge({ stance: null, verified: null }).id).toBe("quote");
  });
});

describe("the card renders from the vocabulary, not from its own strings", () => {
  const card = readCode("src/components/VendorCard.tsx");

  it("one badge element, driven by the shared entry", () => {
    expect(card).toMatch(/const badge = offerBadge\(\{ stance, verified: offer\?\.verified \}\);/);
    expect(card).toMatch(/\{t\(badge\.label\)\}/);
  });

  it("the four hand-written badge branches are gone", () => {
    expect(card).not.toMatch(/\{t\("DIFFERENT VEHICLE"\)\}/);
    expect(card).not.toMatch(/\{t\("SHOP QUOTE"\)\}/);
  });

  it("the jargon has an 'i' that explains it in place", () => {
    expect(card).toMatch(/<InfoTip/);
    expect(card).toMatch(/what=\{t\(badge\.what\)\}/);
    expect(card).toMatch(/drift=\{badge\.next \? t\(badge\.next\) : undefined\}/);
  });
});

describe("the unused-export sweep, done honestly", () => {
  it("budget-cache LOOKS dead from src/ and is not - the workers import it", () => {
    // A sweep that only scans src/ reports this module as unreferenced, and it
    // is genuinely live: services/workers imports recordIntro through
    // @wheeldeal/redis, which re-exports from here. The lesson is the
    // workspace, not the module - a deletion based on the src-only view breaks
    // a build that src alone cannot see. Pinned so the next sweep does not
    // repeat the mistake.
    expect(existsSync(join(process.cwd(), "src/lib/budget-cache.ts"))).toBe(true);
    const reexport = readFileSync(join(process.cwd(), "packages/redis/budgets.ts"), "utf8");
    expect(reexport).toMatch(/from "\.\.\/\.\.\/src\/lib\/budget-cache"/);
    // The live consumer is the OUTREACH worker (seedIntroWindow et al).
    // outbound.worker used to be the example here, but it was fenced off the
    // direct-send path and no longer touches the intro mirror.
    const worker = readFileSync(
      join(process.cwd(), "services/workers/src/outreach.worker.ts"),
      "utf8"
    );
    expect(worker).toMatch(/seedIntroWindow/);
  });

  it("...and the concurrent-campaign lever is enforced on the SUPABASE path", () => {
    // The Redis campaign counter was built for a queue the owner decided
    // against. The lever it was for is now real, in the outbox path that
    // actually runs.
    expect(existsSync(join(process.cwd(), "src/lib/wa/campaigns.ts"))).toBe(true);
    const route = readCode("src/app/api/outreach/route.ts");
    expect(route).toMatch(/campaignVerdict/);
  });
});
