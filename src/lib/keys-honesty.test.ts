import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { providerFailureKind } from "./provider-health";

// THE KEYS TAB EXISTS TO CATCH A FAILURE BEFORE A TRAVELLER DOES.
//
// Three surfaces on it were answering a question adjacent to the one asked:
// a tier-gated model was reported as a bad key, PayPal reported HEALTHY with
// the plan ids that make checkout work missing, and the Gmail test counted
// characters and deferred the real answer to "the first email sent" - which is
// somebody's signup code.

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("a tier-gated model is not a broken key", () => {
  it("EXECUTED: Mistral's live 403 tier_not_allowed classifies as paywalled", () => {
    // The owner's live probe. The key is valid; the MODEL needs a paid plan.
    // Classified as `auth` this told them to "paste a working token" for a
    // token that works - and once the 403 sibling-rescue lands it would paint
    // a benign, self-healing rung amber "FAILED - fix it".
    expect(
      providerFailureKind(
        "mistral 403 - {\"message\":\"This model is not available in your subscription tier\",\"type\":\"tier_not_allowed\",\"code\":\"1910\"}"
      )
    ).toBe("paywalled");
  });

  it("EXECUTED: a genuinely bad key is still auth, in every spelling", () => {
    for (const d of [
      "gemini 403 - API key not valid. Please pass a valid API key.",
      "openai 401 - invalid_api_key",
      "groq 403 forbidden",
      "openai 429 - insufficient_quota",
    ]) {
      expect(providerFailureKind(d), d).toBe("auth");
    }
  });

  it("EXECUTED: a spent free allowance is still paywalled, and busy is still busy", () => {
    expect(providerFailureKind("cerebras 402 payment required")).toBe("paywalled");
    expect(providerFailureKind("groq 429 rate limit reached")).toBe("busy");
    expect(providerFailureKind("anthropic 529 overloaded")).toBe("busy");
  });

  it("EXECUTED: an empty detail is UNKNOWN, never a confident verdict", () => {
    expect(providerFailureKind("")).toBe("unknown");
    expect(providerFailureKind(null)).toBe("unknown");
  });
});

describe("the grounded ladder has no dead rung", () => {
  it("gemini-flash-latest is not listed twice", () => {
    const ai = readCode("src/lib/ai.ts");
    expect(ai).toMatch(/const models = \[GEMINI_MODEL, "gemini-flash-lite-latest"\]/);
    // GEMINI_MODEL is itself "gemini-flash-latest", so the literal made a
    // 429/404 retry on the SAME id before ever reaching lite.
    expect(ai).not.toMatch(/\[GEMINI_MODEL, "gemini-flash-latest"/);
  });
});

describe("PayPal HEALTHY means a checkout can actually complete", () => {
  it("missing plan ids degrade the tile and name the key", () => {
    const health = readCode("src/app/api/admin/health/route.ts");
    // Valid credentials are not a working checkout: the plan ids are what
    // tierForPaypalPlan matches an approved subscription against, so the tile
    // read HEALTHY right up until a real traveller reached checkout.
    expect(health).toMatch(/getConfig\("PAYPAL_PLAN_PRO"\)/);
    expect(health).toMatch(/getConfig\("PAYPAL_PLAN_ULTRA"\)/);
    expect(health).toMatch(/status: "degraded"/);
    expect(health).toMatch(/a real checkout for that tier cannot complete/);
  });
});

describe("the Gmail test AUTHs instead of counting characters", () => {
  it("the key test runs the live SMTP probe that already existed", () => {
    const test = readCode("src/app/api/admin/key-test/route.ts");
    // A revoked App Password is exactly 16 characters, so the one failure that
    // matters passed the format test and surfaced as a traveller unable to
    // receive their signup code.
    expect(test).toMatch(/emailLiveProbe/);
    expect(test).toMatch(/gmail\?\.live/);
    expect(test).not.toMatch(/Live SMTP is verified on the first email sent/);
  });

  it("the probe it calls really is an AUTH, not a reachability ping", () => {
    const email = readCode("src/lib/email.ts");
    expect(email).toMatch(/await transporter\.verify\(\)/);
    expect(email).toMatch(/nothing sent/);
  });
});
