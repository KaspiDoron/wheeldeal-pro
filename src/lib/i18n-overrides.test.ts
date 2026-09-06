import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

// The store is a single app_config row per language, so the fake is one map of
// key -> raw JSON string. That is exactly the substrate the real code sees.
const store: Record<string, string> = {};
let readThrows = false;
let writeOk = true;

vi.mock("./runtime-config", () => ({
  getConfigExact: vi.fn(async (name: string) => {
    if (readThrows) throw new Error("supabase down");
    return store[name];
  }),
  // The writer's strict reader (audit F196): a failed read is a refusal, not
  // an empty dictionary. The executed cases live in
  // i18n-overrides-write-refusal.test.ts; this mock only keeps the suite
  // honest about which reader setOverride goes through.
  getConfigExactStrict: vi.fn(async (name: string) => {
    if (readThrows) return { error: "unavailable" as const };
    return { value: store[name] };
  }),
  setConfig: vi.fn(async (name: string, value: string) => {
    if (!writeOk) return { ok: false, persistent: false, error: "no vault" };
    store[name] = value;
    return { ok: true, persistent: true };
  }),
}));

import {
  overrideKey,
  readOverrides,
  applyOverrides,
  setOverride,
  MAX_OVERRIDES_PER_LANG,
  MAX_OVERRIDE_CHARS,
} from "./i18n-overrides";

const readCode = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  readThrows = false;
  writeOk = true;
});

// A MACHINE TRANSLATION THAT READS WRONG USED TO NEED A DEPLOY TO FIX.
//
// The owner could change the English source (which changes it for everyone) or
// ship code. These tests pin the third option, and above all the one property
// that makes it durable: the correction does not live in the row the translator
// rewrites after every sweep.

describe("overrides live in their OWN row - the whole design decision", () => {
  it("the correction row is not the machine cache row", () => {
    expect(overrideKey("he")).toBe("I18N_OVERRIDE_he");
    expect(overrideKey("he")).not.toBe("I18N_he");
  });

  it("a correction is never written into I18N_<lang>", async () => {
    store["I18N_he"] = JSON.stringify({ Next: "הבא" });
    await setOverride("he", "Next", "קדימה");
    // The machine cache is untouched, so the translator's own
    // {...latest, ...cached} rewrite cannot destroy the correction.
    expect(JSON.parse(store["I18N_he"])).toEqual({ Next: "הבא" });
    expect(JSON.parse(store["I18N_OVERRIDE_he"])).toEqual({ Next: "קדימה" });
  });

  it("a machine sweep that rewrites the whole cache leaves corrections standing", async () => {
    await setOverride("he", "Next", "קדימה");
    // Simulate the translator's write: the entire machine row is replaced.
    store["I18N_he"] = JSON.stringify({ Next: "הבא", Back: "אחורה" });
    const overrides = await readOverrides("he");
    expect(applyOverrides(JSON.parse(store["I18N_he"]), overrides).Next).toBe("קדימה");
  });
});

describe("precedence", () => {
  it("the owner's correction beats the machine translation", () => {
    expect(applyOverrides({ Next: "machine" }, { Next: "human" }).Next).toBe("human");
  });

  it("a correction applies to a string the machine never translated", () => {
    // The most wanted case: the string failed validation and is showing
    // English, which is precisely when a human wants to write the answer.
    expect(applyOverrides({}, { Bargain: "התמקח" }).Bargain).toBe("התמקח");
  });

  it("machine entries with no correction survive untouched", () => {
    const out = applyOverrides({ Next: "a", Back: "b" }, { Next: "c" });
    expect(out).toEqual({ Next: "c", Back: "b" });
  });

  it("it is pure - neither input is mutated", () => {
    const machine = { Next: "a" };
    const over = { Next: "b" };
    applyOverrides(machine, over);
    expect(machine).toEqual({ Next: "a" });
    expect(over).toEqual({ Next: "b" });
  });
});

describe("reading is total - an unreadable row is an empty one", () => {
  it("no row at all reads as no corrections", async () => {
    expect(await readOverrides("he")).toEqual({});
  });

  it("a throwing vault degrades to the machine translation, not to an error", async () => {
    readThrows = true;
    await expect(readOverrides("he")).resolves.toEqual({});
  });

  it("unparseable JSON reads as empty", async () => {
    store["I18N_OVERRIDE_he"] = "{not json";
    expect(await readOverrides("he")).toEqual({});
  });

  it("an array is rejected - only an object is a dictionary", async () => {
    store["I18N_OVERRIDE_he"] = JSON.stringify(["a", "b"]);
    expect(await readOverrides("he")).toEqual({});
  });

  it("non-string and blank values are dropped rather than rendered", async () => {
    store["I18N_OVERRIDE_he"] = JSON.stringify({ a: 1, b: null, c: "   ", d: "ok" });
    expect(await readOverrides("he")).toEqual({ d: "ok" });
  });
});

describe("writing", () => {
  it("an empty text CLEARS the correction - the revert verb", async () => {
    await setOverride("he", "Next", "קדימה");
    const res = await setOverride("he", "Next", "");
    expect(res).toEqual({ ok: true, count: 0 });
    expect(await readOverrides("he")).toEqual({});
  });

  it("whitespace-only text clears too, so a cleared field is not a blank string", async () => {
    await setOverride("he", "Next", "קדימה");
    await setOverride("he", "Next", "   ");
    expect(await readOverrides("he")).toEqual({});
  });

  it("clearing a correction that was never set is not an error", async () => {
    expect(await setOverride("he", "Next", "")).toEqual({ ok: true, count: 0 });
  });

  it("an empty source string is refused - there is nothing to correct", async () => {
    const res = await setOverride("he", "  ", "text");
    expect(res.ok).toBe(false);
  });

  it("read-modify-write keeps the other corrections", async () => {
    await setOverride("he", "Next", "1");
    await setOverride("he", "Back", "2");
    expect(await readOverrides("he")).toEqual({ Next: "1", Back: "2" });
  });

  it("a correction longer than the cap is refused, not truncated", async () => {
    const res = await setOverride("he", "Next", "x".repeat(MAX_OVERRIDE_CHARS + 1));
    expect(res.ok).toBe(false);
    expect(await readOverrides("he")).toEqual({});
  });

  it("a failed vault write is reported, never swallowed as success", async () => {
    writeOk = false;
    const res = await setOverride("he", "Next", "קדימה");
    expect(res.ok).toBe(false);
  });

  it("languages do not share a row", async () => {
    await setOverride("he", "Next", "קדימה");
    await setOverride("fr", "Next", "Suivant");
    expect(await readOverrides("he")).toEqual({ Next: "קדימה" });
    expect(await readOverrides("fr")).toEqual({ Next: "Suivant" });
  });
});

describe("the ceiling is real", () => {
  it("a NEW correction past the ceiling is refused", async () => {
    const full: Record<string, string> = {};
    for (let i = 0; i < MAX_OVERRIDES_PER_LANG; i++) full[`s${i}`] = `v${i}`;
    store["I18N_OVERRIDE_he"] = JSON.stringify(full);
    const res = await setOverride("he", "one-more", "nope");
    expect(res.ok).toBe(false);
  });

  it("EDITING an existing correction at the ceiling still works", async () => {
    // Otherwise a full language becomes unfixable, which is the opposite of
    // what the ceiling is for.
    const full: Record<string, string> = {};
    for (let i = 0; i < MAX_OVERRIDES_PER_LANG; i++) full[`s${i}`] = `v${i}`;
    store["I18N_OVERRIDE_he"] = JSON.stringify(full);
    const res = await setOverride("he", "s0", "edited");
    expect(res).toEqual({ ok: true, count: MAX_OVERRIDES_PER_LANG });
  });

  it("clearing at the ceiling frees a slot", async () => {
    const full: Record<string, string> = {};
    for (let i = 0; i < MAX_OVERRIDES_PER_LANG; i++) full[`s${i}`] = `v${i}`;
    store["I18N_OVERRIDE_he"] = JSON.stringify(full);
    await setOverride("he", "s0", "");
    expect((await setOverride("he", "one-more", "yes")).ok).toBe(true);
  });
});

describe("the translate route honours the corrections", () => {
  const route = readCode("src/app/api/translate/route.ts");

  it("a corrected string is NOT re-sent to the model", () => {
    // Re-translating it would spend tokens re-deriving an answer a human has
    // already overruled, and would cache the machine's version underneath.
    // (Since the shared scope landed, the filter runs per scope - the
    // override exclusion must hold for BOTH the catalogue and the FAQ rows.)
    expect(route).toMatch(
      /const missing = scope\.texts\.filter\(\(t\) => !cached\[t\] && !overrides\[t\]\)/
    );
  });

  it("EVERY return path applies the overrides", () => {
    // The no-AI-provider path and the normal path built the response map
    // inline, and only one of them was updated the last two times this shape
    // changed. One helper is the fix - used on the no-AI early return AND on
    // the per-scope merge that feeds the single final return, so a new scope
    // cannot forget the corrections.
    const uses = route.match(/pickTranslated\(scope\.texts, applyOverrides\(cached, overrides\)\)/g) ?? [];
    expect(uses.length).toBe(2);
    // The final response serves ONLY the merged, override-applied map.
    expect(route).toMatch(/return NextResponse\.json\(\{\s*\n\s*map: mapOut,/);
  });

  it("corrections need no AI provider to serve", () => {
    // They are already stored; a missing key must not hide them.
    const noAi = route.slice(route.indexOf("if (!(await aiEnabled()))"));
    expect(noAi.slice(0, 400)).toMatch(/applyOverrides\(cached, overrides\)/);
  });

  it("the machine cache is still read and written by its own keys only", () => {
    expect(route).toMatch(/cacheKey: `I18N_\$\{lang\}`/);
    expect(route).toMatch(/cacheKey: `I18N_SHARED_\$\{lang\}`/);
    expect(route).not.toMatch(/I18N_OVERRIDE/);
  });
});

describe("the admin route", () => {
  const route = readCode("src/app/api/admin/i18n/route.ts");

  it("both verbs are management-gated", () => {
    const gates = route.match(/await requireManagement\(\)/g) ?? [];
    expect(gates.length).toBe(2);
  });

  it("English is refused - the source string is edited in the code", () => {
    expect(route).toMatch(/lang === "en"/);
    expect(route).toMatch(/English is the source language/);
  });

  it("it does not import the client i18n module into the server bundle", () => {
    expect(route).not.toMatch(/from "@\/lib\/i18n"/);
  });

  it("it ships the machine counterpart so a correction is judgeable", () => {
    expect(route).toMatch(/machineFor/);
  });
});
