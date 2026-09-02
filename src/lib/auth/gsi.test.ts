import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GSI_SRC, GsiLoadError, gsiButtonWidth, gsiLocale, gsiSrcFor, loadGsi, resetGsi } from "./gsi";

// WHY THIS FILE EXISTS
//
// The inline loader this replaced never settled when accounts.google.com was
// accepted-then-dropped (captive portal, blocked region, proxy black hole).
// Because the login page awaited it, everything after the await - including the
// only code that could have told the user anything - was never scheduled. So the
// two properties worth pinning are: it ALWAYS settles, and it never appends a
// second <script> no matter how many mounts race.

interface FakeScript {
  src: string;
  async?: boolean;
  defer?: boolean;
  listeners: Record<string, Array<() => void>>;
  addEventListener(type: string, fn: () => void): void;
  fire(type: string): void;
}

let appended: FakeScript[] = [];

function makeScript(): FakeScript {
  return {
    src: "",
    listeners: {},
    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn);
    },
    fire(type) {
      for (const fn of [...(this.listeners[type] ?? [])]) fn();
    },
  };
}

function installFakeDom() {
  appended = [];
  (globalThis as Record<string, unknown>).document = {
    head: {
      appendChild(node: FakeScript) {
        appended.push(node);
        return node;
      },
    },
    createElement: () => makeScript(),
    // The loader reuses a tag another mount already added; the fake reports the
    // ones that were actually appended.
    // PREFIX semantics, because the production selector is `script[src^="..."]`:
    // the tag now carries an `hl` locale, and a second mount in a different
    // language must still reuse the one tag rather than append a second SDK.
    // Modelling this as an exact match is how the stub used to pass while the
    // real DOM would have loaded Google's script twice.
    querySelector: (sel: string) =>
      sel.includes(GSI_SRC) ? (appended.find((s) => s.src.startsWith(GSI_SRC)) ?? null) : null,
  };
}

function publishApi() {
  (globalThis as Record<string, unknown>).google = {
    accounts: { id: { initialize: () => {}, renderButton: () => {} } },
  };
}

beforeEach(() => {
  resetGsi();
  vi.useFakeTimers();
  installFakeDom();
  delete (globalThis as Record<string, unknown>).google;
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as Record<string, unknown>).document;
  delete (globalThis as Record<string, unknown>).google;
  resetGsi();
});

describe("a provider script that never answers still settles", () => {
  it("rejects at the deadline instead of hanging forever", async () => {
    const p = loadGsi(8000);
    const seen = p.catch((e) => e);
    // The tag was appended and simply never fires load or error - the exact
    // stalled-connection case the old code could not survive.
    expect(appended).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(8000);
    const err = await seen;
    expect(err).toBeInstanceOf(GsiLoadError);
    expect((err as GsiLoadError).code).toBe("script-timeout");
    expect((err as GsiLoadError).message.length).toBeGreaterThan(0);
  });

  it("resolves with the API when the script loads in time", async () => {
    const p = loadGsi(8000);
    publishApi();
    appended[0].fire("load");
    await expect(p).resolves.toHaveProperty("accounts.id");
  });

  it("a tag that loads but leaves no API behind is a failure, not a success", async () => {
    // A content blocker serving an empty 200 used to crash the caller on
    // `accounts.id.initialize` instead of showing a message.
    const p = loadGsi(8000);
    const seen = p.catch((e) => e);
    appended[0].fire("load");
    const err = await seen;
    expect(err).toBeInstanceOf(GsiLoadError);
    expect((err as GsiLoadError).code).toBe("no-api");
  });

  it("a network error rejects immediately, before the deadline", async () => {
    const p = loadGsi(8000);
    const seen = p.catch((e) => e);
    appended[0].fire("error");
    const err = await seen;
    expect((err as GsiLoadError).code).toBe("script-error");
  });

  it("with no DOM at all it rejects rather than throwing synchronously", async () => {
    delete (globalThis as Record<string, unknown>).document;
    await expect(loadGsi(8000)).rejects.toBeInstanceOf(GsiLoadError);
  });
});

describe("one load, however many callers", () => {
  it("two concurrent mounts share one promise and one script tag", async () => {
    const a = loadGsi(8000);
    const b = loadGsi(8000);
    expect(a).toBe(b);
    expect(appended).toHaveLength(1);
    publishApi();
    appended[0].fire("load");
    await expect(a).resolves.toBeDefined();
    // A caller arriving after the API is live gets it without touching the DOM.
    await expect(loadGsi(8000)).resolves.toBeDefined();
    expect(appended).toHaveLength(1);
  });

  it("a remount after failure can retry - the rejection does not poison the memo", async () => {
    const first = loadGsi(8000);
    const failed = first.catch((e) => e);
    appended[0].fire("error");
    expect(await failed).toBeInstanceOf(GsiLoadError);

    const second = loadGsi(8000);
    expect(second).not.toBe(first);
    // It reuses the tag already in the document rather than piling up more.
    expect(appended).toHaveLength(1);
    publishApi();
    appended[0].fire("load");
    await expect(second).resolves.toBeDefined();
  });

  it("a timed-out load can still succeed on a later attempt", async () => {
    const first = loadGsi(1000);
    const failed = first.catch((e) => e);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await failed).toBeInstanceOf(GsiLoadError);

    publishApi();
    await expect(loadGsi(1000)).resolves.toBeDefined();
  });
});

describe("the button width is measured, never assumed", () => {
  it("clamps into the range Google accepts", () => {
    expect(gsiButtonWidth(240)).toBe(240);
    expect(gsiButtonWidth(120)).toBe(200);
    expect(gsiButtonWidth(900)).toBe(400);
  });

  it("never returns a width that would overflow a 320px viewport's content box", () => {
    // 320 viewport - 40 (main px-5) - 40 (card p-5) = 240 of usable width. The
    // old literal 320 broke 40px out of the card on each side.
    const container = 240;
    expect(gsiButtonWidth(container)!).toBeLessThanOrEqual(container);
  });

  it("returns nothing when the container has not been measured yet", () => {
    expect(gsiButtonWidth(0)).toBeUndefined();
    expect(gsiButtonWidth(Number.NaN)).toBeUndefined();
  });
});

describe("GSI speaks the APP's language, not the device's", () => {
  // The owner photographed an English app offering "Continuar com o Google".
  // GSI localises to the browser locale and nothing told it otherwise, so the
  // single control on the login page that is not ours was also the only one
  // that ignored the language selector.

  it("maps this app's language codes straight through", () => {
    for (const code of ["en", "es", "fr", "de", "it", "pt", "nl", "ru", "uk", "pl", "tr", "he"]) {
      expect(gsiLocale(code)).toBe(code);
    }
  });

  it("accepts a regional tag", () => {
    expect(gsiLocale("pt-BR")).toBe("pt-br");
    expect(gsiLocale("zh-Hant")).toBe("zh-hant");
  });

  it("falls back to English, NOT to the device, for anything unrecognisable", () => {
    // Falling back to the browser is the bug. An unknown code means we do not
    // know what to ask for, and English is the app's own default - the device's
    // guess is what produced Portuguese in an English app.
    for (const bad of ["", "   ", null, undefined, "english", "e", "../../evil", "en_US"]) {
      expect(gsiLocale(bad as string)).toBe("en");
    }
  });

  it("puts the locale on the script URL as hl", () => {
    expect(gsiSrcFor("he")).toBe(`${GSI_SRC}?hl=he`);
    expect(gsiSrcFor("nonsense")).toBe(`${GSI_SRC}?hl=en`);
  });

  it("loads the script in the requested language", async () => {
    installFakeDom();
    resetGsi();
    const p = loadGsi(1000, "he");
    publishApi();
    appended[0].fire("load");
    await p;
    expect(appended).toHaveLength(1);
    expect(appended[0].src).toBe(`${GSI_SRC}?hl=he`);
  });

  it("a second mount in another language reuses the ONE tag", async () => {
    // The memo means only the first load can carry `hl`; the per-button
    // `locale` option is what covers a later change. What must NOT happen is a
    // second copy of Google's SDK in the document.
    installFakeDom();
    resetGsi();
    const first = loadGsi(1000, "en");
    publishApi();
    appended[0].fire("load");
    await first;
    resetGsi(); // a remount, e.g. after switching language
    await loadGsi(1000, "he");
    expect(appended).toHaveLength(1);
  });
});
