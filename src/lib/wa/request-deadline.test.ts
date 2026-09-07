// AUDIT F062 - one webhook request, ONE deadline.
//
// The inbound budget note (inbound-gate.ts) derived 12s of gate patience plus a
// 72s turn wall against Cloud Run's 90s ceiling and called the sum real because
// the gate and the turn are sequential. They are - but so are the two media
// stages that run BEFORE either of them, in the same request: the burst
// leader's own download ladder and then one sequential fetch per sibling
// frame, each bottoming out in Evolution's 12s abort. A three-frame price
// board on a cold host spent ~67s before withInboundSlot was even entered, and
// the turn then started a fresh 72s wall. Cloud Run killed the request
// mid-turn, the inbound claim kept its ten-minute lease, and the shop's price
// board went unanswered for roughly nineteen minutes.
//
// These tests EXECUTE the three clipped stages.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

const ATTEMPT_MS = 12_000; // evoFetch's hard per-request abort
const attempts: string[] = [];
let attemptCost = ATTEMPT_MS;

vi.mock("@/lib/evolution", () => ({
  fetchMediaBase64: async (_email: string, data: unknown) => {
    attempts.push(JSON.stringify(data ?? null).slice(0, 40));
    // An unanswering host: the abort fires, and fetchMediaBase64 swallows it
    // into a plain null - indistinguishable from "no media" to the caller.
    vi.advanceTimersByTime(attemptCost);
    return null;
  },
}));
// The burst rows the coalescer discovers. F4 is the newest frame, so it is the
// burst leader and F1-F3 are the siblings it fetches sequentially.
const BASE_MS = 1_800_000_000_000;
const burstRows = [1, 2, 3, 4].map((n) => ({
  id: n,
  wa_message_id: `F${n}`,
  received_at: new Date(BASE_MS - (4 - n) * 500).toISOString(),
  type: "image",
  raw: { media: { key: { id: `F${n}` }, kind: "image" } },
}));

vi.mock("../runtime-config", () => ({
  sbSelect: async (table: string) => (table === "whatsapp_messages" ? burstRows : []),
  sbInsert: async () => true,
}));

import { fetchMediaWithRetry } from "./ingest";
import { assembleImageBurst } from "./image-burst";
import { withInboundSlot, resetInboundGate } from "./inbound-gate";

beforeEach(() => {
  attempts.length = 0;
  attemptCost = ATTEMPT_MS;
  vi.useFakeTimers();
  vi.setSystemTime(new Date(BASE_MS));
  resetInboundGate();
});
afterEach(() => {
  vi.useRealTimers();
  resetInboundGate();
});

describe("the media ladder is clipped to what the request has left", () => {
  it("never starts an attempt the request cannot pay for", async () => {
    const media = await fetchMediaWithRetry("t@example.com", { key: { id: "M1" } }, Date.now() + 5_000);
    expect(media).toBeNull();
    expect(
      attempts.length,
      "a 12s download must not be started with 5s of request budget left"
    ).toBe(0);
  });

  it("still retries a transient failure when there IS budget", async () => {
    // The retry exists because a lost price-list photo is a lost offer; the
    // clip must not turn a fast transient failure into a single attempt.
    attemptCost = 0; // expired media: the host answers "nothing here" at once
    const p = fetchMediaWithRetry("t@example.com", { key: { id: "M2" } }, Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(10_000); // the 0 + 2s + 5s backoff ladder
    await p;
    expect(attempts.length).toBe(3);
  });
});

describe("the burst sibling loop is bounded", () => {
  async function assemble(mediaDeadlineAt?: number) {
    const fetched: string[] = [];
    const verdict = await assembleImageBurst({
      email: "t@example.com",
      fromDigits: "66812340001",
      // The NEWEST frame is the burst leader; the others are its siblings.
      ownMsgId: "F4",
      fetchOwn: async () => ({ mime: "image/jpeg", base64: "AAAA" }),
      fetchByKey: async (key) => {
        fetched.push(String((key as { id?: string })?.id));
        vi.advanceTimersByTime(ATTEMPT_MS);
        return { mime: "image/jpeg", base64: "BBBB" };
      },
      sleep: async () => {},
      mediaDeadlineAt,
    });
    return { verdict, fetched };
  }

  it("stops fetching siblings once the request media window is spent", async () => {
    const { verdict, fetched } = await assemble(Date.now() + 14_000);
    expect(verdict.standDown).toBe(false);
    expect(
      fetched.length,
      "three sequential 12s sibling fetches ran past the request ceiling"
    ).toBe(1);
    // The frames that were not fetched are reported, never silently dropped -
    // that is what keeps the media-fetch-failed breadcrumb honest.
    if (!verdict.standDown) expect(verdict.fetchFailures).toBe(2);
  });

  it("fetches every sibling when the window allows it", async () => {
    const { fetched } = await assemble(Date.now() + 120_000);
    expect(fetched.length).toBe(3);
  });
});

describe("the inbound gate's patience is clipped too", () => {
  it("proceeds ungated instead of waiting out a patience the request cannot afford", async () => {
    vi.useRealTimers();
    // Fill every slot with work that outlives this test.
    const held: Array<() => void> = [];
    for (let i = 0; i < 4; i++) {
      void withInboundSlot(() => new Promise<void>((r) => held.push(r)));
    }
    await new Promise((r) => setTimeout(r, 20));
    const startedAt = Date.now();
    let ran = false;
    await withInboundSlot(async () => {
      ran = true;
    }, 0);
    const waited = Date.now() - startedAt;
    for (const release of held) release();
    expect(ran).toBe(true);
    expect(
      waited,
      "a waiter with no request budget left must not sit on the 12s patience"
    ).toBeLessThan(1_000);
  }, 30_000);
});
