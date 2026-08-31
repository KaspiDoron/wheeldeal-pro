import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

const hook = readCode("src/app/api/webhooks/waba/route.ts");
const link = readCode("src/app/h/[token]/route.ts");
// RAW, uncommented-stripped. `readCode` removes `//...` to end of line, which
// also eats the "//" inside every https:// URL - so a URL assertion run against
// the stripped text silently tests nothing.
const linkRaw = readFileSync(join(process.cwd(), "src/app/h/[token]/route.ts"), "utf8");

// AN UNAUTHENTICATED WEBHOOK HERE IS A WAY TO INJECT STATE INTO THE LEDGER.
//
// This endpoint can open 24-hour service windows, advance leads and mark
// agencies capped. Meta signs with X-Hub-Signature-256; most resellers do not
// sign at all - so it accepts either, and with NEITHER configured it must
// refuse everything rather than trusting the internet.

describe("the webhook authenticates before it acts", () => {
  it("with no secret configured it refuses", () => {
    expect(hook).toMatch(/if \(!secret\) \{[\s\S]{0,320}status: 403/);
  });

  it("it accepts an HMAC or a shared secret, never neither", () => {
    expect(hook).toMatch(/verifyHmac\(raw, req\.headers\.get\("x-hub-signature-256"\), secret\)/);
    expect(hook).toMatch(/if \(!signed && !shared\)/);
  });

  it("the HMAC comparison is constant-time", () => {
    expect(hook).toMatch(/timingSafeEqual/);
    // A length mismatch must short-circuit: timingSafeEqual THROWS on unequal
    // buffers, so without this a crafted header is a 500 rather than a 403.
    expect(hook).toMatch(/if \(got\.length !== expected\.length\) return false;/);
  });

  it("the verification handshake will not echo a challenge without a verify token", () => {
    // The property under test is unchanged: no configured value, no challenge
    // echo. What changed is WHICH value - the verify token and the signing
    // secret are now separate keys. Conflating them forced the owner to type
    // the HMAC app secret into Meta's callback form, after which Meta sent it
    // back as a URL QUERY PARAMETER on every re-verification, writing the
    // signing key into every access log in the path.
    expect(hook).toMatch(/mode === "subscribe" && verify && token === verify && challenge/);
    expect(hook).toMatch(/getConfig\("WABA_VERIFY_TOKEN"\)/);
    // The fallback keeps an already-configured reseller working with no
    // re-entry - they usually sign nothing and set only the one key.
    expect(hook).toMatch(/getConfig\("WABA_WEBHOOK_SECRET"\)\) \?\? ""\)\.trim\(\)/);
  });

  it("with the flag off it does no work but does not make the provider retry", () => {
    // A stale subscription pointing here must not spin forever on 4xx.
    expect(hook).toMatch(/if \(!c\.enabled\) return NextResponse\.json\(\{ ok: true, ignored: "flag-off" \}\)/);
  });
});

describe("statuses are classified, not merely logged", () => {
  it("131049 marks the recipient capped, rescues the LEAD to held, and returns", () => {
    // The message is guaranteed undeliverable until the recipient's own cap
    // resets. Re-sending only spends quality rating to be told so again - and
    // the lead whose send just capped goes back to HELD (the old early return
    // skipped the lead lookup, stranding it in template_sent forever).
    expect(hook).toMatch(/if \(code === 131049 && tail\) \{[\s\S]{0,160}markTemplateCapped\(tail\);/);
    expect(hook).toMatch(/markTemplateCapped\(tail\);[\s\S]{0,700}advanceLead\(capped\.id, "held"[\s\S]{0,120}return;/);
  });

  it("delivered and read are write-once", () => {
    // Otherwise a duplicate webhook rewrites the timestamp and the funnel's
    // latency numbers drift with redelivery volume rather than with reality.
    expect(hook).toMatch(/delivered_at=is\.null/);
    expect(hook).toMatch(/read_at=is\.null/);
  });

  it("a genuine failure is terminal and carries its reason", () => {
    expect(hook).toMatch(/advanceLead\(lead\.id, "failed"/);
    expect(hook).toMatch(/terminal_reason:/);
  });
});

describe("an agency reply is the highest-value event in the system", () => {
  it("it opens the window and flushes what was waiting", () => {
    expect(hook).toMatch(/onAgencyReplied\(m\.from, renderHeldHandoff\)/);
  });
});

// THE HANDOFF LINK.
//
// The template's button points here rather than at wa.me, because wa.me links
// and shorteners are named template-rejection causes. The indirection then buys
// three more things: one-tap handoff, the only real per-agency engagement signal
// in the product, and a prefilled opener our ingest can recognise when the
// agency replies from a staff mobile.

describe("the handoff link is safe to forward", () => {
  it("the traveller's number is never in the URL or the token", () => {
    // Anyone who receives a forwarded template can tap this.
    expect(link).toMatch(/const user = await getUser\(lead\.user_email\)/);
    expect(link).not.toMatch(/params.*phone|token.*phone/i);
  });

  it("every failure lands on the same neutral page", () => {
    // A distinguishable error would let someone probe which tokens exist.
    expect(link).toMatch(/const dead = \(\)/);
    expect((link.match(/return dead\(\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("a short or absent token is rejected before any read", () => {
    expect(link).toMatch(/if \(!token \|\| token\.length < 12\) return dead\(\)/);
  });

  it("the tap is write-once - the FIRST tap is the signal", () => {
    // Re-stamping would turn "did this work" into "how often was the chat
    // re-opened", which is a different and much less useful question.
    expect(link).toMatch(/link_tapped_at=is\.null/);
    expect(link).toMatch(/if \(!lead\.link_tapped_at\)/);
  });

  it("wa.me is used HERE, where it is allowed", () => {
    // Only templates restrict wa.me. A redirect target is not a template.
    expect(linkRaw).toMatch(/https:\/\/wa\.me\//);
  });

  it("the opener is authored by us, so ingest can recognise it", async () => {
    const { prefilledOpener } = await import("./render");
    expect(prefilledOpener("Sunrise Rentals")).toContain("Sunrise Rentals");
    expect(prefilledOpener(null)).toMatch(/rent a vehicle/);
    expect(prefilledOpener("  ")).toMatch(/rent a vehicle/);
  });

  it("...and openerMatch closes the loop: what we author, we recognise", async () => {
    // The staff-mobile case's whole foundation: round-trip BOTH authored
    // shapes through the matcher, name extraction included.
    const { prefilledOpener, openerMatch } = await import("./render");
    expect(openerMatch(prefilledOpener("Sunrise Rentals"))).toEqual({
      match: true,
      agencyName: "Sunrise Rentals",
    });
    expect(openerMatch(prefilledOpener(null))).toEqual({ match: true });
    // Not a heuristic: ordinary shop talk does not match, nor does an essay
    // that merely quotes the phrase.
    expect(openerMatch("hello, want to rent a scooter?").match).toBe(false);
    expect(openerMatch(`${"blah ".repeat(50)}you were looking to rent a vehicle?`).match).toBe(false);
    expect(openerMatch("").match).toBe(false);
    expect(openerMatch(null).match).toBe(false);
  });

  it("a lightly edited prefill still matches - staff add their name, not an essay", async () => {
    const { openerMatch } = await import("./render");
    const m = openerMatch("Hello! This is Sunrise Rentals, you were looking to rent a vehicle?");
    expect(m.match).toBe(true);
    expect(m.agencyName).toBe("Sunrise Rentals");
  });
});

describe("the handoff link is bounded in time and by the lead's fate", () => {
  it("a terminal lead's link is dead - failed and expired tokens resolve nothing", () => {
    // A failed template reached no one and an expired hold sent nothing, so no
    // one can legitimately hold either link; resolving one would connect a
    // stranger to a traveller off a token that leaked at leisure. handed_off
    // stays LIVE - the agency re-opening its own chat is normal.
    expect(link).toMatch(/lead\.state === "failed" \|\| lead\.state === "expired"/);
  });

  it("the link expires on the same clock as the inbound expectation", () => {
    expect(link).toMatch(/WABA_EXPECTATION_TTL_HOURS/);
    expect(link).toMatch(/ttlHours \* 3600_000\) return dead\(\)/);
    // An unparseable birth date is treated as too old, never as fresh.
    expect(link).toMatch(/!Number\.isFinite\(born\)/);
  });

  it("the neutral dead page resolves through site.ts, not a re-derived env chain", () => {
    expect(link).toMatch(/resolveSiteOrigin/);
    expect(link).not.toMatch(/process\.env\.APP_DOMAIN/);
  });
});
