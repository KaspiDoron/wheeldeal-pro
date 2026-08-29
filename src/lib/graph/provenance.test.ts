import { describe, it, expect } from "vitest";
import {
  checkOutboundNumbers,
  groundedDerivations,
  isGroundedNumber,
  verbatimNumerals,
} from "./guardrails";
import {
  USER_MOVE_WINDOW_SEC,
  TURN_WINDOW_SEC,
  turnBucket,
  userMoveSlot,
  threadTurnSlot,
} from "../wa/turn-lock";

// ---------------------------------------------------------------------------
// PROVENANCE. The Thailand field failure, verbatim: the agent messaged a shop
// "Your price 300 is too much" when the shop's greeting had said "Click 125CC
// - 250B". The 300 existed NOWHERE - not in the thread, not in the RFQ, not in
// any benchmark - and the bounds checks could never catch it because the
// extractor had missed the 250, so there was no ceiling to invert against.
// Provenance is the missing question: "where did this number COME FROM?"
// ---------------------------------------------------------------------------

describe("the derivation basis is closed", () => {
  it("a stated total grounds its daily rate, and the reverse", () => {
    const basis = groundedDerivations([1200], 6);
    expect(isGroundedNumber(200, basis)).toBe(true); // 1200 / 6 days
    expect(isGroundedNumber(7200, basis)).toBe(true); // 1200 * 6 days
    expect(isGroundedNumber(1200, basis)).toBe(true); // the number itself
  });

  it("honest human rounding is a derivation, free arithmetic is not", () => {
    const basis = groundedDerivations([183], 6);
    expect(isGroundedNumber(185, basis)).toBe(true); // round to 5
    expect(isGroundedNumber(180, basis)).toBe(true); // round to 10
    // 183+183, 183*2, half of 183... none of these are readings of the thread.
    expect(isGroundedNumber(366, basis)).toBe(false);
    expect(isGroundedNumber(91, basis)).toBe(false);
  });

  it("without a duration, totals stay totals", () => {
    expect(isGroundedNumber(200, groundedDerivations([1200], undefined))).toBe(false);
  });
});

describe("checkOutboundNumbers proves provenance", () => {
  it("THE FIELD CASE: an invented shop price is rejected even with no ceiling", () => {
    // The extractor missed the greeting's 250B, so no ceiling existed and the
    // bounds checks were blind. The thread state still held the 250 - and 300
    // derives from nothing.
    const check = checkOutboundNumbers({
      text: "Your price 300 is too much for the Click. Can you do 250?",
      grounded: [250],
      durationDays: 6,
      checkAskBounds: false,
    });
    expect(check.ok).toBe(false);
    expect(check.violation).toBe("ungrounded-number");
    expect(check.offending).toBe(300);
  });

  it("DERIVED RATES ARE LEGAL: 1200 for 6 days grounds a 200/day ask", () => {
    const check = checkOutboundNumbers({
      text: "So 1200 for the 6 days - that is 200 a day, right?",
      grounded: [1200],
      durationDays: 6,
      excludeExact: [6],
      checkAskBounds: false,
    });
    expect(check.ok).toBe(true);
  });

  it("the counter the ladder computed is grounded; a rider number is not", () => {
    // grounded carries the ladder target (200) and the quote (250): the ask is
    // fine, but a second invented numeral in the same draft still dies.
    const ok = checkOutboundNumbers({
      text: "Could you do 200 per day? I can book right away",
      grounded: [250, 200],
      durationDays: 6,
      checkAskBounds: false,
    });
    expect(ok.ok).toBe(true);
    // NOTE: not phrased as a rival claim - "another shop said 320" would die
    // earlier, in the fabricated-rival check. This one is a bare invented
    // price, the class only provenance can see.
    const bad = checkOutboundNumbers({
      text: "Could you do 200? I saw it for 320 online",
      grounded: [250, 200],
      durationDays: 6,
      checkAskBounds: false,
    });
    expect(bad.ok).toBe(false);
    expect(bad.violation).toBe("ungrounded-number");
    expect(bad.offending).toBe(320);
  });

  it("FAIL-OPEN: a thread that holds no numbers cannot ground anything", () => {
    // No grounded state supplied -> the provenance check stands down (the
    // bounds checks still run for price moves). Never a false rejection on a
    // brand-new thread.
    expect(
      checkOutboundNumbers({ text: "Can you do 300?", grounded: [], checkAskBounds: false }).ok
    ).toBe(true);
  });

  it("counts and small ordinals are never treated as prices", () => {
    expect(
      checkOutboundNumbers({
        text: "We need 2 helmets and it is for 6 days",
        grounded: [250],
        excludeExact: [6],
        checkAskBounds: false,
      }).ok
    ).toBe(true);
  });
});

describe("the verbatim half of the basis", () => {
  it("a number either party already said is never an invention", () => {
    const basis = verbatimNumerals([
      "Shop: Click 125 is 250 per day, new model 300",
      "Us: could you do 220?",
    ]);
    expect(basis).toContain(250);
    expect(basis).toContain(300);
    expect(basis).toContain(220);
  });

  it("reads with the SAME extractor the check uses - deposits stay exempt on both sides", () => {
    // extractPriceNumbers skips deposit-context figures in a DRAFT, so the
    // basis reader skipping them too keeps the two sides symmetric: a numeral
    // the check would inspect is recognisable here whenever the thread holds it.
    expect(verbatimNumerals(["deposit 3000 baht"])).not.toContain(3000);
    expect(verbatimNumerals([undefined, null, ""])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ONE MOVE PER HUMAN BEAT. Every tap on Push harder composed a FRESH draft, so
// the exact-text dedupe never matched and three near-identical bargains landed
// in one shop's chat inside a minute. The user-move window is the missing
// statement: "the traveller already moved in this thread just now".
// ---------------------------------------------------------------------------

describe("the user-move window", () => {
  it("is one human conversational beat, distinct from the engine's turn lock", () => {
    expect(USER_MOVE_WINDOW_SEC).toBe(180);
    expect(TURN_WINDOW_SEC).toBe(120);
  });

  it("slots are per (shop, bucket) and never collide with turn slots", () => {
    const now = 1_722_300_000_000;
    const b = turnBucket(now, USER_MOVE_WINDOW_SEC);
    expect(userMoveSlot("+66 81 234 5678", b)).toBe(`umove:66812345678:${b}`);
    expect(userMoveSlot("66812345678", b)).not.toBe(threadTurnSlot("66812345678", b));
    // Two taps 60s apart share a bucket (same window); a tap 4 minutes later
    // does not - the debounce expires on its own, no cleanup required.
    expect(turnBucket(now + 60_000, USER_MOVE_WINDOW_SEC)).toBe(b);
    expect(turnBucket(now + 240_000, USER_MOVE_WINDOW_SEC)).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// THE WIRING. Provenance and the move window only matter if the live paths
// actually consult them.
// ---------------------------------------------------------------------------

import { readFileSync } from "fs";
import { join } from "path";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("every composed outbound passes the provenance gate", () => {
  it("SPTE post-rails ground their numbers in the conversation", () => {
    const rails = readCode("src/lib/spte/rails.ts");
    // ...except the pickup-location move, which the location rail owns - a
    // street number in a verified address is not an ungrounded price.
    expect(rails).toMatch(/grounded: artifact\.move === "pickup-location" \? \[\] : \[/);
    expect(rails).toMatch(/verbatimNumerals\(/);
    expect(rails).toMatch(/durationDays: ctx\.session\.rfq\.durationDays/);
  });

  it("both LIVE engines pass the same provenance basis (legacy loop deleted)", () => {
    // The legacy loop's copy of this basis died with the legacy block - one
    // fewer divergent implementation to drift. The two engines that actually
    // run are the ones held to it.
    for (const p of ["src/lib/graph/engine.ts", "src/lib/spte/rails.ts"]) {
      const code = readCode(p);
      expect(code).toMatch(/verbatimNumerals\(/);
    }
    expect(readCode("src/lib/graph/engine.ts")).toMatch(/grounded: \[/);
  });

  it("outreach claims ONE user move per window and refuses honestly", () => {
    const route = readCode("src/app/api/outreach/route.ts");
    expect(route).toMatch(/claimUserMove\(/);
    expect(route).toMatch(/held: true/);
    expect(route).toMatch(/releaseUserMove/);
  });

  it("a second tap gets the SAME draft back, restoring exact-text dedupe", () => {
    const route = readCode("src/app/api/bargain-draft/route.ts");
    expect(route).toMatch(/USER_MOVE_WINDOW_SEC/);
    expect(route).toMatch(/reused: true/);
  });

  it("the client marks action sends and guards them in flight", () => {
    const page = readCode("src/app/page.tsx");
    expect(page).toMatch(/userMove: true/);
    expect(page).toMatch(/actionsInFlight/);
    const overlay = readCode("src/components/will/WillGuideOverlay.tsx");
    expect(overlay).toMatch(/busyLabel/);
    expect(overlay).toMatch(/dismissOnDone/);
    expect(readCode("src/components/BargainDraftModal.tsx")).toMatch(/userMove: true/);
  });
});
