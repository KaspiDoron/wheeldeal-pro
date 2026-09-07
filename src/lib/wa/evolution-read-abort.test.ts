// AUDIT F044 - a transport abort is not an empty chat.
//
// findMessagesRecords tries three body shapes because Evolution's findMessages
// dialect varies by version. It never looked at the response STATUS, so
// evoFetch's own 12s abort ({ ok:false, status:0 }) was indistinguishable from
// "this shape returned no rows" and the loop bought three 12s aborts - 36s per
// JID, 72s once a second candidate JID is tried - inside the traveller's
// /api/replies poll and inside the ping's recovery sweep. resolveChatJid had
// the same shape: a directory probe that never reached WhatsApp was followed
// by a second 12s abort on /chat/findChats.
//
// EXECUTED against the real readers on a fake clock, with the Evolution host
// stubbed to accept the connection and never answer.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("../runtime-config", async () => {
  const h = await import("../privacy/postgrest-store.test-helper");
  return h.runtimeConfigMock();
});

import { store } from "../privacy/postgrest-store.test-helper";
import { fetchMessagesRaw, resolveChatJid } from "../evolution";
// Loaded up front: a DYNAMIC import cannot resolve while the clock is faked,
// and resolveChatJid reaches the alias store before it touches the transport.
import "./lid-alias";
import "./phone-key";

const EMAIL = "reader@example.com";
const JID = "66811111111@s.whatsapp.net";

let calls: string[] = [];
/** Every request hangs until evoFetch's own AbortController fires. */
let answer: ((path: string) => Response | null) | null = null;

beforeEach(() => {
  store.reset();
  calls = [];
  answer = null;
  store.config.set("EVOLUTION_API_URL", "https://evo.test");
  store.config.set("EVOLUTION_API_KEY", "test-key");
  store.seed("wa_sessions", [
    { email: EMAIL, instance_name: "wd-reader", status: "open", host_url: "https://evo.test" },
  ]);
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url.replace("https://evo.test", ""));
      const canned = answer?.(url);
      if (canned) return Promise.resolve(canned);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    })
  );
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function timed<T>(work: Promise<T>): Promise<{ value: T; elapsedMs: number }> {
  const startedAt = Date.now();
  let finishedAt = startedAt;
  const pending = work.then((v) => {
    finishedAt = Date.now();
    return v;
  });
  await vi.advanceTimersByTimeAsync(240_000);
  return { value: await pending, elapsedMs: finishedAt - startedAt };
}

const hits = (fragment: string) => calls.filter((c) => c.includes(fragment)).length;

describe("EXECUTED (F044): an unanswering host costs ONE abort, not three", () => {
  it("findMessages stops on a transport abort instead of trying the next body shape", async () => {
    const { value, elapsedMs } = await timed(fetchMessagesRaw(EMAIL, JID, 10));
    expect(value).toEqual([]);
    // Before the fix: three shapes, 36s of request time inside the poll.
    expect(hits("/chat/findMessages/")).toBe(1);
    expect(elapsedMs).toBeLessThanOrEqual(12_000);
  });

  it("...but a host that ANSWERS still gets every dialect tried", async () => {
    // The shape loop exists because Evolution's body shape varies by version:
    // a 4xx/5xx DID answer, and is exactly the rejection the fallback is for.
    let shape = 0;
    answer = (url) => {
      if (!url.includes("/chat/findMessages/")) return null;
      shape += 1;
      if (shape < 3) return new Response('{"error":"bad request"}', { status: 400 });
      return new Response(
        JSON.stringify([{ key: { id: "A", remoteJid: JID }, message: { conversation: "700 baht" } }]),
        { status: 200 }
      );
    };
    const { value } = await timed(fetchMessagesRaw(EMAIL, JID, 10));
    expect(hits("/chat/findMessages/")).toBe(3);
    expect(value.map((m) => m.text)).toEqual(["700 baht"]);
  });

  it("resolveChatJid does not pay a second abort on the chat list", async () => {
    const { value, elapsedMs } = await timed(resolveChatJid(EMAIL, "66811111111"));
    // The guess, unmemoised, exactly as before - reached in one abort.
    expect(value).toBe("66811111111@s.whatsapp.net");
    expect(hits("/chat/whatsappNumbers/")).toBe(1);
    expect(hits("/chat/findChats/")).toBe(0);
    expect(elapsedMs).toBeLessThanOrEqual(12_000);
  });

  it("...and still falls through to the chat list when the probe ANSWERED", async () => {
    answer = (url) => {
      if (url.includes("/chat/whatsappNumbers/")) return new Response("[]", { status: 200 });
      if (url.includes("/chat/findChats/"))
        return new Response(
          JSON.stringify([{ remoteJid: "66811111111@s.whatsapp.net" }]),
          { status: 200 }
        );
      return null;
    };
    const { value } = await timed(resolveChatJid(EMAIL, "66811111111"));
    expect(hits("/chat/findChats/")).toBe(1);
    expect(value).toBe("66811111111@s.whatsapp.net");
  });
});
