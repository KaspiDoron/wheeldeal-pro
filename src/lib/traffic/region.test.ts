import { describe, expect, it } from "vitest";
import { TCF_COUNTRIES, consentRegion, searchAdsPermitted } from "./region";

describe("which consent regime a visitor is under", () => {
  it("covers the EEA, the UK and Switzerland - the places Google demands a certified CMP", () => {
    // 27 EU + Iceland, Liechtenstein, Norway + UK + Switzerland.
    expect(TCF_COUNTRIES.size).toBe(32);
    for (const c of ["DE", "FR", "IE", "NO", "IS", "LI", "GB", "CH"]) expect(TCF_COUNTRIES.has(c)).toBe(true);
    for (const c of ["US", "TH", "VN", "IL", "TR", "RS"]) expect(TCF_COUNTRIES.has(c)).toBe(false);
  });

  it("trusts a country code from the edge when there is one", () => {
    expect(consentRegion({ country: "de", timeZone: "Asia/Bangkok" })).toBe("tcf");
    expect(consentRegion({ country: "TH", timeZone: "Europe/Berlin" })).toBe("other");
  });

  // Cloud Run gives no country header, so most requests arrive without one.
  // The browser's time zone is the fallback - and it is about where the
  // visitor IS, which is what the rule turns on: a German on a beach in Phuket
  // is not an EEA user, a Thai in Berlin is.
  it("falls back to the time zone, over-including rather than under-including", () => {
    expect(consentRegion({ timeZone: "Europe/Berlin" })).toBe("tcf");
    expect(consentRegion({ timeZone: "Europe/London" })).toBe("tcf");
    expect(consentRegion({ timeZone: "Atlantic/Canary" })).toBe("tcf");
    expect(consentRegion({ timeZone: "Indian/Reunion" })).toBe("tcf");
    // Every Europe/* zone counts, including ones outside the EEA. Losing a
    // little revenue in Istanbul is a cheaper mistake than serving without a
    // TC string in Vienna.
    expect(consentRegion({ timeZone: "Europe/Istanbul" })).toBe("tcf");
    expect(consentRegion({ timeZone: "Asia/Bangkok" })).toBe("other");
    expect(consentRegion({ timeZone: "America/New_York" })).toBe("other");
  });

  it("answers unknown - not other - when it cannot tell", () => {
    expect(consentRegion({})).toBe("unknown");
    expect(consentRegion({ country: "", timeZone: "" })).toBe("unknown");
    expect(consentRegion({ country: "ZZZ", timeZone: "Not/AZone" })).toBe("unknown");
    expect(consentRegion({ country: "XX" })).toBe("unknown");
  });
});

describe("may Google search ads be requested for this visitor at all", () => {
  it("outside the TCF regions, this site's own consent is enough", () => {
    expect(searchAdsPermitted("other", "none")).toBe(true);
  });

  // Google: without a certified TCF CMP "our Search Ads publisher products will
  // not serve any ads". Requesting them anyway earns nothing and puts the
  // account's policy standing at risk, so the request is simply not made.
  it("inside them, only once a Google-certified CMP is installed", () => {
    expect(searchAdsPermitted("tcf", "none")).toBe(false);
    expect(searchAdsPermitted("tcf", "google")).toBe(true);
  });

  it("treats a visitor it cannot place as if they were inside", () => {
    expect(searchAdsPermitted("unknown", "none")).toBe(false);
    expect(searchAdsPermitted("unknown", "google")).toBe(true);
  });
});
