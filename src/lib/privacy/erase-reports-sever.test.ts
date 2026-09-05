import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT F057: ERASE DISCARDED disconnectInstance's RESULT AND REPORTED A CLEAN
// SEVER OVER A STILL-LIVE WHATSAPP LINK.
//
// eraseUserData did `await disconnectInstance(email).catch(() => false)` and
// dropped the value; EraseResult had no field for it. When every Evolution
// logout+delete failed (a host past its 12s abort, or EVOLUTION_HOSTS
// unreadable so getHosts() is []) the walker still deleted wa_sessions - the
// app's only record that the instance exists - and both routes answered 200
// "erased" while the Baileys socket and its credentials stayed live on the
// host, with a transient copy of every message on the person's number still
// landing in the Evolution database.
//
// Executed against the REAL disconnectInstance and the REAL walker, with the
// Evolution host stubbed at fetch and a Map-backed store: a failed sever is
// NAMED, the account row survives for the retry, and the wa_sessions row is
// kept so that retry can still find the link. A deployment where the person
// never linked (no hosts, no wa_sessions row) is a real success with nothing
// to sever - it must NOT start failing every self-serve erase.

vi.mock("../runtime-config", async () => {
  const h = await import("./postgrest-store.test-helper");
  return h.runtimeConfigMock();
});

import { store } from "./postgrest-store.test-helper";
import { disconnectInstance } from "../evolution";
import { eraseUserData } from "./erase";

const EMAIL = "linked@example.com";

type Host = "up" | "down" | "absent";
const evo: { host: Host; calls: string[] } = { host: "up", calls: [] };

beforeEach(() => {
  store.reset();
  evo.calls = [];
  evo.host = "up";
  store.seed("app_users", [{ email: EMAIL, status: "active", plan: "free", provider: "email" }]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://evo.test/")) {
        evo.calls.push(`${init?.method ?? "GET"} ${url.slice("https://evo.test".length)}`);
        if (evo.host === "down") throw new Error("ECONNRESET");
        if (evo.host === "absent") return new Response('{"status":404}', { status: 404 });
        return new Response('{"status":"SUCCESS"}', { status: 200 });
      }
      // Anything else (Storage deletes and the like) is out of scope here.
      return new Response("{}", { status: 200 });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function configureEvolution() {
  store.config.set("EVOLUTION_API_URL", "https://evo.test");
  store.config.set("EVOLUTION_API_KEY", "test-key");
}

describe("EXECUTED (F057): disconnectInstance says whether the link is actually gone", () => {
  it("a linked person whose host is unreachable is NOT severed, and the link record is kept", async () => {
    configureEvolution();
    evo.host = "down";
    store.seed("wa_sessions", [{ email: EMAIL, instance_name: "wd-x", status: "open" }]);

    const r = await disconnectInstance(EMAIL);
    expect(r.severed).toBe(false);
    expect(r.hostsTried).toBe(1);
    expect(evo.calls.some((c) => c.startsWith("DELETE /instance/delete/"))).toBe(true);
    // The wa_sessions row is the only thing that lets a retry find the
    // instance again - deleting it would make the next attempt "succeed".
    expect(store.rows("wa_sessions")).toHaveLength(1);
  });

  it("a host that confirms the delete severs, and the app drops its own record of the link", async () => {
    configureEvolution();
    store.seed("wa_sessions", [{ email: EMAIL, instance_name: "wd-x", status: "open" }]);
    const r = await disconnectInstance(EMAIL);
    expect(r.severed).toBe(true);
    expect(store.rows("wa_sessions")).toHaveLength(0);
  });

  it("a host that answers 'no such instance' counts as severed (nothing left to tear down)", async () => {
    configureEvolution();
    evo.host = "absent";
    store.seed("wa_sessions", [{ email: EMAIL, instance_name: "wd-x", status: "close" }]);
    const r = await disconnectInstance(EMAIL);
    expect(r.severed).toBe(true);
  });

  it("no hosts configured and never linked is a real success with nothing to sever", async () => {
    const r = await disconnectInstance(EMAIL);
    expect(r.severed).toBe(true);
    expect(r.hostsTried).toBe(0);
  });

  it("no hosts reachable through the vault while the app's own record shows a link is NOT severed", async () => {
    // EVOLUTION_HOSTS unreadable -> getHosts() is [] - but wa_sessions says
    // this person linked, so the instance may well be live somewhere.
    store.seed("wa_sessions", [{ email: EMAIL, instance_name: "wd-x", status: "open" }]);
    const r = await disconnectInstance(EMAIL);
    expect(r.severed).toBe(false);
    expect(r.hostsTried).toBe(0);
  });
});

describe("EXECUTED (F057): the erase walker reports the sever like any other purge", () => {
  it("a failed sever is NAMED, the account row survives, and the link record is deferred for the retry", async () => {
    configureEvolution();
    evo.host = "down";
    store.seed("wa_sessions", [{ email: EMAIL, instance_name: "wd-x", status: "open" }]);

    const result = await eraseUserData(EMAIL);
    // THE ASSERTIONS THAT FAILED BEFORE: failed was [] and the account was gone.
    expect(result.failed).toContain("whatsapp:link");
    expect(result.userDeleted).toBe(false);
    expect(result.linkSevered).toBe(false);
    expect(store.rows("app_users")).toHaveLength(1);
    expect(store.rows("wa_sessions"), "the retry must still be able to find the link").toHaveLength(1);
  });

  it("a confirmed sever lets the erase complete", async () => {
    configureEvolution();
    store.seed("wa_sessions", [{ email: EMAIL, instance_name: "wd-x", status: "open" }]);
    const result = await eraseUserData(EMAIL);
    expect(result.linkSevered).toBe(true);
    expect(result.failed).toEqual([]);
    expect(result.userDeleted).toBe(true);
    expect(store.rows("wa_sessions")).toHaveLength(0);
  });

  it("a person who never linked on a deployment without Evolution can still erase themselves", async () => {
    const result = await eraseUserData(EMAIL);
    expect(result.linkSevered).toBe(true);
    expect(result.failed).toEqual([]);
    expect(result.userDeleted).toBe(true);
  });
});
