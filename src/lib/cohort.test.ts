import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { bucketOf } from "./cohort";

vi.mock("server-only", () => ({}));

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

const cohort = readCode("src/lib/cohort.ts");
const warmup = readCode("src/lib/warmup.ts");
const lifecycle = readCode("src/lib/lifecycle.ts");
const panel = readCode("src/components/admin/LifecyclePanel.tsx");

// THERE WAS NO WAY TO ROLL ANYTHING BACK.
//
// `canary`, `cohort`, `rollout` and `feature_flag` returned ZERO hits across
// src/. Every switch was a 100%-of-fleet switch that landed inside the config
// cache's 30 seconds and could not be returned to any prior value. On a fleet of
// travellers' personal WhatsApp numbers that is not a feature flag, it is a bet.

describe("bucketing is stable, and stable is the whole point", () => {
  it("the same identity always lands in the same bucket", () => {
    // It has to survive a Cloud Run cold start. A user who flips arm between two
    // requests would watch the gate appear and disappear, and would poison the
    // comparison the cohort exists to enable.
    expect(bucketOf("a@b.com")).toBe(bucketOf("a@b.com"));
    expect(bucketOf("a@b.com")).toBe(bucketOf("  A@B.com "));
  });

  it("buckets are in range", () => {
    for (const e of ["x@y.z", "traveller@example.org", "", "  "]) {
      const b = bucketOf(e);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(100);
    }
  });

  it("it hashes rather than reading the string directly", () => {
    // Emails cluster hard on first character and domain, so anything cheaper
    // than a hash produces buckets that correlate with the population - and a
    // holdout that is 40% one mail provider is not a control group.
    const sameFirstChar = ["aaron@gmail.com", "adam@gmail.com", "alice@gmail.com", "amy@gmail.com"];
    const buckets = new Set(sameFirstChar.map(bucketOf));
    expect(buckets.size).toBeGreaterThan(1);
    expect(cohort).toMatch(/createHash\("sha256"\)/);
  });

  it("spreads roughly evenly - a lopsided split is a broken experiment", () => {
    const counts = new Array(10).fill(0);
    for (let i = 0; i < 2000; i++) counts[Math.floor(bucketOf(`user${i}@test.com`) / 10)] += 1;
    for (const c of counts) {
      expect(c).toBeGreaterThan(100); // expected 200 per decile
      expect(c).toBeLessThan(320);
    }
  });
});

describe("an unconfigured cohort is EMPTY, never full", () => {
  it("membership requires an explicit percentage or an explicit listing", () => {
    // A mistyped config name must roll a change out to NOBODY. The opposite
    // default would turn a typo into a fleet-wide change.
    expect(cohort).toMatch(/_PCT/);
    expect(cohort).toMatch(/_LIST/);
    expect(cohort).toMatch(/Number\.isFinite\(pct\) && pct > 0 && bucket < Math\.min\(100, pct\)/);
  });

  it("a named listing wins over the percentage", () => {
    // So the owner can pull one specific account in for testing without moving
    // the percentage for everybody else.
    expect(cohort.indexOf("includes(identity")).toBeLessThan(cohort.indexOf("const pct = Number"));
  });

  it("a failed cohort read is NOT-A-MEMBER, the neutral answer", () => {
    // Failing to member would hand out free access to everyone; failing to
    // blocked would lock everyone out. Neither is neutral; not-a-member is.
    expect(cohort).toMatch(/catch \{[\s\S]{0,300}return false;/);
  });
});

describe("the holdout is an instrument, not a perk", () => {
  it("it ships at zero - there is no default percentage baked into the code", () => {
    // Asserted on the CODE, not on a comment saying so: readCode strips
    // comments, so a comment-based assertion passes no matter what the code
    // does. The only way in is a config value the owner set.
    expect(cohort).not.toMatch(/HOLDOUT_PCT\s*=\s*\d/);
    expect(cohort).not.toMatch(/pct\s*=\s*Number\(pctRaw\)\s*\|\|\s*[1-9]/);
    // The percentage comes from config and nowhere else.
    expect(cohort).toMatch(/getConfig\(`\$\{name\}_PCT`\)/);
  });

  it("holdout users are NOT marked exempt", () => {
    // `exempt` means the gate does not apply (testers, owner) and those rows are
    // excluded from the funnel. A holdout user is a real customer on the control
    // arm and has to stay in the denominator, or the comparison measures nothing.
    expect(warmup).toMatch(/return allWarm\(\{ holdout: true \}\)/);
    expect(warmup).not.toMatch(/holdout: true, exempt: true/);
  });

  it("the holdout is checked AFTER the tester exemption", () => {
    // Otherwise a tester could be counted into an experiment arm.
    expect(warmup.indexOf("isTestUser")).toBeLessThan(warmup.indexOf("inWarmupHoldout"));
  });

  it("nothing tells the user they are in a holdout", () => {
    // A control group that knows it is a control group is not a control group.
    const sheet = readCode("src/components/UpgradeSheet.tsx");
    expect(sheet).not.toMatch(/holdout/i);
  });
});

describe("the lifecycle report fails DARK, never green", () => {
  // This repo has twice shipped a panel that reported "all good" because its
  // reads failed to []. A funnel that renders zeros during a Supabase wobble
  // looks exactly like every user churning at once.
  it("an unavailable read becomes null and is named", () => {
    expect(lifecycle).toMatch(/if \(read\.error === "unavailable"\) \{[\s\S]{0,120}degraded\.push/);
    expect(lifecycle).toMatch(/return null;/);
  });

  it("a MISSING table is empty, not dark - a fresh install really has none", () => {
    expect(lifecycle).toMatch(/return \[\];/);
  });

  it("a conversion with an unknown side is null, not zero", () => {
    expect(lifecycle).toMatch(/num === null \|\| den === null \|\| den === 0 \? null/);
  });

  it("no read in the module swallows failure to an empty array", () => {
    expect(lifecycle).not.toMatch(/catch\(\(\) => \[\]\)/);
    expect(lifecycle).toMatch(/sbSelectStrict/);
  });

  it("the panel renders a dash for unknown, never a zero", () => {
    expect(panel).toMatch(/if \(v === null\)/);
    expect(panel).toMatch(/&mdash;/);
  });

  it("the panel says out loud which figures could not be read", () => {
    // The strip is the SHARED DegradedBanner since 3.5 - same sentence, one
    // implementation, adopted by every management surface.
    expect(panel).toMatch(/<DegradedBanner degraded=\{d\.degraded\} \/>/);
    const prim = readFileSync(
      join(process.cwd(), "src/components/admin/primitives.tsx"),
      "utf8"
    );
    expect(prim).toMatch(/is unknown,\s*\n?\s*not zero/);
  });
});

describe("the numbers are honest about their own limits", () => {
  it("time-to-warm is in HOURS", () => {
    // The product's lifecycle is often shorter than a day, so a days axis would
    // round most of the distribution to zero and hide the variation that
    // actually says whether the thresholds are right.
    expect(lifecycle).toMatch(/3600_000/);
    expect(lifecycle).toMatch(/medianHours/);
    expect(lifecycle).toMatch(/p90Hours/);
  });

  it("stalls are bucketed by FIRST unmet term, not every unmet term", () => {
    // A user missing three terms is blocked by the earliest one. Counting them
    // in all three buckets makes every bucket look equally broken and points at
    // nothing.
    expect(lifecycle).toMatch(/else if \(!searchers\.has\(e\)\)/);
    // W-beta30b: the threshold is no longer the literal 3. It was hard-coded
    // here while the gate card on the SAME screen printed the owner-configured
    // WARMUP_MIN_ENGAGED, so loosening the gate from Keys made the two halves
    // of one panel describe different rules and the chart point at the wrong
    // work. The bucketing rule this test exists for - FIRST unmet term, one
    // else-if chain - is unchanged and still pinned above.
    expect(lifecycle).toMatch(/else if \(\(reachedBy\.get\(e\) \?\? 0\) < th\.minEngaged\)/);
    expect(lifecycle).toMatch(/else if \(\(repliedBy\.get\(e\) \?\? 0\) < th\.minReplies\)/);
    expect(lifecycle).toMatch(/warmupThresholds/);
  });

  it("a holdout arm below the sample floor shows the fraction, not a rate", () => {
    // A percentage from a handful of users is noise dressed as evidence - the
    // same rule the risk dashboard applies at n<8.
    expect(panel).toMatch(/MIN_ARM/);
    expect(panel).toMatch(/too few to rate/);
  });

  it("with no holdout running, the panel says the effect cannot be measured", () => {
    // Rather than printing a comparison against a population that does not
    // exist.
    expect(panel).toMatch(/cannot be\s*\n?\s*measured|cannot be measured/);
  });

  it("paid is counted from the column that actually grants entitlements", () => {
    expect(lifecycle).toMatch(/u\.plan === "pro" \|\| u\.plan === "business" \|\| u\.plan === "ultra"/);
  });
});

describe("the screen cannot become the load it monitors", () => {
  it("reads are bounded and do not fan out per user", () => {
    // /api/activity costs ~21 round trips per tick; at fleet scale a live
    // fan-out monitor becomes the thing it is measuring.
    const route = readCode("src/app/api/admin/lifecycle/route.ts");
    expect(route).toMatch(/requireManagement/);
    expect((lifecycle.match(/rows\(\s*"/g) ?? []).length).toBeLessThanOrEqual(6);
  });

  it("the panel does not poll", () => {
    expect(panel).not.toMatch(/setInterval|setTimeout/);
    expect(panel).toMatch(/reload to refresh/);
  });
});
