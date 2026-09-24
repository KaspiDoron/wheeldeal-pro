import { describe, expect, it } from "vitest";
import { DEFAULT_TRAFFIC_SETTINGS, parseTrafficSettings, placementEnabled } from "./settings";

describe("TRAFFIC_SETTINGS - configurable, never unbounded", () => {
  it("an empty value is a complete working configuration", () => {
    for (const raw of ["", "   ", null, undefined]) {
      expect(parseTrafficSettings(raw)).toEqual({ settings: DEFAULT_TRAFFIC_SETTINGS, errors: [] });
    }
  });

  it("takes what is given and defaults the rest", () => {
    const { settings, errors } = parseTrafficSettings('{"relatedSearches":4,"placements":{"no-coverage":false}}');
    expect(errors).toEqual([]);
    expect(settings.relatedSearches).toBe(4);
    expect(settings.maxAds).toBe(3);
    expect(settings.placements["no-coverage"]).toBe(false);
    expect(settings.placements["guide-inline"]).toBe(true);
  });

  // These are Google's limits, not preferences. A vault typo must not be able
  // to turn into a policy violation.
  it("clamps to what a NON-RAF account is allowed, and says so", () => {
    const { settings, errors } = parseTrafficSettings('{"relatedSearches":12,"maxAds":9}');
    expect(settings.relatedSearches).toBe(5);
    expect(settings.maxAds).toBe(3);
    expect(errors.join(" ")).toMatch(/Restricted Access/);
    expect(errors).toHaveLength(2);
  });

  it("opens the wider range only when the owner says the account holds RAF", () => {
    expect(parseTrafficSettings('{"raf":true,"relatedSearches":8}').settings.relatedSearches).toBe(8);
    expect(parseTrafficSettings('{"raf":"yes","relatedSearches":8}').settings.relatedSearches).toBe(5);
  });

  it("never goes below the floor Google renders at", () => {
    expect(parseTrafficSettings('{"relatedSearches":1,"maxAds":0}').settings).toMatchObject({ relatedSearches: 3, maxAds: 1 });
  });

  it("falls back to defaults on unparseable JSON and REPORTS it", () => {
    for (const raw of ["{nope", "[1,2]", '"text"', "42"]) {
      const out = parseTrafficSettings(raw);
      expect(out.settings).toEqual(DEFAULT_TRAFFIC_SETTINGS);
      expect(out.errors[0]).toMatch(/default/);
    }
  });

  it("names unknown settings and placements instead of swallowing them", () => {
    const { errors, settings } = parseTrafficSettings('{"relatedSearchs":4,"placements":{"popunder":true,"unknown":true,"guide-hub":"yes"}}');
    expect(errors.join(" ")).toMatch(/relatedSearchs/);
    expect(errors.join(" ")).toMatch(/popunder/);
    expect(settings.placements).toEqual(DEFAULT_TRAFFIC_SETTINGS.placements);
  });

  it("accepts only plain search terms under a valid market|category key", () => {
    const { settings, errors } = parseTrafficSettings(
      JSON.stringify({ linkTerms: { "th|scooter": ["scooter rental Phuket", "  moped hire  ", "<script>", "doron@example.com", "scooter rental Phuket"], "zz|scooter": ["x y"], "th|boats": ["boat hire"] } })
    );
    expect(settings.linkTerms).toEqual({ "th|scooter": ["scooter rental Phuket", "moped hire"] });
    expect(errors).toHaveLength(2);
  });

  it("always keeps `rac` in the ignored params, whatever list is given", () => {
    expect(parseTrafficSettings('{"ignoredPageParams":["src","bad param!","utm_x"]}').settings.ignoredPageParams).toEqual(["src", "utm_x", "rac"]);
  });

  it("validates funnel guide overrides", () => {
    const { settings, errors } = parseTrafficSettings('{"funnelGuides":{"th":"thailand-scooter-rental-prices","zz":"x","vn":"../etc"}}');
    expect(settings.funnelGuides).toEqual({ th: "thailand-scooter-rental-prices" });
    expect(errors).toHaveLength(2);
  });

  it("answers whether a placement is on", () => {
    const { settings } = parseTrafficSettings('{"placements":{"hunt-ended":false}}');
    expect(placementEnabled(settings, "hunt-ended")).toBe(false);
    expect(placementEnabled(settings, "guide-inline")).toBe(true);
    expect(placementEnabled(settings, "unknown")).toBe(false);
  });
});
