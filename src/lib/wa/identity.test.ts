import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolveOutreachIdentity } from "./identity";

describe("resolveOutreachIdentity (privacy keystone + orphaned-reply fix)", () => {
  it("keeps the real identity when there is NO reference phone to contradict it", () => {
    // The regression that orphaned every real reply: a legit shop with no
    // Google phone (Details 5xx/quota, unlisted, or a trusted seed vendor) was
    // being re-keyed to a test id, so its reply never bound back to the card.
    const d = resolveOutreachIdentity({
      claimsRealShop: true,
      resolvedPhone: "", // unknown - NOT a contradiction
      supplied: "6281234567",
      drillIntent: false,
    });
    expect(d.action).toBe("keep");
  });

  it("keeps the real identity when the supplied number MATCHES the Google phone", () => {
    const d = resolveOutreachIdentity({
      claimsRealShop: true,
      resolvedPhone: "6281234567",
      supplied: "6281234567",
      drillIntent: false,
    });
    expect(d.action).toBe("keep");
  });

  it("an OWNER with no declared drill keeps a real shop's real identity - no (unverified)", () => {
    // The owner is a normal user in production (TEST_MODE off). A real shop at
    // its real Google number must NOT be re-keyed to a "(unverified)" test id.
    const d = resolveOutreachIdentity({
      claimsRealShop: true,
      resolvedPhone: "6281234567",
      supplied: "6281234567",
      drillIntent: false,
      vendorName: "Qui Motorbike Rental",
    });
    expect(d.action).toBe("keep");
  });

  it("an OWNER with no declared drill keeps identity even with no reference phone", () => {
    const d = resolveOutreachIdentity({
      claimsRealShop: true,
      resolvedPhone: "",
      supplied: "6281234567",
      drillIntent: false,
      vendorName: "Pai River Scooter",
    });
    expect(d.action).toBe("keep");
  });

  it("routes a NON-owner mismatch to the shop's own number (real shop wins)", () => {
    const d = resolveOutreachIdentity({
      claimsRealShop: true,
      resolvedPhone: "6281111111",
      supplied: "6289999999", // spoofed / wrong number
      drillIntent: false,
    });
    expect(d).toEqual({ action: "send-to-shop", toPhone: "6281111111" });
  });

  it("re-keys a DECLARED drill to a WINDOWED unverified identity even without a contradiction", () => {
    const d = resolveOutreachIdentity({
      claimsRealShop: true,
      resolvedPhone: "",
      supplied: "6289999999",
      drillIntent: true,
      vendorName: "Bali Scooters",
    });
    expect(d.action).toBe("rekey-test");
    if (d.action === "rekey-test") {
      expect(d.vendorId).toBe("test-6289999999");
      expect(d.vendorName).toBe("Bali Scooters (unverified)");
    }
  });

  it("re-keys a DECLARED drill mismatch to a test identity (the caller cannot override to send elsewhere)", () => {
    const d = resolveOutreachIdentity({
      claimsRealShop: true,
      resolvedPhone: "6281111111",
      supplied: "6289999999",
      drillIntent: true,
    });
    expect(d.action).toBe("rekey-test");
  });

  it("never touches identity when the caller does not claim a real shop", () => {
    const d = resolveOutreachIdentity({
      claimsRealShop: false,
      resolvedPhone: "6281111111",
      supplied: "6289999999",
      drillIntent: false,
    });
    expect(d.action).toBe("keep");
  });

  it("keeps identity when there is no supplied number at all", () => {
    const d = resolveOutreachIdentity({
      claimsRealShop: true,
      resolvedPhone: "6281111111",
      supplied: "",
      drillIntent: false,
    });
    expect(d.action).toBe("keep");
  });

  it("clamps an over-long vendor name to 56 chars before appending the marker", () => {
    const long = "X".repeat(200);
    const d = resolveOutreachIdentity({
      claimsRealShop: true,
      resolvedPhone: "6281111111",
      supplied: "6289999999",
      drillIntent: true,
      vendorName: long,
    });
    if (d.action === "rekey-test") {
      expect(d.vendorName).toBe(`${"X".repeat(56)} (unverified)`);
    } else {
      throw new Error("expected rekey-test");
    }
  });
});

describe("TEST_MODE is not a statement that the shop is fake", () => {
  it("the outreach route derives drillIntent from an explicit flag, never from TEST_MODE", () => {
    // THE BETA-KILLING REGRESSION. `drillIntent` used to be
    // `session.role === "owner" && await testModeOn()`. TEST_MODE stays ON for
    // the entire tester programme, so every real shop the owner contacted was
    // stamped `test-<digits>` - a DRILL ANCHOR, which collapses the inbound
    // window from 14 days to 3 hours and binds replies to a vendorId no card
    // holds. Shops answered; the app said "Awaiting reply".
    const src = readFileSync("src/app/api/outreach/route.ts", "utf8");
    expect(src).toContain("const drillIntent = body.drill === true;");
    // The identity block must not consult TEST_MODE at all any more.
    // Strip comments before asserting: the comment explaining this regression
    // necessarily quotes the code it replaced, and a grep that cannot tell
    // prose from code is a test that fails on its own documentation.
    const code = src
      .slice(src.indexOf("IDENTITY VERIFICATION"), src.indexOf("if (!to) {"))
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    expect(code).not.toMatch(/testModeOn/);
  });
});
