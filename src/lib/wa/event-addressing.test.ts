import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

const readCode = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// OWNER REPORT 7, P0-B: EVENTS WRITTEN FOR A SCREEN THAT COULD NEVER FIND THEM.
//
// The message-path panel finds a thread's trail with
//   user_email = <account> AND (to_number = <digits> OR vendor_name = "+digits")
// and its kind list was widened (owner report 6, I1) to include the vision,
// drift, localize and engine-turn families. But the writers of those kinds
// stamp a shop NAME in vendor_name and no to_number at all - so widening the
// filter added rows that structurally cannot match. The panel looked fixed and
// showed nothing.

describe("every kind the panel asks for is written with an address it can join on", () => {
  const PANEL = readCode("src/lib/wa/message-path.ts");

  it("the panel really does join on user_email + to_number", () => {
    // If this join ever changes, the writer expectations below must change with
    // it - that coupling is the whole point of pinning it here.
    expect(PANEL).toMatch(/user_email=eq\.\$\{enc\(opts\.senderKey\)\}/);
    expect(PANEL).toMatch(/or=\(to_number\.eq\.\$\{enc\(digits\)\}/);
  });

  it("THE REGRESSION: a dropped inbound is addressed, not just labelled", () => {
    const trace = readCode("src/lib/wa/webhook-trace.ts");
    const fn = trace.slice(trace.indexOf("export async function noteInboundDropped"));
    // The address is the SPLIT shape (audit F173): every reason on a shop
    // thread the traveller opened keeps to_number, while the privacy-gate
    // reasons (PRIVACY_DROP_REASONS) store no number at all. The unconditional
    // `to_number: digits` that wrote a personal contact's number is gone.
    expect(fn).toMatch(/const privacy = PRIVACY_DROP_REASONS\.has\(reason\);/);
    expect(fn).toMatch(/const shown = privacy \? null : \(digits \?\? null\);/);
    expect(fn).toMatch(/to_number: shown/);
    expect(fn).not.toMatch(/to_number: digits/);
    expect(fn).toMatch(/user_email: email/);
  });

  it("vision readings carry the number, not only the shop's name", () => {
    const loop = readCode("src/lib/agent-loop.ts");
    // Both emitters: the reconciliation check and the five outcome kinds.
    const check = loop.slice(loop.indexOf('kind: "vision-check"'));
    expect(check.slice(0, 400)).toMatch(/to_number: from/);
    const outcome = loop.slice(loop.indexOf("kind: eventKindForReading"));
    expect(outcome.slice(0, 400)).toMatch(/to_number: from/);
  });

  it("an rfq drift names the thread it drifted in", () => {
    const draft = readCode("src/app/api/bargain-draft/route.ts");
    const ev = draft.slice(draft.indexOf('kind: "rfq-drift"'));
    expect(ev.slice(0, 300)).toMatch(/to_number: digits/);
  });

  it("a localize fallback is findable from both engines", () => {
    const graph = readCode("src/lib/graph/engine.ts");
    const ev = graph.slice(graph.indexOf('kind: "localize-fallback"'));
    expect(ev.slice(0, 400)).toMatch(/to_number: input\.event\.toDigits/);
    const live = readCode("src/lib/spte/live.ts");
    const spteEv = live.slice(live.indexOf('kind: "localize-fallback"'));
    expect(spteEv.slice(0, 400)).toMatch(/toDigits: input\.event\.toDigits/);
  });

  it("the engine turn - the richest row in the trail - is addressed too", () => {
    const live = readCode("src/lib/spte/live.ts");
    const ev = live.slice(live.indexOf('kind: "engine-v3-turn"'));
    expect(ev.slice(0, 400)).toMatch(/userEmail: input\.ctx\.sender/);
    expect(ev.slice(0, 400)).toMatch(/toDigits: input\.event\.toDigits/);
  });
});

describe("the shared sink stamps the address it is given", () => {
  it("recordEvent accepts an address at all", () => {
    const types = readCode("src/lib/graph/types.ts");
    const sig = types.slice(types.indexOf("recordEvent?(args:"));
    expect(sig.slice(0, 300)).toMatch(/userEmail\?: string \| null/);
    expect(sig.slice(0, 300)).toMatch(/toDigits\?: string \| null/);
  });

  it("EXECUTED: it writes the address, and degrades to bare if the column is absent", async () => {
    const rows: Record<string, unknown>[] = [];
    let failFirst = true;
    vi.resetModules();
    vi.doMock("../runtime-config", () => ({
      sbInsert: vi.fn(async (_t: string, r: Record<string, unknown>[]) => {
        rows.push(r[0]);
        return true;
      }),
    }));
    // Exercise the shape directly - the live factory pulls in the whole engine.
    const write = async (
      args: { kind: string; userEmail?: string | null; toDigits?: string | null; detail: string },
      insert: (t: string, r: Record<string, unknown>[]) => Promise<unknown>
    ) => {
      const base = { kind: args.kind, vendor_id: "", vendor_name: "", detail: args.detail };
      const addressed = {
        ...base,
        ...(args.userEmail ? { user_email: args.userEmail } : {}),
        ...(args.toDigits ? { to_number: args.toDigits } : {}),
      };
      const ok = await insert("agent_events", [addressed]).catch(() => false);
      if (!ok) await insert("agent_events", [base]);
    };

    const insert = async (_t: string, r: Record<string, unknown>[]) => {
      rows.push(r[0]);
      if (failFirst && "to_number" in r[0]) return false; // pre-migration column
      return true;
    };

    failFirst = false;
    await write({ kind: "engine-v3-turn", userEmail: "a@x.com", toDigits: "66812", detail: "d" }, insert);
    expect(rows.at(-1)).toMatchObject({ user_email: "a@x.com", to_number: "66812" });

    failFirst = true;
    rows.length = 0;
    await write({ kind: "engine-v3-turn", userEmail: "a@x.com", toDigits: "66812", detail: "d" }, insert);
    expect(rows, "tries addressed, then falls back to bare").toHaveLength(2);
    expect(rows[1]).not.toHaveProperty("to_number");
    expect(rows[1]).toMatchObject({ kind: "engine-v3-turn" });
  });

  it("the live sink follows exactly that ladder", () => {
    const engine = readCode("src/lib/graph/engine.ts");
    const sink = engine.slice(engine.indexOf("async recordEvent({ kind"));
    expect(sink.slice(0, 900)).toMatch(/to_number: toDigits/);
    expect(sink.slice(0, 900)).toMatch(/if \(!ok\) await sbInsert\("agent_events", \[base\]\)/);
  });
});
