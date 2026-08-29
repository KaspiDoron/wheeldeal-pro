import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { jsonRoute, routeFailureBody, safeReason, ROUTE_BUDGET_MS } from "./json-route";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// "COULDN'T REACH THE SERVER JUST NOW" - ABOUT A SERVER THAT ANSWERED.
//
// Tapping "Ask for price" showed a yellow banner blaming the traveller's
// connection. The connection was fine. `/api/outreach` awaits an LLM safety
// screen, Google Place Details, Supabase, the integrity ladder, the anti-ban
// guard and the WhatsApp host, and NONE of that was inside a try/catch or a
// time budget. Any throw became Next's HTML error page; outrunning the platform
// timeout became the gateway's HTML 504. Either way the browser's
// `await res.json()` threw, and the only catch arm in the component was the one
// written for being offline.
//
// Worst of all, one of those unguarded awaits ran AFTER the message had already
// left WhatsApp - the outbound bookkeeping insert - so a Supabase hiccup told
// the traveller the send had failed about a message the shop had received.

describe("a route's failure modes are part of its contract", () => {
  it("a thrown handler becomes JSON, with a status", async () => {
    const route = jsonRoute("Test route", async () => {
      throw new Error("supabase exploded");
    });
    const res = await route();
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("server-error");
    // `error` is COPY - the client renders it verbatim into a banner, so the
    // exception message goes in `detail`, which nothing displays.
    expect(body.error).toMatch(/broke on our side/i);
    expect(body.error).not.toMatch(/supabase exploded/);
    expect(body.detail).toMatch(/Test route: supabase exploded/);
  });

  it("a handler that outruns the budget becomes JSON, not a gateway HTML page", async () => {
    const route = jsonRoute(
      "Slow route",
      () => new Promise<Response>(() => {}), // never settles
      { budgetMs: 20 }
    );
    const res = await route();
    expect(res.status).toBe(504);
    const body = await res.json();
    expect(body.code).toBe("timeout");
    // The work is NOT cancelled, and the copy must not claim otherwise: for a
    // send route the message may already be in flight.
    expect(body.error).toMatch(/still working|not lost/i);
  });

  it("our budget fires before the platform's, or none of this matters", () => {
    // maxDuration is 60s and Cloud Run's request timeout is 300s. Whoever
    // answers FIRST decides the content type of the response, and it has to be
    // us - that is the entire point.
    expect(ROUTE_BUDGET_MS).toBeLessThan(60_000);
    expect(readCode("src/app/api/outreach/route.ts")).toMatch(/maxDuration = 60/);
  });

  it("...and the client's own backstop fires after ours", () => {
    // In the normal case the SERVER answers a slow send, with a body the UI can
    // explain. The client abort is only for a connection that died silently.
    for (const p of ["src/components/VendorCard.tsx", "src/app/page.tsx"]) {
      const send = readCode(p);
      expect(send, `${p} send has no explicit deadline`).toMatch(/timeoutMs: 50_000/);
    }
    expect(50_000).toBeGreaterThan(ROUTE_BUDGET_MS);
  });

  it("a successful handler is passed through untouched", async () => {
    const original = new Response(JSON.stringify({ sent: true }), { status: 200 });
    const route = jsonRoute("Fine route", async () => original);
    expect(await route()).toBe(original);
  });

  it("the failure body always carries the fields the client branches on", () => {
    expect(routeFailureBody("timeout", "x")).toEqual({
      ok: false,
      error: "x",
      transient: true,
      code: "timeout",
    });
    expect(routeFailureBody("server-error", "x", "why").detail).toBe("why");
  });

  it("a reason never carries a stack trace or an unbounded body", () => {
    const e = new Error("a".repeat(500));
    expect(safeReason(e).length).toBeLessThanOrEqual(200);
    expect(safeReason(new Error("line\n\tmore  spaces"))).toBe("line more spaces");
    expect(safeReason(undefined)).toBe("unknown error");
  });
});

describe("the send route is wrapped, and bookkeeping cannot fail a delivered send", () => {
  it("POST goes through jsonRoute", () => {
    const r = readCode("src/app/api/outreach/route.ts");
    expect(r).toMatch(/export const POST = jsonRoute\("Sending your message", handlePost\)/);
    expect(r).toMatch(/async function handlePost\(req: Request\)/);
  });

  it("the outbound log insert can no longer throw out of the handler", () => {
    const r = readCode("src/app/api/outreach/route.ts");
    // This is the one that ran AFTER the message had left. Its protection is
    // sbInsert's own no-reject contract, CHECKED as a boolean (the Wave-0
    // fix) - so pin the checked form, not a .catch that would be dead code.
    const i = r.indexOf('const wroteLog = await sbInsert("whatsapp_messages"');
    expect(i).toBeGreaterThan(-1);
    // ...and the loss is reported rather than swallowed, by an insert that is
    // itself throw-proof.
    expect(r.slice(i)).toMatch(/kind: "outbound-log-failed"[\s\S]{0,700}\]\)\.catch\(/);
    expect(r).toMatch(/logged,/);
  });
});
