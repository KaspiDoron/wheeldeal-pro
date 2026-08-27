import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

import { kickDispatcher, KICK_SETTLE_MS } from "./kick";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// THE REPLY LANE WAS STARTED BY A GHOST.
//
// Inbound arrives -> ingest parks a reply -> ingest kicks /api/wa/reply-tick,
// which claims that sender and drains it within seconds. That last step was
// `fetch(url).catch(() => {})`, un-awaited, with the webhook's response flushed
// immediately afterwards.
//
// Cloud Run (deployed here WITHOUT --no-cpu-throttling) freezes the container's
// CPU the instant a response is flushed. A fetch that has not finished its
// handshake at that moment does not "continue in the background" - it stops.
// So the dispatcher whose entire job is sub-30s replies was frequently never
// invoked, and the parked reply waited for whatever poked the server next: the
// owner opening the app.
//
// The evidence that this is a known failure mode is in the repo: the activity
// route awaits its drain and explains why, and tick/reply-tick each sleep 350ms
// before returning so their OWN self-chain call can leave. Only the kick that
// starts the lane was never given the same treatment.

describe("a kick has to actually leave the instance", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("waits for the call rather than firing and forgetting", async () => {
    let resolveFetch: (() => void) | null = null;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((res) => {
          resolveFetch = () => res(new Response("ok"));
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    let done = false;
    const p = kickDispatcher("http://x/api/wa/reply-tick", 5_000).then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    // Still in-flight: the caller has NOT returned, so the instance is still
    // alive and the request is still on the wire.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(done).toBe(false);

    // Annotated at the call site: TS narrows `resolveFetch` to `never` here
    // because the only assignment is inside a callback it cannot order.
    (resolveFetch as (() => void) | null)?.();
    await p;
    expect(done).toBe(true);
  });

  it("but never holds the webhook open for a working dispatcher", async () => {
    // reply-tick deliberately works in-process for up to ~45s. We only need the
    // request to have left, so the settle window - not the response - bounds us.
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const started = Date.now();
    await kickDispatcher("http://x/api/wa/reply-tick", 60);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("a refused or unreachable dispatcher never throws at the caller", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))));
    await expect(kickDispatcher("http://x/api/wa/tick", 50)).resolves.toBeUndefined();
  });

  it("the default settle window is short enough to be invisible", () => {
    expect(KICK_SETTLE_MS).toBeLessThanOrEqual(2_000);
    expect(KICK_SETTLE_MS).toBeGreaterThanOrEqual(500);
  });

  it("EXECUTED: fires with cache:no-store so Next 14 cannot serve the kick from its Data Cache (OR11 H2.3)", async () => {
    // Every kick is a GET to a fixed self URL; Next 14 caches GETs by default,
    // so without no-store the SECOND kick of a shape is answered from cache and
    // the dispatcher never runs. Assert the option reaches fetch.
    const fetchMock = vi.fn(() => Promise.resolve(new Response("ok")));
    vi.stubGlobal("fetch", fetchMock);
    await kickDispatcher("http://x/api/wa/reply-tick", 50);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://x/api/wa/reply-tick",
      expect.objectContaining({ cache: "no-store" })
    );
  });
});

describe("every inbound path uses it", () => {
  it("REPRODUCTION: the Evolution ingest kick is awaited, not detached", () => {
    const ingest = readCode("src/lib/wa/ingest.ts");
    expect(ingest).toMatch(/await Promise\.all\(kicks\.map\(\(url\) => kickDispatcher\(url\)\)\)/);
    // The exact pattern that could not survive the response boundary.
    expect(ingest).not.toMatch(/fetch\(\s*`\$\{origin\}\/api\/wa\/(reply-)?tick/);
  });

  it("the Cloud API webhook now kicks the per-sender reply lane too", () => {
    // It only ever kicked the ONE global tick - the runner a cold introductions
    // batch keeps permanently busy, which is the whole reason the per-sender
    // lane exists. A reply on this channel queued behind the batch every time.
    const route = readCode("src/app/api/webhooks/whatsapp/route.ts");
    expect(route).toMatch(/kickDispatcher\(\s*`\$\{origin\}\/api\/wa\/reply-tick\?token=\$\{token\}&sender=/);
    expect(route).toMatch(/kickDispatcher\(`\$\{origin\}\/api\/wa\/tick\?token=\$\{token\}&hop=0`\)/);
    expect(route).not.toMatch(/fetch\(`\$\{origin\}\/api\/wa\/tick/);
  });

  it("and the status poll's own drain no longer evaporates at the response", () => {
    const status = readCode("src/app/api/wa/status/route.ts");
    expect(status).toMatch(/await bounded\(\s*drainOutbox\(/);
    expect(status).toMatch(/await bounded\(\s*drainGraphWakeups\(/);
  });
});
