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

  it("the verification handshake will not echo a challenge without the secret", () => {
    expect(hook).toMatch(/mode === "subscribe" && secret && token === secret && challenge/);
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
});
