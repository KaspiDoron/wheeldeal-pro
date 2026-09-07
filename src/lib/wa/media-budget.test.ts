// AUDIT F047 - the inbound media ladder is bounded by a WALL CLOCK, not by an
// attempt count.
//
// fetchMediaWithRetry counted only its sleeps ("0+2s+5s" = 7s, the figure the
// turn-wall derivation in agent-loop.ts used). Each attempt is a REQUEST, and
// fetchMediaBase64 swallows evoFetch's 12s abort as a plain null, so a host
// that does not answer bought 12+2+12+5+12 = 43s - spent BEFORE the inbound
// slot and therefore entirely outside processVendorReply's 72s wall. Against
// Cloud Run's --timeout 90 the request is killed mid-turn and the shop's photo
// sits behind the 10-minute inbound claim lease.
//
// EXECUTED against the real ladder on a fake clock: the stage stops instead of
// re-probing a host that is not answering, an attempt already in flight is
// never cut short (a slow but SUCCEEDING price board still arrives), and a
// fast transient failure is still retried - which is why the ladder exists.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("../runtime-config", async () => {
  const h = await import("../privacy/postgrest-store.test-helper");
  return h.runtimeConfigMock();
});

let attempts = 0;
let media: (attempt: number) => Promise<{ mime: string; base64: string } | null>;

vi.mock("@/lib/evolution", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    fetchMediaBase64: async () => {
      attempts += 1;
      return media(attempts);
    },
  };
});

import { fetchMediaWithRetry } from "./ingest";

const PHOTO = { mime: "image/jpeg", base64: "x".repeat(200) };
/** An attempt that burns evoFetch's full 12s abort and yields null. */
const unanswered = () =>
  new Promise<null>((resolve) => setTimeout(() => resolve(null), 12_000));

beforeEach(() => {
  attempts = 0;
  media = async () => null;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function runLadder(): Promise<{
  result: { mime: string; base64: string } | null;
  elapsedMs: number;
}> {
  const startedAt = Date.now();
  let finishedAt = startedAt;
  const pending = fetchMediaWithRetry("traveller@example.com", { key: { id: "M1" } }).then(
    (r) => {
      finishedAt = Date.now();
      return r;
    }
  );
  await vi.advanceTimersByTimeAsync(120_000);
  return { result: await pending, elapsedMs: finishedAt - startedAt };
}

describe("EXECUTED (F047): the media stage cannot outrun its budget", () => {
  it("a host that does not answer is not re-probed three times", async () => {
    media = unanswered;
    const { result, elapsedMs } = await runLadder();
    expect(result).toBeNull();
    // Before the fix: 3 attempts and 43s of request time inside the webhook.
    expect(attempts).toBe(1);
    expect(elapsedMs).toBeLessThanOrEqual(20_000);
  });

  it("a slow but SUCCEEDING download is never cut short", async () => {
    // The exact case the retry exists for: a large price board on a loaded
    // host. The budget decides whether the NEXT attempt may start, never
    // whether an attempt in flight may finish - so this must still read.
    media = () =>
      new Promise((resolve) => setTimeout(() => resolve(PHOTO), 11_500));
    const { result, elapsedMs } = await runLadder();
    expect(result).toEqual(PHOTO);
    expect(attempts).toBe(1);
    expect(elapsedMs).toBeLessThanOrEqual(12_000);
  });

  it("a fast transient failure is still retried - the whole point of the ladder", async () => {
    media = async (n) => (n < 3 ? null : PHOTO);
    const { result, elapsedMs } = await runLadder();
    expect(result).toEqual(PHOTO);
    expect(attempts).toBe(3);
    // 0 + 2s + 5s of backoff, unchanged.
    expect(elapsedMs).toBe(7_000);
  });

  it("one slow attempt still leaves room for a fast second one", async () => {
    media = async (n) => (n === 1 ? null : PHOTO);
    const { result } = await runLadder();
    expect(result).toEqual(PHOTO);
    expect(attempts).toBe(2);
  });
});
