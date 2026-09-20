import { describe, expect, it } from "vitest";
import { buildDestination, parsePartners, partnerFor, type TrafficPartner } from "./partners";

const link: TrafficPartner = {
  id: "feed-a",
  kind: "link",
  label: "Feed A",
  enabled: true,
  template: "https://search.feed-a.example/results?q={q}&subid={subid}&src=wd",
  markets: [],
  revenueShare: 0.8,
};

describe("partner registry", () => {
  it("parses one partner per line from the vault value", () => {
    const parsed = parsePartners(
      [
        "feed-a|link|Feed A|on|https://search.feed-a.example/results?q={q}&subid={subid}|th,vn|0.8",
        "google|afs|Google AFS|on|partner-pub-1234567890123456:1234567890||1",
      ].join("\n")
    );
    expect(parsed.partners.map((p) => p.id)).toEqual(["feed-a", "google"]);
    expect(parsed.partners[0].markets).toEqual(["th", "vn"]);
    expect(parsed.errors).toEqual([]);
  });

  // Google's reference: the tag takes "the part of your client-ID that comes
  // after 'partner-'". Given the long form it serves nothing and says nothing,
  // so both spellings are accepted and the tag always gets the short one.
  it("normalises the AFS pub id to the form the tag takes, whichever was pasted", () => {
    const long = parsePartners("g|afs|G|on|partner-pub-1234567890123456:1234567890||1").partners[0];
    const short = parsePartners("g|afs|G|on|pub-1234567890123456:1234567890:9876543210||1").partners[0];
    expect(long).toMatchObject({ kind: "afs", pubId: "pub-1234567890123456", styleId: "1234567890", channel: null });
    expect(short).toMatchObject({ kind: "afs", pubId: "pub-1234567890123456", channel: "9876543210" });
  });

  it("refuses an AFS channel that could not be a real AdSense channel id", () => {
    const parsed = parsePartners("g|afs|G|on|pub-1234567890123456:1234567890:doron@example.com||1");
    expect(parsed.partners).toEqual([]);
    expect(parsed.errors[0]).toMatch(/channel/);
  });

  // An owner pastes this by hand into Admin -> Keys. A typo must surface as a
  // named error on that screen - not as a partner that silently earns nothing,
  // and never as a redirect to somewhere nobody intended.
  it("rejects a bad line with a reason, and keeps the good ones", () => {
    const parsed = parsePartners(
      [
        "feed-a|link|Feed A|on|https://search.feed-a.example/results?q={q}&subid={subid}||0.8",
        "evil|link|Evil|on|http://insecure.example/?q={q}&subid={subid}||1",
        "js|link|JS|on|javascript:alert(1)//{q}{subid}||1",
        "noq|link|No Q|on|https://x.example/?subid={subid}||1",
        "badafs|afs|Bad|on|ca-pub-123||1",
        "dupe|link|Dupe|on|https://a.example/?q={q}&subid={subid}||1",
        "dupe|link|Dupe 2|on|https://b.example/?q={q}&subid={subid}||1",
        "short|link",
      ].join("\n")
    );
    expect(parsed.partners.map((p) => p.id)).toEqual(["feed-a", "dupe"]);
    expect(parsed.errors).toHaveLength(6);
    expect(parsed.errors.join(" ")).toMatch(/https/);
  });

  it("is empty, not broken, when nothing is configured", () => {
    expect(parsePartners("")).toEqual({ partners: [], errors: [] });
    expect(parsePartners(null)).toEqual({ partners: [], errors: [] });
  });
});

describe("destination builder", () => {
  it("fills the template and encodes the query", () => {
    const url = buildDestination(link, { q: "scooter rental bangkok & pattaya", subId: "p1-mth-cscooter-9a3f01bc" });
    expect(url).toBe(
      "https://search.feed-a.example/results?q=scooter%20rental%20bangkok%20%26%20pattaya&subid=p1-mth-cscooter-9a3f01bc&src=wd"
    );
  });

  // The query is the only free text that reaches a partner, and it comes from a
  // curated term list - but this function is the last line, so it holds anyway.
  it("cannot be steered to another host by the query or the sub-id", () => {
    for (const q of ["x&redirect=https://evil.example", "https://evil.example", "\r\nLocation: https://evil.example", "a#@evil.example/"]) {
      const url = buildDestination(link, { q, subId: "p1-mth-cscooter-9a3f01bc" });
      expect(url).not.toBeNull();
      expect(new URL(url as string).host).toBe("search.feed-a.example");
      expect(new URL(url as string).searchParams.get("src")).toBe("wd");
    }
  });

  it("refuses a sub-id this app did not build", () => {
    expect(buildDestination(link, { q: "scooter", subId: "doron@example.com" })).toBeNull();
    expect(buildDestination(link, { q: "scooter", subId: "" })).toBeNull();
  });

  it("refuses an empty or oversized query", () => {
    expect(buildDestination(link, { q: "   ", subId: "p1-mth-cscooter-9a3f01bc" })).toBeNull();
    expect(buildDestination(link, { q: "x".repeat(201), subId: "p1-mth-cscooter-9a3f01bc" })).toBeNull();
  });

  it("builds nothing for a disabled partner or an AFS partner (AFS renders in-page, it is not a link)", () => {
    expect(buildDestination({ ...link, enabled: false }, { q: "scooter", subId: "p1-mth-cscooter-9a3f01bc" })).toBeNull();
    const afs: TrafficPartner = { id: "g", kind: "afs", label: "G", enabled: true, pubId: "pub-1234567890123456", styleId: "1234567890", channel: null, markets: [], revenueShare: 1 };
    expect(buildDestination(afs, { q: "scooter", subId: "p1-mth-cscooter-9a3f01bc" })).toBeNull();
  });
});

describe("partner selection", () => {
  const th: TrafficPartner = { ...link, id: "th-only", markets: ["th"] };
  const any: TrafficPartner = { ...link, id: "any", markets: [] };

  it("prefers a partner that targets the market, then a market-neutral one", () => {
    expect(partnerFor([any, th], "th", "link")?.id).toBe("th-only");
    expect(partnerFor([any, th], "vn", "link")?.id).toBe("any");
  });

  it("never picks a disabled partner, and answers null when nothing fits", () => {
    expect(partnerFor([{ ...th, enabled: false }], "th", "link")).toBeNull();
    expect(partnerFor([th], "vn", "link")).toBeNull();
    expect(partnerFor([], "th", "afs")).toBeNull();
  });
});
