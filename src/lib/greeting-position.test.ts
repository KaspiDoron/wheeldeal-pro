import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("server-only", () => ({}));

// W4.7 - THE GREETINGS (owner report 5, item 3).
//
// "The ai agents keep writing 'Hi' every new message in a single thread which
// makes the shop think it's an automatic bot; writing hi or hello more than one
// time is not humanize behavior."
//
// The field screenshots show "Hi", "Hi there!" and "Hey there!" in ONE thread,
// and that was not three composers being warm - it was ONE function rolling
// dice. `humanizeVariant` matched a leading greeting and substituted a
// DIFFERENT random one on every send; it never removed one, and it had no
// notion of where in a thread it was.
//
// Every "never greet again" mechanism that DID exist was built into the graph
// engine and the legacy loop - the two engines that engine-route.ts demoted to
// failover. SPTE, the engine that actually answers shops, had none of it: no
// strip, no post-rail, no prompt rule, and its own `momentum` template opened
// with a hard-coded "Hi again!".

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const readCode = (p: string) => stripComments(readFileSync(join(process.cwd(), p), "utf8"));

const chatMock = vi.hoisted(() => ({ fn: vi.fn(async (): Promise<string | null> => null) }));
vi.mock("./ai", () => ({
  chat: (...args: unknown[]) => chatMock.fn(...(args as [])),
  extractJson: <T,>(s: string): T | null => {
    try {
      return JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1)) as T;
    } catch {
      return null;
    }
  },
}));
// A PROGRAMMABLE database, not a constant one (W4.7b). The position tests below
// used to be readFileSync + regex over wa-guard's source - which is why the
// HIGH bug lived in `hasMessagedShopBefore` for a whole release WITH those
// tests green: a source pin locks a string, and the defect was in what the
// string DID with a row it found. `db.rows(table, query)` lets a test stand a
// real row up (including the null-last_sent_at row that reproduced the owner's
// screenshot) and EXECUTE the derivation against it. Returning null models an
// unreadable read, which sbSelectStrict reports as {error:"unavailable"}.
const db = vi.hoisted(() => ({
  rows: (_table: string, _query: string): Record<string, unknown>[] | null => [],
}));
vi.mock("./runtime-config", () => ({
  sbSelect: vi.fn(async (t: string, q: string) => db.rows(t, q) ?? []),
  sbSelectStrict: vi.fn(async (t: string, q: string) => {
    const r = db.rows(t, q);
    return r === null ? { error: "unavailable" as const } : { rows: r };
  }),
  sbInsert: vi.fn(async () => true),
  sbUpdate: vi.fn(async () => true),
  sbDelete: vi.fn(async () => true),
  sbDeleteReturning: vi.fn(async () => []),
  sbInsertClaim: vi.fn(async () => "won" as const),
  getConfig: vi.fn(async () => undefined),
  getConfigExact: vi.fn(async () => undefined),
  // The kill switch reads FRESH (never cached) - unset here, so the guard runs
  // its normal path rather than the "everything is halted" one.
  getConfigFresh: vi.fn(async () => ({ value: undefined })),
  setConfig: vi.fn(async () => ({ ok: true, persistent: true })),
  supabaseConfigured: () => true,
  pgTimestamp: (d: Date) => d.toISOString(),
}));

import { hasLeadingGreeting, stripLeadingGreeting } from "./copy/greeting";
import { guardOutbound, hasMessagedShopBefore, humanizeForOutbound, humanizeVariant } from "./wa-guard";
import { stripGreeting } from "./orchestrator";
import { recheckMessage } from "./wa/recheck-message";
import { voiceDirectives, voiceProfileFor } from "./voice";
import { compileStyleDirectives } from "./copy/promptCompiler";
import { openerSeed } from "./copy/matrix";
import { localizeMessage } from "./agents";

describe("the greeting definition itself", () => {
  it('strips "X again!" as ONE phrase - the two nudge templates opened that way', () => {
    // THE BUG: the old alternation matched the bare "Hi" and left the adverb
    // behind as a sentence of its own.
    expect(stripLeadingGreeting("Hi again! Just checking in - any chance on 250?")).toBe(
      "Just checking in - any chance on 250?"
    );
    expect(stripLeadingGreeting("Hello again, is 250/day still available?")).toBe(
      "Is 250/day still available?"
    );
    // ...and the old regex's actual output, so a regression is unmistakable.
    expect(stripLeadingGreeting("Hi again! Planning my trip")).not.toMatch(/^Again/);
  });

  it("has a RIGHT BOUNDARY - a word that merely starts with a greeting survives", () => {
    // The old `\s*[!,.]*\s*` tail could match EMPTY, so "Hitting" -> "Tting".
    expect(stripLeadingGreeting("Hitting the road tomorrow - do you have a 125?")).toBe(
      "Hitting the road tomorrow - do you have a 125?"
    );
    expect(stripLeadingGreeting("Hollandaise")).toBe("Hollandaise");
    expect(hasLeadingGreeting("Hitting the road")).toBe(false);
  });

  it("removes the everyday English openers, and never strips to nothing", () => {
    for (const [input, want] of [
      ["Hi there! Do you have a scooter?", "Do you have a scooter?"],
      ["Hey there, is 250 ok?", "Is 250 ok?"],
      ["Good morning! Any chance on 220?", "Any chance on 220?"],
      ["Hello - what is your best rate?", "What is your best rate?"],
    ] as const) {
      expect(stripLeadingGreeting(input)).toBe(want);
    }
    // A bare greeting is a poor message; a blank one is a lost turn.
    expect(stripLeadingGreeting("Hi!")).toBe("Hi!");
  });

  it("reads a LOCAL greeting too - the localizer writes those, not English ones", () => {
    // The second line of defence. The first is telling localizeMessage not to
    // write one at all (see the localize test below); this catches the case
    // where a localized opener is re-sent into an already-open thread.
    expect(stripLeadingGreeting("สวัสดีครับ มีรถว่างไหมครับ")).toBe("มีรถว่างไหมครับ");
    expect(stripLeadingGreeting("Hola! Me puedes hacer 300 al día?")).toBe(
      "Me puedes hacer 300 al día?"
    );
    expect(hasLeadingGreeting("Xin chào, có xe không?")).toBe(true);
  });

  it("the orchestrator's validator repair is the SAME definition", () => {
    expect(stripGreeting("Hi again! Just checking in")).toBe(stripLeadingGreeting("Hi again! Just checking in"));
  });

  // -------------------------------------------------------------------------
  // W4.7b - the three holes the 45-agent audit walked straight through. Every
  // case below was EXECUTED against the old module and came out untouched.
  // -------------------------------------------------------------------------

  it("strips to a FIXED POINT - a doubled or mixed opener is not half-repaired", () => {
    // The old loop visited each pattern exactly once with a non-global replace,
    // so one greeting came off and the next one shipped.
    for (const [input, want] of [
      ["Hi! Hi there, any chance on 250?", "Any chance on 250?"],
      ["Hello! Good morning - is 250 ok?", "Is 250 ok?"],
      // THE REALISTIC ONE: exactly what localizeMessage produces when it half
      // obeys "do NOT leave ANY English words" - a Thai greeting in front of
      // the English one the strip was supposed to have removed.
      ["สวัสดีครับ Hi, ลด 250 ได้ไหม", "ลด 250 ได้ไหม"],
    ] as const) {
      expect(stripLeadingGreeting(input)).toBe(want);
      expect(hasLeadingGreeting(stripLeadingGreeting(input))).toBe(false);
    }
    // ...and a message that is ONLY greetings still never becomes empty.
    expect(stripLeadingGreeting("Hi! Hello! Hey!").trim()).not.toBe("");
  });

  it("a leading EMOJI does not defeat the rail - SPTE asks for a warm register", () => {
    // Both patterns were anchored at `^\s*`, so any leading emoji, quote or
    // zero-width character bypassed them AND made hasLeadingGreeting() answer
    // false - no strip, and no detector upstream firing either. personaHumanize
    // adds emoji, so this is ordinary output, not a corner case.
    for (const input of [
      "👋 Hi there! Any chance on 250?",
      "😊 Hey! ok so 250 works?",
      "​ Hello! and does that include the helmet?",
      '"Hi there, any chance on 250?',
    ]) {
      expect(hasLeadingGreeting(input)).toBe(true);
      expect(hasLeadingGreeting(stripLeadingGreeting(input))).toBe(false);
      expect(stripLeadingGreeting(input)).not.toBe(input);
    }
    // A bare wave repeated on every message is the same tell as a bare "Hi".
    expect(hasLeadingGreeting("👋 Any chance on 250?")).toBe(true);
    // ...and an emoji that is NOT a greeting, with no greeting behind it, is
    // left completely alone.
    expect(stripLeadingGreeting("🙏 that would really help me out")).toBe(
      "🙏 that would really help me out"
    );
  });

  it("knows the greeting forms people actually type", () => {
    for (const input of ["Hiya!", "Morning!", "Howdy,", "Greetings!", "Hullo there,", "G'day!"]) {
      expect(hasLeadingGreeting(input), input).toBe(true);
    }
    // A weak form (an ordinary noun that is only a greeting as an opener) must
    // NOT eat a real sentence.
    expect(hasLeadingGreeting("Morning traffic is bad - can I pick it up at 9?")).toBe(false);
    expect(stripLeadingGreeting("Evening rides are fine for me")).toBe("Evening rides are fine for me");
  });

  it("covers every market the country map localizes into - by construction", async () => {
    // region.ts routes Khmer, Lao and Burmese shops to the localizer, and the
    // old short list had never heard of any of them: three real scooter-rental
    // markets with a PROMPT as their first line of defence and NOTHING as their
    // second. The table is now typed Record<LocalizedCountry, ...>, so this
    // walks the same map the localizer uses.
    const { LOCALIZED_COUNTRIES } = await import("./copy/region");
    const { LOCAL_GREETINGS } = await import("./copy/greeting");
    const { isEnglishSpeaking } = await import("./locale");
    for (const country of LOCALIZED_COUNTRIES) {
      const greetings = LOCAL_GREETINGS[country];
      expect(greetings, country).toBeDefined();
      if (isEnglishSpeaking(country)) continue; // the English rail IS the coverage
      expect(greetings.length, country).toBeGreaterThan(0);
      for (const g of greetings) {
        // Every listed form must be recognised by the pattern built from it -
        // an entry that the regex cannot match is a market that only LOOKS
        // covered.
        expect(hasLeadingGreeting(`${g}, 250?`), `${country}: ${g}`).toBe(true);
      }
    }
    // The three the audit named, end to end.
    expect(stripLeadingGreeting("សួស្ដី តម្លៃប៉ុន្មាន?")).toBe("តម្លៃប៉ុន្មាន?");
    expect(stripLeadingGreeting("ສະບາຍດີ ລາຄາເທົ່າໃດ?")).toBe("ລາຄາເທົ່າໃດ?");
    expect(stripLeadingGreeting("မင်္ဂလာပါ ဈေးဘယ်လောက်လဲ")).toBe("ဈေးဘယ်လောက်လဲ");
  });
});

describe("the send-time choke point knows where in the thread it is", () => {
  const RAW = "Hi there! Could you do 250 per day? Best regards";

  it("MID-THREAD: the greeting is removed and never rolled in again", () => {
    // The reported defect, executed: three consecutive mid-thread sends.
    const sends = [
      "Hi there! Just checking in - any chance on that better rate?",
      "Hey there! ok so 250 works for me?",
      "Hello! and does that include the helmet?",
    ].map((t) => humanizeForOutbound("u@example.com", "66812345678", t, { firstOutbound: false }));
    for (const out of sends) expect(hasLeadingGreeting(out)).toBe(false);
    // ...and the default is the safe one: a caller that says nothing at all
    // must never manufacture a greeting.
    expect(hasLeadingGreeting(humanizeForOutbound("u@example.com", "66812345678", RAW))).toBe(false);
  });

  it("FIRST OUTBOUND: the greeting stays, and the pool still varies it", () => {
    const out = humanizeForOutbound("u@example.com", "66812345678", RAW, { firstOutbound: true });
    expect(hasLeadingGreeting(out)).toBe(true);
    // Forty cold openers must not share one first word: the swap fires here.
    const pool = new Set(
      ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com", "f@x.com", "g@x.com"].map((k) =>
        humanizeForOutbound(k, "66812345678", RAW, { firstOutbound: true }).slice(0, 6)
      )
    );
    expect(pool.size).toBeGreaterThan(1);
  });

  it('never produces the "Hey there! again!" artifact from an "X again" opener', () => {
    // The swap used to match only the leading "Hi " of "Hi again!" and put a
    // WHOLE greeting in its place - on every single momentum/recheck send.
    for (let i = 0; i < 20; i++) {
      const rand = () => i / 20;
      const out = humanizeVariant("Hi again! Any chance on 250?", rand, { firstOutbound: true });
      // "Hey there! again!" / "Hello! again!" - a greeting glued to the orphan
      // adverb. The negative lookahead in the swap regex is what prevents it.
      expect(out).not.toMatch(/\b(hi|hey|hello)\b[^.!?]*!\s*again/i);
      expect(out).toBe("Hi again! Any chance on 250?");
    }
  });

  it("stays deterministic per (sender, shop, text, position) - the park contract", () => {
    const a = humanizeForOutbound("u@example.com", "+66 81 234 5678", RAW, { firstOutbound: false });
    const b = humanizeForOutbound("u@example.com", "66812345678", RAW, { firstOutbound: false });
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// W4.7b - THE DERIVATION ITSELF, EXECUTED.
//
// These three tests replace source pins (readFileSync + regex over wa-guard's
// text). They were rewritten, not deleted: the intent - "guardOutbound derives
// the position, no caller is trusted with it, and an unreadable answer must not
// manufacture a greeting" - is unchanged; only the METHOD is. A source pin
// cannot fail on the bug that was actually shipped, and did not: the last line
// of `hasMessagedShopBefore` read `return Boolean(row.last_sent_at)`, so a
// recipient row that exists with a NULL last_sent_at (the shop wrote first, a
// send failed and stamped the row, the best-effort upsert lost its timestamp)
// answered "we have NEVER messaged this shop" MID-THREAD. The message then kept
// its greeting AND was re-rolled through GREETING_SWAP_POOL, which is exactly
// the owner's "Hi" / "Hi there!" / "Hey there!" screenshot.
// ---------------------------------------------------------------------------

const recipientQuery = (t: string, q: string) => t === "wa_recipient_state" && q.includes("select=id");
const outboundQuery = (t: string, q: string) =>
  t === "whatsapp_messages" && q.includes("direction=eq.outbound");

describe("hasMessagedShopBefore - what actually proves a thread is open", () => {
  afterEach(() => {
    db.rows = () => [];
  });

  it("A ROW WITH NO last_sent_at IS STILL A THREAD (the reproduced defect)", async () => {
    db.rows = (t, q) => (recipientQuery(t, q) ? [{ id: 7, last_sent_at: null }] : []);
    // Was `false` - a confident "never messaged" derived from a missing
    // timestamp. Absence of a timestamp is not absence of a message.
    expect(await hasMessagedShopBefore("u@example.com", "66812345678")).toBe(true);
  });

  it("no row, but an outbound in the ledger, is still a thread", async () => {
    // recordOutboundSend's recipient upsert is best-effort inside a try/catch;
    // the message row is the durable half of the same event.
    db.rows = (t, q) => (outboundQuery(t, q) ? [{ id: 1 }] : []);
    expect(await hasMessagedShopBefore("u@example.com", "66812345678")).toBe(true);
  });

  it("no row and no outbound is the ONLY shape that means 'never written'", async () => {
    db.rows = () => [];
    expect(await hasMessagedShopBefore("u@example.com", "66812345678")).toBe(false);
  });

  it("an unreadable database answers UNKNOWN, never 'first'", async () => {
    db.rows = () => null; // sbSelectStrict -> {error:"unavailable"}
    expect(await hasMessagedShopBefore("u@example.com", "66812345678")).toBe(null);
    // ...and an unreadable LEDGER after a readable empty recipient table is
    // unknown too - a half-answer is not an answer.
    db.rows = (t, q) => (recipientQuery(t, q) ? [] : null);
    expect(await hasMessagedShopBefore("u@example.com", "66812345678")).toBe(null);
  });

  it("reads only BASE-schema columns and matches the number tail-tolerantly", async () => {
    // The two properties the old source pin was protecting, asserted through
    // the query the function actually issues: no post-migration column (a 400
    // would turn every thread into "unknown" at once), and `numberFilter`, so
    // discovery's spelling of the number and WhatsApp's find the same row.
    const seen: string[] = [];
    db.rows = (t, q) => {
      if (t === "wa_recipient_state") seen.push(q);
      return [];
    };
    await hasMessagedShopBefore("u@example.com", "+66 81 234 5678");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/select=id/);
    expect(seen[0]).not.toMatch(/first_intro_at|opted_out_at|to_tail|last_error_at/);
    expect(seen[0]).toMatch(/&or=\(to_number\.eq\./);
  });
});

describe("guardOutbound derives the position - no caller is trusted with it", () => {
  const MID = "Hi there! Just checking in - any chance on that better rate?";
  afterEach(() => {
    db.rows = () => [];
  });

  it("a mid-thread send is NOT greeted, even when the caller insists it is new", async () => {
    // The exact end-to-end shape of the owner's report: the mass route's
    // `isNewIntro` says "new", the recipient row says otherwise, and the row
    // wins - with the null last_sent_at that used to defeat it.
    db.rows = (t, q) => (recipientQuery(t, q) ? [{ id: 7, last_sent_at: null }] : []);
    const v = await guardOutbound({
      senderKey: "u@example.com",
      toDigits: "66812345678",
      text: MID,
      auto: true,
      firstOutbound: true, // a caller's stale opinion
    });
    expect(hasLeadingGreeting(v.text)).toBe(false);
  });

  it("a genuine first contact KEEPS its greeting", async () => {
    db.rows = () => []; // no recipient row, no outbound ledger row
    const v = await guardOutbound({
      senderKey: "u@example.com",
      toDigits: "66812345678",
      text: "Hi there! I'm in town and need a scooter for 3 days. Best price?",
      auto: true,
    });
    expect(hasLeadingGreeting(v.text)).toBe(true);
  });

  it("an unreadable database with a silent caller never manufactures a greeting", async () => {
    db.rows = () => null;
    const v = await guardOutbound({
      senderKey: "u@example.com",
      toDigits: "66812345678",
      text: MID,
      auto: true, // no firstOutbound hint at all
    });
    expect(hasLeadingGreeting(v.text)).toBe(false);
  });

  it("a PARKED row is re-decided at send time, not frozen at park time", async () => {
    // The mass route freezes a caller-computed `isNewIntro` into the parked
    // body and the drain re-guards with alreadyHumanized:true. That flag means
    // "do not re-roll the variance" - it must not also mean "keep a greeting
    // this thread has already had". Positive evidence only: with the thread
    // demonstrably open, the deterministic strip runs.
    const parked = humanizeForOutbound("u@example.com", "66812345678", MID, { firstOutbound: true });
    expect(hasLeadingGreeting(parked)).toBe(true);
    db.rows = (t, q) => (recipientQuery(t, q) ? [{ id: 7, last_sent_at: null }] : []);
    const v = await guardOutbound({
      senderKey: "u@example.com",
      toDigits: "66812345678",
      text: parked,
      auto: true,
      alreadyHumanized: true,
    });
    expect(hasLeadingGreeting(v.text)).toBe(false);
    // ...and it is STILL the parked text otherwise - the variance was not
    // re-rolled (that is what would break the idempotency slot hash), and
    // re-guarding the same row twice yields the same bytes.
    const again = await guardOutbound({
      senderKey: "u@example.com",
      toDigits: "66812345678",
      text: parked,
      auto: true,
      alreadyHumanized: true,
    });
    expect(again.text).toBe(v.text);
    expect(parked.endsWith(v.text.slice(-20))).toBe(true);
  });

  it("an unreadable database leaves a parked body VERBATIM", async () => {
    // No positive evidence -> no rewrite. Two drainers that disagree about a
    // transient read must never produce two different payload hashes.
    const parked = humanizeForOutbound("u@example.com", "66812345678", MID, { firstOutbound: true });
    db.rows = () => null;
    const v = await guardOutbound({
      senderKey: "u@example.com",
      toDigits: "66812345678",
      text: parked,
      auto: true,
      alreadyHumanized: true,
    });
    expect(v.text).toBe(parked);
  });
});

describe("the hard-coded greeting sources are closed", () => {
  it("the re-check message no longer opens with one", () => {
    // W6.1: the composer now REFUSES an incomplete deal (no price, deposit or
    // fulfillment = no message at all), so the second assertion is that there
    // is no sentence to greet with rather than a greetingless one.
    const m = recheckMessage({
      pricePerDay: 400,
      currency: "PHP",
      days: 5,
      depositType: "cash",
      depositAmount: 2000,
      fulfillment: "pickup",
    });
    expect(hasLeadingGreeting(m!)).toBe(false);
    expect(m).not.toMatch(/again/i);
    expect(recheckMessage({ pricePerDay: null, currency: "PHP" })).toBeNull();
  });

  it("SPTE's own momentum template no longer opens with one", () => {
    // The PRIMARY engine's nudge - the one that actually runs.
    //
    // W4.7b: the literal is still LOCATED by reading the source (`templateFor`
    // is module-private and its TurnContext is a far heavier fixture than this
    // assertion is worth), but the ASSERTION now EXECUTES the real definition
    // against the template's own text instead of grepping for a shape. A
    // source pin passes against any string that merely does not say "Hi
    // again!"; this fails against every greeting the rail knows, including the
    // ones the audit found the old regex blind to.
    const pass = readCode("src/lib/spte/pass.ts");
    const momentum = pass.match(/`(Just checking in[^`]*)`/)?.[1];
    expect(momentum, "the momentum template moved - relocate this test").toBeTruthy();
    expect(hasLeadingGreeting(momentum!.replace(/\$\{[^}]*\}/g, "3 days"))).toBe(false);
    expect(momentum).not.toMatch(/again/i);
    // ...and no OTHER template in the primary engine opens with one either.
    //
    // EVERY BACKTICK LITERAL, not just the ones after `return`. Most templates
    // are now drawn from a seeded FAMILY - an array of alternatives - so the
    // old `return \`...\`` shape stopped covering the very strings that vary,
    // which is exactly where a greeting would sneak back in unnoticed. A
    // broader sweep is the point of the widening, not a side effect of it.
    for (const t of pass.match(/`[^`]+`/g) ?? []) {
      const text = t.slice(1, -1).replace(/\$\{[^}]*\}/g, "3 days");
      if (!/[a-z]{3}/i.test(text)) continue; // keys, urls, join separators
      expect(hasLeadingGreeting(text), text).toBe(false);
    }
  });

  it("the per-turn style directive no longer NAMES a greeting to the model", () => {
    // The dead branch: `s.greeting === ""` was never true (neither pool has an
    // empty entry), so this always named one and then asked for it not to be
    // written verbatim - on composers that are mid-conversation by definition.
    const d = compileStyleDirectives(openerSeed("u@example.com", "v1", "b1"), "Philippines");
    expect(d).toMatch(/MID-CONVERSATION/);
    expect(d).not.toMatch(/in the spirit of/);
    expect(d).not.toMatch(/to your greeting/);
    expect(readCode("src/lib/copy/promptCompiler.ts")).not.toMatch(/s\.greeting === ""/);
    // Still deterministic per seed - the anti-fingerprinting contract holds.
    expect(d).toBe(compileStyleDirectives(openerSeed("u@example.com", "v1", "b1"), "Philippines"));
  });

  it("the voice persona stops claiming a greeting habit mid-conversation", () => {
    const v = voiceProfileFor("u@example.com");
    expect(voiceDirectives(v)).toContain(v.greeting); // the OPENER keeps it
    const mid = voiceDirectives(v, { greeting: false });
    expect(mid).toMatch(/MID-CONVERSATION/);
    expect(mid).not.toMatch(/usually opens with/);
    // ...and composeBargain asks for the mid-conversation form whenever the
    // thread has history - the same condition that adds the "no greeting" rule.
    expect(readCode("src/lib/agents.ts")).toMatch(/greeting: !opts\.history/);
  });

  it("the LOCALIZER is told the position, so it cannot re-add one", async () => {
    // Rule 1 of the localize prompt used to order a local greeting
    // unconditionally - which put back, in Thai, exactly what the English strip
    // had just removed.
    chatMock.fn.mockResolvedValue(
      JSON.stringify({ message: "ลดเหลือ 250 ได้ไหมครับ", english: "can you do 250?" })
    );
    await localizeMessage("Could you do 250 a day?", "Thailand", undefined, true, { greet: false });
    const midPrompt = JSON.stringify(chatMock.fn.mock.calls[0]);
    expect(midPrompt).toContain("MID-CONVERSATION");
    expect(midPrompt).not.toContain("use a natural LOCAL greeting instead");

    chatMock.fn.mockClear();
    await localizeMessage("Could you do 250 a day?", "Thailand");
    expect(JSON.stringify(chatMock.fn.mock.calls[0])).toContain("use a natural LOCAL greeting");
  });

  it("every localize call site declares a thread position", () => {
    // STILL A SOURCE PIN, deliberately (W4.7b). The other position tests were
    // converted to execution because the behaviour they claimed to cover lives
    // in functions a test can call. This one asserts WIRING in four route/engine
    // modules - the thing being checked IS the presence of an argument at a
    // call site, and executing those four would mean standing up a request, a
    // session and an LLM per assertion. The rail that catches a WRONG answer
    // from any of them is executed above (guardOutbound derives the position
    // itself and no caller is trusted with it).
    //
    // SPTE only ever runs INSIDE an open thread, so it is statically false.
    expect(readCode("src/lib/spte/live.ts")).toMatch(/greet: false/);
    // The graph engine knows from its own prior-outbound list.
    expect(readCode("src/lib/graph/engine.ts")).toMatch(
      /greet: input\.priorOutbound\.length === 0/
    );
    // The opener routes derive it: a SECOND search reaching a shop we already
    // messaged opens a fresh greeting inside an existing WhatsApp thread.
    expect(readCode("src/app/api/outreach/mass/route.ts")).toMatch(/greet: firstOutbound/);
    expect(readCode("src/app/api/outreach/route.ts")).toMatch(
      /greet: kind === "rfq" && established === null/
    );
  });
});
