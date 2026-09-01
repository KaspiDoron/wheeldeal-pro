import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StructuredRFQ } from "./types";

vi.mock("server-only", () => ({}));

// W9 - THE TRAVELLER'S WINDOW, END TO END, EXECUTED.
//
// The owner's #1 field complaint - "I searched a 3-day rental and the app
// searched 1 day, then flipped to 3 days mid-thread" - survived three waves of
// fixes because every one of them landed next to the live path instead of on
// it: the window was posted only when a control was touched, the promise was
// reconciled and then thrown away by the inbound turn, and the ban on the drift
// generator was pointed at the wrong file.
//
// These tests RUN the code. A source pin asserts that a line looks right; the
// greps that survived the last audit all looked right.

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const iso = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// FIX 1 + 2 - the window on the wire is the window on the screen
// ---------------------------------------------------------------------------

/** Load /api/profile with its collaborators stubbed, capturing the profiler's
 *  arguments and returning a caller-supplied parse. */
async function loadProfile(parsed: Record<string, unknown>) {
  vi.resetModules();
  const calls: Array<{ text: string; hint?: number; defaultDays?: number }> = [];

  vi.doMock("@/lib/session", () => ({
    // Ultra so the plan clamp never moves a future pickup date - this suite is
    // about the profiler precedence, and rental-window has its own tests.
    getSession: async () => ({ email: "t@example.com", plan: "ultra" }),
  }));
  vi.doMock("@/lib/ai", () => ({ aiEnabled: async () => false }));
  vi.doMock("@/lib/ai-budget", () => ({
    runWithAiBudget: async (_e: string, fn: () => Promise<unknown>) => fn(),
  }));
  vi.doMock("@/lib/runtime-config", () => ({ sbInsert: async () => true }));
  vi.doMock("@/lib/agents", () => ({
    deterministicRFQ: (f: Record<string, unknown>) => f,
    runProfiler: async (
      text: string,
      hint?: number,
      _email?: string,
      defaultDays?: number
    ) => {
      calls.push({ text, hint, defaultDays });
      return {
        vehicleClass: "scooter",
        transmission: "any",
        accessories: [],
        fulfillment: "any",
        vendorMessage: "",
        // The profiler applies its own fallback internally; the fixture stands
        // in for "what the prose actually said".
        durationDays: parsed.durationDays ?? defaultDays ?? 3,
        ...(parsed.startDate ? { startDate: parsed.startDate } : {}),
      };
    },
  }));

  const mod = await import("@/app/api/profile/route");
  return { POST: mod.POST as (r: Request) => Promise<Response>, calls };
}

const profileRequest = (body: unknown) =>
  new Request("http://localhost/api/profile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("a typed search carries the window the traveller can SEE", () => {
  beforeEach(() => vi.resetModules());

  it("REGRESSION: the default search now ships a start date and the shown duration", async () => {
    // The exact reproduction: type a request, touch nothing, press the button.
    // Before the fix the body carried NEITHER field, so the RFQ came back with
    // durationDays 3 (a hard-coded last resort) and no startDate at all - while
    // the card above the button read "From <today> - For 4 days".
    const { POST, calls } = await loadProfile({});
    const res = await POST(
      profileRequest({
        text: "I need a scooter in Chiang Mai",
        startDate: iso(0),
        durationDays: 4,
        windowExplicit: { startDate: false, durationDays: false },
      })
    );
    const data = (await res.json()) as { rfq: { startDate?: string; durationDays: number } };
    expect(data.rfq.startDate).toBe(iso(0));
    expect(data.rfq.durationDays).toBe(4);
    // An untouched control is a DEFAULT, not a statement: it reaches the
    // profiler as the last resort, never as the traveller's explicit hint.
    expect(calls[0].hint).toBeUndefined();
    expect(calls[0].defaultDays).toBe(4);
  });

  it("prose still wins over an untouched control, on both axes", async () => {
    const { POST, calls } = await loadProfile({ startDate: iso(5), durationDays: 7 });
    const res = await POST(
      profileRequest({
        text: "scooter for a week from the 20th",
        startDate: iso(0),
        durationDays: 4,
        windowExplicit: { startDate: false, durationDays: false },
      })
    );
    const data = (await res.json()) as { rfq: { startDate?: string; durationDays: number } };
    expect(data.rfq.startDate).toBe(iso(5));
    expect(data.rfq.durationDays).toBe(7);
    expect(calls[0].hint).toBeUndefined();
  });

  it("THE FIX-2 CASE: one tap on the DATE picker does not ship the untouched 4-day default", async () => {
    // "scooter for a week from the 20th" + a single tap on the date control.
    // With one shared flag this posted durationDays: 4 as an explicit override
    // and the profiler's parsed 7 lost - silently, because the mismatch note
    // compares asked (4) with got (4).
    const { POST, calls } = await loadProfile({ startDate: iso(5), durationDays: 7 });
    const res = await POST(
      profileRequest({
        text: "scooter for a week from the 20th",
        startDate: iso(9),
        durationDays: 4,
        windowExplicit: { startDate: true, durationDays: false },
      })
    );
    const data = (await res.json()) as {
      rfq: { startDate?: string; durationDays: number; returnDate?: string };
    };
    expect(data.rfq.startDate).toBe(iso(9)); // touched: it wins
    expect(data.rfq.durationDays).toBe(7); // untouched: prose survives
    // ...and the return date is derived from the reconciled pair, not from
    // either half on its own.
    expect(data.rfq.returnDate).toBe(iso(16));
    expect(calls[0].hint).toBeUndefined();
  });

  it("the symmetric case: one tap on the STEPPER does not ship the untouched date", async () => {
    const { POST, calls } = await loadProfile({ startDate: iso(5), durationDays: 7 });
    const res = await POST(
      profileRequest({
        text: "scooter for a week from the 20th",
        startDate: iso(0),
        durationDays: 2,
        windowExplicit: { startDate: false, durationDays: true },
      })
    );
    const data = (await res.json()) as { rfq: { startDate?: string; durationDays: number } };
    expect(data.rfq.startDate).toBe(iso(5)); // untouched: prose survives
    expect(data.rfq.durationDays).toBe(2); // touched: it wins
    expect(calls[0].hint).toBe(2); // and it reaches the profiler as a statement
  });

  it("a client with no windowExplicit keeps the old override contract", async () => {
    // A cached bundle mid-deploy sent these fields ONLY when touched, so
    // "present" meant "explicit" for it. Demoting that to a fallback would have
    // been a silent regression for every stale tab.
    const { POST } = await loadProfile({ startDate: iso(5), durationDays: 7 });
    const res = await POST(
      profileRequest({ text: "scooter for a week", startDate: iso(9), durationDays: 2 })
    );
    const data = (await res.json()) as { rfq: { startDate?: string; durationDays: number } };
    expect(data.rfq.startDate).toBe(iso(9));
    expect(data.rfq.durationDays).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// FIX 7 - never invent a cc the traveller did not state
// ---------------------------------------------------------------------------

/** runProfiler with no LLM behind it - the heuristic path, which is what demo
 *  mode, an unparseable answer, an expired 9s budget and an exhausted
 *  LIMIT_AI_PER_DAY all take. */
async function loadAgents() {
  vi.resetModules();
  // The profile suite above stubs the whole agents module; this one needs the
  // real thing (vi.doMock registrations outlive resetModules).
  vi.doUnmock("@/lib/agents");
  vi.doMock("@/lib/ai", () => ({ chat: async () => null, extractJson: () => null }));
  vi.doMock("@/lib/prompts", () => ({ getPrompt: async () => "" }));
  vi.doMock("@/lib/runtime-config", () => ({
    sbSelect: async () => [],
    sbInsert: async () => true,
    getConfig: async () => "",
  }));
  return import("@/lib/agents");
}

describe("the heuristic profiler invents nothing", () => {
  it("REGRESSION: a scooter request with no size named carries NO engine size", async () => {
    const { runProfiler } = await loadAgents();
    const rfq = await runProfiler("I need a scooter in Chiang Mai");
    // 110cc was "cheapest by default". Displacement is DISQUALIFYING in the
    // identity gate, so every real 125cc quote came back wrong-vehicle and the
    // traveller saw no prices at all - on a constraint they never stated.
    expect(rfq.engineSizeCc).toBeUndefined();
    expect(rfq.vendorMessage).not.toMatch(/110cc/);
  });

  it("a size the traveller DID state is still honoured", async () => {
    const { runProfiler } = await loadAgents();
    expect((await runProfiler("125cc scooter please")).engineSizeCc).toBe(125);
  });

  it("the shown duration is the last resort, not a hard-coded 3", async () => {
    const { runProfiler } = await loadAgents();
    const rfq = await runProfiler("I need a scooter in Chiang Mai", undefined, undefined, 4);
    expect(rfq.durationDays).toBe(4);
    expect(rfq.vendorMessage).toMatch(/4 days/);
  });

  it("prose outranks the shown duration, and an explicit picker outranks prose", async () => {
    const { runProfiler } = await loadAgents();
    expect((await runProfiler("scooter for 7 days", undefined, undefined, 4)).durationDays).toBe(7);
    expect((await runProfiler("scooter for 7 days", 4, undefined, 4)).durationDays).toBe(4);
  });

  it("nothing stated anywhere still yields a sane rental", async () => {
    const { runProfiler } = await loadAgents();
    expect((await runProfiler("I need a scooter")).durationDays).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// FIX 3 + 5 + 8 - one rfq leaves the resolver
// ---------------------------------------------------------------------------

type Row = { id: number; received_at: string; body?: string | null; raw: Record<string, unknown> | null };

async function loadResolver(opts: { rows: Row[]; recovered?: StructuredRFQ | null }) {
  vi.resetModules();
  const events: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  // Newest-first for the window read, oldest-first for the opener read - the
  // resolver distinguishes them by the order clause, so the stub does too.
  const desc = [...opts.rows].sort((a, b) => (a.received_at < b.received_at ? 1 : -1));
  const asc = [...opts.rows].sort((a, b) => (a.received_at < b.received_at ? -1 : 1));

  const answer = (q: string) =>
    // The session-boundary marker read (owner report 6 B): these threads
    // have no previous search, so no marker exists.
    q.includes("to_number=eq.session") ? [] : q.includes("received_at.asc") ? [asc[0]] : desc;

  vi.doMock("@/lib/runtime-config", () => ({
    sbSelect: async (_t: string, q: string) => answer(q),
    // The anchor read is STRICT now, so an outage stays distinguishable from
    // "this shop was never contacted" (wa/thread-context). Same rows, strict
    // envelope.
    sbSelectStrict: async (_t: string, q: string) => ({ rows: answer(q) }),
    sbInsert: async (_t: string, rows: Array<Record<string, unknown>>) => {
      events.push(...rows);
      return true;
    },
    sbUpdate: async (_t: string, _m: string, patch: Record<string, unknown>) => {
      updates.push(patch);
      return true;
    },
  }));
  vi.doMock("@/lib/wa/anchor-recovery", () => ({
    recoverRfqForSender: async () => opts.recovered ?? null,
  }));

  const { resolveThreadContext } = await import("@/lib/wa/thread-context");
  return { resolveThreadContext, events, updates };
}

const scooter = (durationDays: number): StructuredRFQ => ({
  vehicleClass: "scooter",
  transmission: "automatic",
  durationDays,
  accessories: [],
  fulfillment: "any",
  vendorMessage: "",
});

describe("resolveThreadContext hands back ONE rfq", () => {
  it("REGRESSION: the live path's ctx.rfq is the promise, not the drifted anchor", async () => {
    const { resolveThreadContext } = await loadResolver({
      rows: [
        {
          id: 1,
          received_at: new Date(Date.now() - 3600_000).toISOString(),
          body: "Hi! Do you have an automatic scooter available for 3 days?",
          raw: { sender: "t@example.com", vendorId: "v1", rfq: scooter(3) },
        },
        {
          id: 2,
          received_at: new Date(Date.now() - 60_000).toISOString(),
          body: "quick question",
          // A SECOND search re-stamped this thread with a one-day rental.
          raw: { sender: "t@example.com", vendorId: "v1", rfq: scooter(1) },
        },
      ],
    });
    const r = await resolveThreadContext("66812345678", "t@example.com");
    expect(r.rfq?.durationDays).toBe(3);
    // agent-loop bound `const rfq = ctx.rfq` here and got 1: the shop's own
    // reply was answered on a duration it had never been quoted, while a
    // scheduled follow-up on the same thread said 3.
    expect((r.ctx?.rfq as { durationDays?: number })?.durationDays).toBe(3);
    expect(r.ctx?.rfq).toEqual(r.rfq);
  });

  it("...and the rfq-drift-blocked trail is now telling the truth", async () => {
    const { resolveThreadContext, events } = await loadResolver({
      rows: [
        {
          id: 1,
          received_at: new Date(Date.now() - 3600_000).toISOString(),
          body: "Hi! Do you have an automatic scooter available for 3 days?",
          raw: { sender: "t@example.com", vendorId: "v1", rfq: scooter(3) },
        },
        {
          id: 2,
          received_at: new Date(Date.now() - 60_000).toISOString(),
          raw: { sender: "t@example.com", vendorId: "v1", rfq: scooter(1) },
        },
      ],
    });
    const r = await resolveThreadContext("66812345678", "t@example.com");
    const trail = events.find((e) => e.kind === "rfq-drift-blocked");
    expect(trail, "a drift went unrecorded").toBeTruthy();
    expect(String(trail!.detail)).toContain("Kept what the shop was told");
    // The claim and the value handed to the turn have to agree - they did not.
    expect((r.ctx?.rfq as { durationDays?: number })?.durationDays).toBe(3);
  });

  it("REGRESSION: self-heal returns a ctx that HAS the recovered rfq", async () => {
    const { resolveThreadContext, updates } = await loadResolver({
      rows: [
        {
          id: 7,
          received_at: new Date(Date.now() - 60_000).toISOString(),
          body: "Hi! Do you have an automatic scooter available for 8 days?",
          // A live thread whose rows lost their rfq: the gate still passes on
          // vendorId, so this is ingestible and MUST be answerable.
          raw: { sender: "t@example.com", vendorId: "v1", region: "Chiang Mai" },
        },
      ],
      recovered: scooter(8),
    });
    const r = await resolveThreadContext("66812345678", "t@example.com");
    expect(r.repaired).toBe(true);
    expect(r.rfq?.durationDays).toBe(8);
    // It handed sbUpdate a fresh literal and returned target.raw untouched, so
    // ctx.rfq was UNDEFINED - past the null guard (which reads resolved.rfq)
    // and into `rfq.vehicleClass` on the live inbound path.
    expect(r.ctx?.rfq).toBeTruthy();
    expect(r.ctx?.rfq).toEqual(r.rfq);
    // The heal is still persisted, and the row it writes is the row it returns.
    expect((updates[0]?.raw as { rfq?: unknown })?.rfq).toEqual(r.rfq);
    expect((updates[0]?.raw as { vendorId?: string })?.vendorId).toBe("v1");
  });

  it("a first contact is left exactly as it was sent", async () => {
    const { resolveThreadContext, events } = await loadResolver({
      rows: [
        {
          id: 1,
          received_at: new Date(Date.now() - 60_000).toISOString(),
          body: "Hi! Do you have an automatic scooter available for 5 days?",
          raw: { sender: "t@example.com", vendorId: "v1", rfq: scooter(5) },
        },
      ],
    });
    const r = await resolveThreadContext("66812345678", "t@example.com");
    expect(r.rfq?.durationDays).toBe(5);
    expect(r.ctx?.rfq).toEqual(r.rfq);
    expect(events.find((e) => e.kind === "rfq-drift-blocked")).toBeUndefined();
  });
});

describe("the live inbound turn runs on the reconciled promise", () => {
  // The value that reaches SPTE's session (and therefore the duration rail at
  // spte/rails.ts) is agent-loop's `rfq` binding. Executed coverage of the
  // resolver is above; this pins the binding it flows from, because the two
  // entry points into the same thread disagreeing is the failure class.
  const loop = read("src/lib/agent-loop.ts").replace(/\/\/.*$/gm, "");

  it("agent-loop binds the resolved rfq, never the raw anchor row", () => {
    expect(loop).toMatch(/const rfq = resolved\.rfq as StructuredRFQ;/);
    expect(loop, "the drifted anchor is back on the live path").not.toMatch(
      /const rfq = ctx\.rfq as StructuredRFQ;/
    );
  });

  it("and that binding is what the turn is built from", () => {
    // turnInput.rfq -> runThreadTurn -> spte/live buildSession -> TurnContext,
    // which is what rails.ts validates the draft against.
    expect(loop).toMatch(/ctx: \{ \.\.\.ctx, inboundId: opts\.waMessageId \},\s*[\r\n]\s*rfq,/);
    expect(read("src/lib/spte/live.ts")).toMatch(/rfq: input\.rfq,/);
    // ...which is what the duration rail validates the draft against. Nothing
    // under spte/ reconciles anything itself (it imports no rental-params), so
    // this chain IS the fix for the rail rewriting a correct draft into the
    // wrong duration - the rail was only ever as right as its input.
    expect(read("src/lib/spte/rails.ts")).toMatch(
      /correctDuration\(text, ctx\.session\.rfq\.durationDays\)/
    );
  });

  it("the wakeup/tick entry still reads the same field", () => {
    // It always did - that is how the disagreement was provable.
    expect(read("src/lib/graph/engine.ts")).toMatch(/const rfq = resolved\.rfq;/);
  });
});

// ---------------------------------------------------------------------------
// FIX 6 - the drift generator on the primary send path
// ---------------------------------------------------------------------------

describe("promisedRfq, executed - what the mass route now runs every re-contact through", () => {
  async function loadPromised(opener: Row | null) {
    vi.resetModules();
    vi.doMock("@/lib/runtime-config", () => ({
      sbSelect: async () => (opener ? [opener] : []),
      sbSelectStrict: async () => ({ rows: opener ? [opener] : [] }),
      sbInsert: async () => true,
      sbUpdate: async () => true,
    }));
    return (await import("@/lib/wa/thread-context")).promisedRfq;
  }

  it("pulls a re-stamp back to what this shop was actually told", async () => {
    const promisedRfq = await loadPromised({
      id: 1,
      received_at: new Date().toISOString(),
      body: "Hi! Do you have an automatic scooter available for 8 days?",
      raw: { rfq: scooter(8) },
    });
    const settled = await promisedRfq("66812345678", "t@example.com", scooter(30));
    expect(settled.rfq?.durationDays).toBe(8);
    expect(settled.drifted).toBe(true);
  });

  it("a first contact passes through untouched - it IS the promise", async () => {
    const promisedRfq = await loadPromised(null);
    const settled = await promisedRfq("66812345678", "t@example.com", scooter(30));
    expect(settled.rfq?.durationDays).toBe(30);
    expect(settled.drifted).toBe(false);
  });
});
