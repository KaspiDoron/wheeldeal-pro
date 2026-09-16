import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// ESSENTIAL COOKIES ARE A CONDITION OF USE - pinned in both directions.
//
// A gate like this has two failure modes and they point opposite ways:
//
//   TOO WEAK  - the UI asks, the server does not enforce, and anyone who hides
//               the banner uses the app with no recorded decision. The whole
//               feature is then a suggestion.
//   TOO STRONG - it becomes a cookie wall: a person who declines the OPTIONAL
//               categories is shut out, or the public pages start demanding a
//               decision before they will describe the product. That is the
//               unlawful shape, and it is one careless line away.
//
// So this suite asserts the enforcement AND the limits on it.

vi.mock("server-only", () => ({}));

import {
  COOKIE_GATED_PATHS,
  COOKIE_GATE_PATH,
  cookieGateRedirect,
  hasEssentialAcknowledgement,
  isCookieGatedPath,
  safeNext,
} from "./required";
import {
  ALLOW_ALL,
  DENY_ALL,
  CONSENT_COOKIE,
  encodeCookieConsent,
  makeConsent,
} from "./consent";
import { COOKIE_MANIFEST } from "./manifest";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const header = (value: string) => `other=1; ${CONSENT_COOKIE}=${value}; last=2`;
const essentialOnly = encodeCookieConsent(makeConsent(DENY_ALL, "reject-all"));
const acceptedAll = encodeCookieConsent(makeConsent(ALLOW_ALL, "accept-all"));

describe("the gate lets a decision through, whatever the decision was", () => {
  it("'essential only' passes exactly as readily as 'accept all'", () => {
    // THE LINE BETWEEN A CONDITION OF SERVICE AND A COOKIE WALL. If this ever
    // fails, the product is requiring tracking rather than requiring an answer.
    expect(hasEssentialAcknowledgement(header(essentialOnly))).toBe(true);
    expect(hasEssentialAcknowledgement(header(acceptedAll))).toBe(true);
  });

  it("no decision does not pass", () => {
    expect(hasEssentialAcknowledgement(null)).toBe(false);
    expect(hasEssentialAcknowledgement("")).toBe(false);
    expect(hasEssentialAcknowledgement("other=1; unrelated=2")).toBe(false);
  });

  it("a corrupt or forged record does not pass", () => {
    expect(hasEssentialAcknowledgement(header("garbage"))).toBe(false);
    expect(hasEssentialAcknowledgement(header(""))).toBe(false);
  });

  it("a decision against a superseded policy does not pass", () => {
    // What makes a policy bump reach people who never open a settings screen.
    const stale = encodeCookieConsent({
      ...makeConsent(ALLOW_ALL, "accept-all"),
      version: "1999-01-01",
    });
    expect(hasEssentialAcknowledgement(header(stale))).toBe(false);
  });
});

describe("the gate covers the app and NOT the public surface", () => {
  it("covers the four app routes", () => {
    for (const p of ["/", "/deals", "/profile", "/admin"]) {
      expect(isCookieGatedPath(p)).toBe(true);
    }
  });

  it("does not cover the pages a person needs in order to decide", () => {
    // Demanding a cookie decision before the policy page will render it is the
    // circular shape that makes a gate a wall.
    for (const p of ["/welcome", "/login", "/pricing", "/guides", "/terms", "/privacy", "/cookies"]) {
      expect(isCookieGatedPath(p)).toBe(false);
    }
  });

  it("the destination is public and outside the gate, so it cannot loop", () => {
    expect(isCookieGatedPath(COOKIE_GATE_PATH)).toBe(false);
  });

  it("the middleware matcher and COOKIE_GATED_PATHS are the same set", () => {
    // A gate that believes it covers a page the matcher never sends it is a
    // page with no gate at all.
    const mw = stripComments(read("src/middleware.ts"));
    const matcher = mw.match(/matcher:\s*\[([^\]]+)\]/)?.[1] ?? "";
    const declared = Array.from(matcher.matchAll(/"([^"]+)"/g)).map((m) => m[1]);
    expect([...declared].sort()).toEqual([...COOKIE_GATED_PATHS].sort());
  });
});

describe("the redirect cannot be turned into an open redirect", () => {
  it("round-trips a real gated path", () => {
    expect(cookieGateRedirect("/profile")).toBe(`${COOKIE_GATE_PATH}?required=1&next=%2Fprofile`);
    expect(safeNext("/profile")).toBe("/profile");
  });

  it("refuses anything that is not one of our own gated paths", () => {
    for (const hostile of [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "http://evil.example/path",
      "/welcome",
      "javascript:alert(1)",
      "",
      null,
      undefined,
    ]) {
      expect(safeNext(hostile as string | null)).toBeNull();
    }
  });

  it("an unknown source path simply carries no next", () => {
    expect(cookieGateRedirect("/some/other/page")).toBe(`${COOKIE_GATE_PATH}?required=1`);
  });
});

describe("the middleware actually enforces it, server-side", () => {
  const mw = stripComments(read("src/middleware.ts"));

  it("calls the shared predicate rather than re-deriving the rule", () => {
    expect(mw).toMatch(/hasEssentialAcknowledgement\(req\.headers\.get\("cookie"\)\)/);
    expect(mw).toMatch(/cookieGateRedirect\(pathname\)/);
  });

  it("checks the session FIRST, so a signed-out visitor still meets the product", () => {
    // Positions inside the FUNCTION BODY, not the file: the import statement
    // names the predicate at line 1 and would make this pass by accident.
    const body = mw.slice(mw.indexOf("export function middleware"));
    expect(body.indexOf("!hasSession")).toBeLessThan(
      body.indexOf("hasEssentialAcknowledgement")
    );
  });

  it("only gates signed-in requests", () => {
    expect(mw).toMatch(/if \(hasSession && isCookieGatedPath\(pathname\)\)/);
  });
});

describe("the required screen is honest about what it requires", () => {
  const gate = read("src/components/CookieGate.tsx");

  it("essential-only and accept-all are the same weight, same row", () => {
    // Same dark-pattern guard as the banner. Here it matters more: this is the
    // screen someone meets when they are blocked, which is the moment they are
    // most likely to tap whatever looks like the way out.
    const classesFor = (label: string) =>
      Array.from(gate.matchAll(new RegExp(`choose\\("${label}"[\\s\\S]{0,400}?className="([^"]+)"`, "g"))).map(
        (m) => m[1]
      );
    const essential = classesFor("reject-all");
    const accept = classesFor("accept-all");
    expect(essential.length).toBeGreaterThan(0);
    expect(accept.length).toBe(essential.length);
    for (let i = 0; i < essential.length; i++) expect(essential[i]).toBe(accept[i]);
  });

  it("neither is styled as the answer we would prefer", () => {
    const buttons = gate.slice(gate.indexOf('choose("reject-all"'), gate.indexOf("openCookiePanel"));
    expect(buttons).not.toMatch(/btn-primary/);
  });

  it("the return path goes through safeNext", () => {
    expect(gate).toMatch(/safeNext\(params\.get\("next"\)\)/);
  });

  it("it does not navigate away unless the cookie actually stuck", () => {
    // A browser with site data blocked entirely would otherwise bounce between
    // the gate and the middleware forever with nothing on screen explaining it.
    const code = stripComments(gate);
    expect(code).toMatch(/document\.cookie\.includes\("wd_cookie_prefs="\)/);
    expect(code).toMatch(/window\.location\.assign\(target\)/);
  });

  it("only renders when the middleware actually sent them", () => {
    expect(stripComments(gate)).toMatch(/if \(!required\) return null;/);
  });
});

describe("the optional categories stayed optional", () => {
  it("nothing in the manifest moved into 'necessary' to force it on", () => {
    // The cheap way to satisfy "mandatory cookies" would be to recategorise
    // analytics as necessary. That is the failure this pins.
    const manifest = read("src/lib/cookies/manifest.ts");
    expect(manifest).toMatch(/name: "wd_aid",[\s\S]{0,200}category: "analytics"/);
    expect(manifest).toMatch(/OPTIONAL_CATEGORIES[\s\S]{0,160}"preferences",\s*"analytics",\s*"marketing",/);
  });

  it("only the session cookie and the consent record are necessary", () => {
    const necessary = COOKIE_MANIFEST.filter((c) => c.category === "necessary").map((c) => c.name);
    expect([...necessary].sort()).toEqual(["wd_cookie_prefs", "wd_session"]);
  });
});
