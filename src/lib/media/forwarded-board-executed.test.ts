// AUDIT F151 (round 2) - the two readers that turn a reading into a NUMBER,
// EXECUTED.
//
// Round 1 pinned both consumers by reading their source text. That proves
// nothing here: reverting /api/replies' merge to its old unguarded shape, or
// putting graph/engine's two `ownBoard(...)` call sites back to
// `m.raw?.reading?.prices`, leaves the import and the surrounding prose in
// place, so every grep stays green while a competitor's board is once again
// quoted as this shop's own price. So both readers run for real below, against
// a fake PostgREST, and the assertions are about the price that comes out.
//
// The defect: ingest stamps `raw.forwarded` on an inbound row (wa/ingest.ts),
// and the vision turn stamps `raw.reading` - the board's parsed prices - onto
// that SAME row. The provenance stamp was consulted only by the offers writer,
// so `onlyForwardedContent` refused to bank an offer while /api/replies still
// labelled the number "Read from their price-menu photo" on shop A's card and
// graph/engine wrote it into shop A's cross-thread rival row, whose own comment
// says that table is quoted at OTHER shops as "another shop does 150".
import { describe, it, expect, vi, afterEach } from "vitest";

const EMAIL = "t@example.com";
const VENDOR = "v1";
const DIGITS = "66812345678";
/** The rival's board: the number that must not become this shop's price. */
const BOARD = [{ pricePerDay: 150, currency: "THB", available: true }];

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// READER 1: GET /api/replies - the traveller's own card.
// ---------------------------------------------------------------------------

interface InboundRow {
  from_number: string;
  body: string;
  reading: { prices?: unknown[]; forwardedSource?: boolean } | null;
  /** `raw->>forwarded` as PostgREST returns it: a jsonb scalar, or null. */
  forwarded?: string | null;
}

/** Run the real GET with only its IO boundary faked. */
async function cardPriceFor(inbound: InboundRow[]) {
  vi.resetModules();
  vi.doMock("@/lib/session", () => ({
    getSession: async () => ({ email: EMAIL, plan: "ultra" }),
  }));
  // The drains this poll opportunistically performs are IO, not feed.
  vi.doMock("@/lib/wa-sync", () => ({ syncInboundReplies: async () => {} }));
  vi.doMock("@/lib/wa-guard", () => ({ drainOutbox: async () => {}, afterSend: async () => {} }));
  vi.doMock("@/lib/evolution", () => ({ sendFromUser: async () => ({ ok: true }) }));
  vi.doMock("@/lib/graph/engine", () => ({ drainGraphWakeups: async () => {} }));
  const sb = (table: string, query: string): unknown[] => {
    if (table === "vendor_replies") {
      return [
        {
          id: 1,
          vendor_id: VENDOR,
          vendor_name: "Krabi Bike Rent",
          // No price of the shop's own - the board is the only candidate.
          reply_text: "hello, what days you want?",
          english_gloss: null,
          found: false,
          price_per_day: null,
          matches_spec: true,
          confidence: "low",
          auto: true,
          currency: "THB",
          created_at: new Date().toISOString(),
        },
      ];
    }
    if (table === "negotiation_threads") return [];
    if (table === "whatsapp_messages" && query.includes("direction=eq.inbound")) return inbound;
    if (table === "whatsapp_messages" && query.includes("direction=eq.outbound")) {
      return [{ to_number: DIGITS, vendorId: VENDOR }];
    }
    return [];
  };
  vi.doMock("@/lib/runtime-config", () => ({
    getConfig: async () => undefined,
    sbSelectStrict: async (table: string, query: string) => ({ rows: sb(table, query) }),
    sbSelect: async (table: string, query: string) => sb(table, query),
    sbInsert: async () => true,
  }));
  const mod = await import("@/app/api/replies/route");
  const res = await mod.GET(new Request("http://localhost/api/replies?vclass=scooter"));
  const body = (await res.json()) as {
    replies: Array<{
      effectivePrice: { pricePerDay: number; source: string } | null;
      pricePerDay: number | null;
    }>;
  };
  return body.replies[0];
}

const boardRow = (over: Partial<InboundRow> = {}): InboundRow => ({
  from_number: DIGITS,
  body: "",
  reading: { prices: BOARD },
  ...over,
});

describe("F151 EXECUTED - /api/replies never prices a shop off somebody else's board", () => {
  it("the shop's OWN photographed board still becomes the card's price", async () => {
    const row = await cardPriceFor([boardRow()]);
    expect(row.effectivePrice).toEqual(
      expect.objectContaining({ pricePerDay: 150, source: "menu-photo" })
    );
  });

  it("THE BUG: a reading stamped as forwarded contributes no price at all", async () => {
    const row = await cardPriceFor([
      boardRow({ reading: { prices: BOARD, forwardedSource: true } }),
    ]);
    expect(row.effectivePrice).toBeNull();
    expect(row.pricePerDay).toBeNull();
  });

  it("...and so does a row stamped BEFORE the reading carried its own provenance", async () => {
    // Rows written before the stamp learned to write `forwardedSource` still
    // carry the row-level key, which the route now projects as a jsonb scalar.
    const row = await cardPriceFor([
      boardRow({ reading: { prices: BOARD }, forwarded: '{"score":0.82}' }),
    ]);
    expect(row.effectivePrice).toBeNull();
  });

  it("the KEY is the signal - ingest writes {score: undefined} when the score is 0", async () => {
    const row = await cardPriceFor([boardRow({ reading: { prices: BOARD }, forwarded: "{}" })]);
    expect(row.effectivePrice).toBeNull();
  });

  it("an unforwarded row beside a forwarded one still prices the shop", async () => {
    const row = await cardPriceFor([
      boardRow({ reading: { prices: BOARD, forwardedSource: true } }),
      boardRow({ reading: { prices: [{ pricePerDay: 260, currency: "THB", available: true }] } }),
    ]);
    expect(row.effectivePrice).toEqual(
      expect.objectContaining({ pricePerDay: 260, source: "menu-photo" })
    );
  });
});

// ---------------------------------------------------------------------------
// READER 2: graph/engine's cross-thread rival table - the one that is QUOTED
// at other shops.
// ---------------------------------------------------------------------------

/** Run the real `liveGraphIO().sessionTable` with only its IO boundary faked. */
async function rivalRowFor(raw: Record<string, unknown>) {
  vi.resetModules();
  // The card harness above stubs the engine module wholesale; this half runs
  // the real one.
  vi.doUnmock("@/lib/graph/engine");
  vi.doUnmock("@/lib/session");
  vi.doUnmock("@/lib/wa-sync");
  vi.doUnmock("@/lib/wa-guard");
  vi.doUnmock("@/lib/evolution");
  const since = new Date(Date.now() - 3600_000).toISOString();
  vi.doMock("@/lib/search-session", () => ({
    sessionSinceIso: async () => since,
    currentSession: async () => ({ id: 5 }),
    cheapestRivalFor: async () => null,
  }));
  const sb = (table: string, query: string): unknown[] => {
    if (table === "negotiation_threads") {
      return [
        {
          vendor_id: VENDOR,
          vendor_name: "Krabi Bike Rent",
          to_number: DIGITS,
          phase: "negotiating",
          // No pricePerDay: exactly the priceless row the board rescue exists
          // to fill.
          fields: {},
        },
      ];
    }
    if (table === "whatsapp_messages") return [{ from_number: DIGITS, raw }];
    return [];
  };
  vi.doMock("@/lib/runtime-config", () => ({
    getConfig: async () => undefined,
    setConfig: async () => true,
    sbInsert: async () => true,
    sbUpdate: async () => true,
    sbSelect: async (table: string, query: string) => sb(table, query),
    sbSelectStrict: async () => ({ rows: [] as unknown[] }),
    vaultDecryptHealth: async () => ({ ok: true }),
    vaultReadState: async () => ({ ok: true }),
  }));
  const { liveGraphIO } = await import("@/lib/graph/engine");
  const io = liveGraphIO(async () => ({ ok: true }) as never);
  const table = await io.sessionTable(EMAIL, "v2", "scooter", {
    engineSizeCc: 0,
    durationDays: 3,
  } as never);
  return table.find((r) => r.vendorId === VENDOR);
}

describe("F151 EXECUTED - the cross-thread rival table quotes only a shop's own board", () => {
  it("a priceless shop's OWN board still rescues its rival row", async () => {
    const row = await rivalRowFor({ reading: { prices: BOARD } });
    expect(row?.pricePerDay).toBe(150);
    expect(row?.currency).toBe("THB");
  });

  it("THE BUG: a forwarded board leaves the row priceless, so no shop is told 150", async () => {
    const row = await rivalRowFor({ reading: { prices: BOARD, forwardedSource: true } });
    expect(row).toBeDefined();
    expect(row?.pricePerDay).toBeUndefined();
  });

  it("...including a row stamped before the reading carried its provenance", async () => {
    const row = await rivalRowFor({ forwarded: { score: 0.82 }, reading: { prices: BOARD } });
    expect(row?.pricePerDay).toBeUndefined();
  });

  it("the KEY is the signal, not its contents (ingest writes {score: undefined} at 0)", async () => {
    const row = await rivalRowFor({ forwarded: {}, reading: { prices: BOARD } });
    expect(row?.pricePerDay).toBeUndefined();
  });
});
