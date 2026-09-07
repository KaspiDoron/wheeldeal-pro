import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

import { finishBeforeResponse } from "../after";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// "THE TEST BUTTON WORKS" AND "PUSHES ARRIVE" WERE TWO DIFFERENT FACTS.
//
// Every automatic push in the app - shop replied, price improved, risk flag,
// takeover, WhatsApp disconnected - was fired from inside
// `void (async () => { ... })()`: started deliberately off the critical path,
// never awaited. On Cloud Run that is not "in the background", it is "until the
// response is flushed", and the CPU is throttled to ~0 at exactly that moment.
// The push stops wherever it happens to be.
//
// The one path the owner could test by hand - /api/push/test - IS awaited, so
// the manual check passed while the real notifications were a coin flip.

describe("after-work is awaited, bounded, and never fatal", () => {
  it("waits for the work rather than detaching it", async () => {
    let done = false;
    await finishBeforeResponse("t", async () => {
      await new Promise((r) => setTimeout(r, 30));
      done = true;
    });
    expect(done).toBe(true);
  });

  it("abandons work that outruns its budget instead of holding the webhook", async () => {
    const started = Date.now();
    await finishBeforeResponse("t", () => new Promise(() => {}), 60);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("a thrown error never reaches the caller", async () => {
    await expect(
      finishBeforeResponse("t", async () => {
        throw new Error("push service down");
      })
    ).resolves.toBeUndefined();
  });
});

describe("every automatic push now survives the response", () => {
  it("REPRODUCTION: no detached push IIFEs are left in the reply path", () => {
    const loop = readCode("src/lib/agent-loop.ts");
    expect(loop).not.toMatch(/void \(async \(\) => \{/);
    expect(loop).toMatch(/finishBeforeResponse\("reply-push"/);
    expect(loop).toMatch(/finishBeforeResponse\("risk-screen"/);
    expect(loop).toMatch(/finishBeforeResponse\("inbound-gloss"/);
  });

  it("...nor in ingest", () => {
    const ingest = readCode("src/lib/wa/ingest.ts");
    expect(ingest).not.toMatch(/void \(async \(\) => \{/);
    expect(ingest).toMatch(/finishBeforeResponse\("ingest-push"/);
    expect(ingest).toMatch(/finishBeforeResponse\("wa-disconnected-push"/);
  });

  it("...nor in SPTE, the engine that actually answers shops (audit F039)", () => {
    // This invariant only read agent-loop.ts and ingest.ts, so the primary
    // engine's own "your best price just fell through" push - a bare
    // `void (async () => ...)()` around a Supabase read and an https request -
    // was never covered by the rule its doctrine file describes.
    const live = readCode("src/lib/spte/live.ts");
    expect(live).not.toMatch(/void \(async \(\) => \{/);
    expect(live).toMatch(/finishBeforeResponse\(\s*"lost-best-push"/);
  });

  it("and the push itself cannot hang: web-push gets an explicit timeout", () => {
    // web-push sets an https timeout ONLY when the option is passed. Awaiting
    // the push (above) is only safe because one dead endpoint is cut loose.
    const push = readCode("src/lib/push.ts");
    expect(push).toMatch(/timeout: PUSH_TIMEOUT_MS/);
    expect(push).not.toMatch(/sendNotification\(\s*\{ endpoint: s\.endpoint[\s\S]{0,120}?\n\s*data\n\s*\);/);
  });
});

describe("the one push that skipped the gate no longer does", () => {
  it("the hotel-request push is judged and counted like every other", () => {
    // It called sendPushToUser directly: no significance check, no budget
    // spend, no markPushSent. A thread that kept landing on that transition
    // buzzed every single time, and the 4-per-window ceiling that makes the
    // other pushes bearable was understated by exactly these sends.
    const engine = readCode("src/lib/graph/engine.ts");
    const block = engine.slice(
      engine.indexOf("awaitingUserLocation === true"),
      engine.indexOf("awaitingUserLocation === true") + 1600
    );
    expect(block).toMatch(/worthAnInterruption\(/);
    expect(block).toMatch(/markPushSent\(/);
    expect(block).toMatch(/finishBeforeResponse\("location-push"/);
  });
});

describe("a push has somewhere to go", () => {
  it("shop pushes carry the shop, not just the app", () => {
    const loop = readCode("src/lib/agent-loop.ts");
    expect(loop).toMatch(/url: ctx\.vendorId \? `\/\?shop=\$\{encodeURIComponent\(ctx\.vendorId\)\}` : "\/"/);
    const ingest = readCode("src/lib/wa/ingest.ts");
    expect(ingest).toMatch(/url: `\/\?from=\$\{encodeURIComponent\(from\)\}`/);
  });

  it("and the app opens that shop once the hunt is restored", () => {
    const page = readCode("src/app/page.tsx");
    expect(page).toMatch(/pendingShopRef\.current = deepShop/);
    expect(page).toMatch(/params\.get\("shop"\) \|\| params\.get\("from"\)/);
    // Held until there is something to open - the restore is asynchronous.
    expect(page).toMatch(/if \(!want \|\| vendors\.length === 0\) return;/);
    expect(page).toMatch(/setDashboardFor\(target\)/);
  });
});
