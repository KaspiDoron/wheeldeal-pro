import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// WAVE 1 (owner report 5) - THE SCREEN TELLS THE TRUTH IT ALREADY KNOWS.
//
// "No price yet - your agent is asking for one" was the else-branch of one
// boolean (vendor_replies.found) while the app KNEW the price in four other
// places: the thread's standing field, the photographed board (raw.reading -
// already used as rival leverage in OTHER shops' threads!), the derived option
// menu, and the reply text itself. These hold the whole path together:
// server rollup -> client admission -> card provenance.
//
// WHAT CHANGED IN THIS FILE, AND WHY.
//
// The server half used to be pinned by regex over the route's own source - most
// egregiously by asserting the ORDER IN WHICH THE STRINGS "thread",
// "menu-photo" and "menu" APPEAR in a slice of the file. That is a statement
// about text layout, not about the resolver, and the owner's complaint was
// about the resolver: his status panel said "No price yet" while the card beside
// it showed a price. Re-ordering the three branches, deleting one of them, or
// changing which one wins would all keep those greps green.
//
// The trust order, the "a real price on the row wins outright" rule, the
// struck-through-board rule and the gloss field are now EXECUTED against the
// real GET handler with a fake database behind it. What remains a pin below is
// client-side (page.tsx, the components) - see the note above that section.

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// ---------------------------------------------------------------------------
// EXECUTED: the real /api/replies resolver.
// ---------------------------------------------------------------------------

const VENDOR = "v1";
const DIGITS = "66812345678";
/** A shop reply that names NO price - the row the resolver has to rescue. */
const SILENT_REPLY = "hello, what days you want?";
/** A shop message that really does contain a two-tier menu (see offer-options). */
const MENU_TEXT = "Hi! Normal scooters? Some models 200 and some new 250/day";

interface FakeDb {
  /** vendor_replies rows, as the route selects them. */
  replies: Array<Record<string, unknown>>;
  /** negotiation_threads.fields for VENDOR (the thread's standing state). */
  threadFields?: Record<string, unknown> | null;
  /** Inbound message bodies from the shop (the derived menu comes from these). */
  inboundBodies?: string[];
  /** Prices read off a PHOTOGRAPHED board, as raw.reading stores them. */
  boardPrices?: Array<{ pricePerDay: number; currency?: string; vehicle?: string; available?: boolean }>;
}

/** Run the real GET with only its IO boundary faked. */
async function repliesFor(db: FakeDb) {
  vi.resetModules();
  vi.doMock("@/lib/session", () => ({
    getSession: async () => ({ email: "t@example.com", plan: "ultra" }),
  }));
  // The three drains this poll opportunistically performs are IO, not feed.
  vi.doMock("@/lib/wa-sync", () => ({ syncInboundReplies: async () => {} }));
  vi.doMock("@/lib/wa-guard", () => ({ drainOutbox: async () => {}, afterSend: async () => {} }));
  vi.doMock("@/lib/evolution", () => ({ sendFromUser: async () => ({ ok: true }) }));
  vi.doMock("@/lib/graph/engine", () => ({ drainGraphWakeups: async () => {} }));
  const sb = (table: string, query: string): unknown[] => {
    if (table === "vendor_replies") return db.replies;
    if (table === "negotiation_threads") {
      return db.threadFields === undefined
        ? []
        : [{ vendor_id: VENDOR, fields: db.threadFields }];
    }
    if (table === "whatsapp_messages" && query.includes("direction=eq.inbound")) {
      const bodies = db.inboundBodies ?? [];
      const rows: Array<Record<string, unknown>> = bodies.map((body) => ({
        from_number: DIGITS,
        body,
        reading: null,
      }));
      if (db.boardPrices?.length) {
        rows.push({ from_number: DIGITS, body: "", reading: { prices: db.boardPrices } });
      }
      // The route asks newest-first and reverses; order is irrelevant here.
      return rows;
    }
    if (table === "whatsapp_messages" && query.includes("direction=eq.outbound")) {
      // How a vendor_id is joined to the digits we actually messaged. The route
      // now projects vendorId:raw->>vendorId FLAT (OR11 E2.1) instead of pulling
      // the whole raw blob, so PostgREST returns a flat `vendorId` column.
      return [{ to_number: DIGITS, vendorId: VENDOR }];
    }
    return [];
  };
  vi.doMock("@/lib/runtime-config", () => ({
    getConfig: async () => undefined,
    // L3: the reply feed's first tier reads STRICT so a missing column and an
    // empty feed stop being the same []. Same data either way in this mock.
    sbSelectStrict: async (table: string, query: string) => ({ rows: sb(table, query) }),
    sbSelect: async (table: string, query: string) => sb(table, query),
  }));
  const mod = await import("@/app/api/replies/route");
  // vclass scopes the derived menu exactly as the client sends it.
  const res = await mod.GET(new Request("http://localhost/api/replies?vclass=scooter"));
  const body = (await res.json()) as {
    replies: Array<{
      effectivePrice: { pricePerDay: number; source: string; currency: string | null } | null;
      pricePerDay: number | null;
      english: string | null;
      options: unknown;
    }>;
  };
  return body.replies;
}

/** A vendor_replies row that carries NO usable price of its own. */
const silentRow = (over: Record<string, unknown> = {}) => ({
  id: 1,
  vendor_id: VENDOR,
  vendor_name: "Krabi Bike Rent",
  reply_text: SILENT_REPLY,
  english_gloss: null,
  found: false,
  price_per_day: null,
  matches_spec: true,
  confidence: "low",
  auto: true,
  currency: "THB",
  created_at: new Date().toISOString(),
  ...over,
});

describe("EXECUTED /api/replies - the effective price consults every source, in trust order", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("@/lib/session");
    vi.doUnmock("@/lib/runtime-config");
  });

  it("1st: the thread's own standing price outranks the board and the menu", async () => {
    const [row] = await repliesFor({
      replies: [silentRow()],
      threadFields: { pricePerDay: 280 },
      inboundBodies: [MENU_TEXT],
      boardPrices: [{ pricePerDay: 150, currency: "THB" }],
    });
    expect(row.effectivePrice).toMatchObject({ pricePerDay: 280, source: "thread" });
  });

  it("2nd: with no thread price, the PHOTOGRAPHED board outranks the derived menu", async () => {
    const [row] = await repliesFor({
      replies: [silentRow()],
      threadFields: {},
      inboundBodies: [MENU_TEXT],
      boardPrices: [{ pricePerDay: 150, currency: "THB", vehicle: "Click 125" }],
    });
    expect(row.effectivePrice).toMatchObject({ pricePerDay: 150, source: "menu-photo" });
  });

  it("3rd: with neither, the menu derived from the shop's own words is used", async () => {
    const [row] = await repliesFor({
      replies: [silentRow()],
      threadFields: {},
      inboundBodies: [MENU_TEXT],
    });
    expect(row.effectivePrice).toMatchObject({ pricePerDay: 200, source: "menu" });
    expect(row.options).toHaveLength(2); // the menu itself still ships
  });

  it("a CROSSED-OUT board row is not a price - it falls through to the menu", async () => {
    // The board still shows the model; the shop no longer rents it. Quoting it
    // advertised a price nobody could book.
    const [row] = await repliesFor({
      replies: [silentRow()],
      threadFields: {},
      inboundBodies: [MENU_TEXT],
      boardPrices: [{ pricePerDay: 90, currency: "THB", available: false }],
    });
    expect(row.effectivePrice).toMatchObject({ pricePerDay: 200, source: "menu" });
  });

  it("a row that carries the REAL price gets no effectivePrice at all", async () => {
    const [row] = await repliesFor({
      replies: [silentRow({ found: true, price_per_day: 240, confidence: "high" })],
      threadFields: { pricePerDay: 280 },
      inboundBodies: [MENU_TEXT],
      boardPrices: [{ pricePerDay: 150, currency: "THB" }],
    });
    expect(row.pricePerDay).toBe(240);
    expect(row.effectivePrice).toBeNull();
  });

  it("and when the app truly knows nothing, it says nothing", async () => {
    // The honest "No price yet" case has to survive: inventing a number here
    // is worse than the bug this whole wave fixed.
    const [row] = await repliesFor({ replies: [silentRow()], threadFields: {} });
    expect(row.effectivePrice).toBeNull();
  });

  it("the field is SHIPPED on every reply row, with the English gloss (W1.5)", async () => {
    const [row] = await repliesFor({
      replies: [silentRow({ english_gloss: "we have scooters from 200" })],
      threadFields: { pricePerDay: 280 },
    });
    expect(row).toHaveProperty("effectivePrice");
    expect(row.effectivePrice?.currency).toBe("THB");
    expect(row.english).toBe("we have scooters from 200");
  });
});

describe("the client ADMITS a sourced price instead of dropping the row", () => {
  const page = read("src/app/page.tsx");

  it("a row with an effectivePrice is no longer skipped", () => {
    // The old drop: `if (!r.found || !r.pricePerDay) continue;` - which threw
    // away everything ON the row (options, thread price, board price).
    expect(page).not.toMatch(/if \(!r\.found \|\| !r\.pricePerDay\) continue;/);
    expect(page).toMatch(/if \(!confirmed && !r\.effectivePrice\?\.pricePerDay\) continue;/);
  });

  it("a confirmed row always outranks a sourced one, whatever the timestamps", () => {
    expect(page).toMatch(/\(confirmed && !curConfirmed\)/);
  });

  it("a sourced price never replaces a confirmed offer and never inflates the round", () => {
    expect(page).toMatch(/if \(!confirmedRow && v\.offer && !v\.offer\.priceSource\) return v;/);
    // D1 made application content-keyed (the same row re-applies when the
    // thread learns something), so the round bump needs BOTH: a confirmed
    // row AND a row this client has never seen before.
    expect(page).toMatch(/confirmedRow && isNewRow/);
    expect(page).toMatch(/const isNewRow = prev === undefined;/);
  });
});

describe("provenance is DISCLOSED wherever the price shows", () => {
  it("the vendor card says where a sourced price came from", () => {
    const card = read("src/components/VendorCard.tsx");
    expect(card).toMatch(/offer\.priceSource/);
    expect(card).toMatch(/price-menu photo/);
  });

  it("the status panel carries the provenance chip", () => {
    const page = read("src/app/page.tsx");
    expect(page).toMatch(/from menu photo/);
    expect(page).toMatch(/from price menu/);
  });
});

describe("the deposit chip shows EVERY alternative (owner report 5 #9)", () => {
  it("the status panel renders depositSummary, not the legacy single enum", () => {
    const page = read("src/app/page.tsx");
    // The exact literal that reported "passport or money4000" as passport-only.
    expect(page).not.toMatch(
      /depositType === "passport" \? t\("Passport deposit"\) : v\.offer\.deposit/
    );
    expect(page).toMatch(/depositSummary\(/);
  });

  it("the compare sheet uses the same shared summary", () => {
    const sheet = read("src/components/will/CompareSheet.tsx");
    expect(sheet).toMatch(/depositSummary\(/);
    expect(sheet).not.toMatch(/o\.depositType === "passport"\s*\?\s*t\("passport"\)/);
  });
});

describe("the draft popup's language belongs to the HUNT (owner report 5 #14)", () => {
  it("the modal renders language chips only on a local-language hunt", () => {
    const modal = read("src/components/BargainDraftModal.tsx");
    // No more invented default from a tier literal...
    expect(modal).not.toMatch(/isUltra \? "local" : "english"/);
    expect(modal).not.toMatch(/const isUltra = plan === "ultra"/);
    // ...the default follows the session, gated by the shared predicate...
    expect(modal).toMatch(/sessionLocalLang && localEntitled \? "local" : "english"/);
    expect(modal).toMatch(/can\(plan, "local-language"\)/);
    // ...and the whole chip row is conditional on the hunt being local.
    expect(modal).toMatch(/\{sessionLocalLang && \(/);
  });

  it("page.tsx passes the hunt's language state down", () => {
    expect(read("src/app/page.tsx")).toMatch(/sessionLocalLang=\{localLangActive\}/);
  });

  it("/api/bargain-draft resolves the thread's established language like the send path", () => {
    const route = read("src/app/api/bargain-draft/route.ts");
    expect(route).toMatch(/threadLanguageMode/);
    expect(route).toMatch(/resolveThreadLanguage/);
    expect(route).toMatch(/localLanguage: composeLocal/);
    expect(route).toMatch(/languageUsed/);
  });
});

describe("the gloss is visible everywhere (owner report 5 #15)", () => {
  // W1.5: a local-language bargain must be readable by the traveller on EVERY
  // surface that quotes it - status panel, cards, feed, trips, map, draft
  // modal - not only inside the full-conversation transcript. One doctrine:
  // the REAL text on the wire stays primary, the English gloss is a second
  // quiet line when it differs. Key facts these pins rest on: inbound rows
  // carry raw.english (agent-loop stamps it), outbound rows carry
  // raw.englishGloss (the outbox meta key every send path spreads).

  it("vendor_replies carries english_gloss (the root data gap)", () => {
    const schema = read("supabase/schema.sql");
    expect(schema).toMatch(
      /alter table public\.vendor_replies add column if not exists english_gloss text;/
    );
  });

  it("the agent loop stamps the SAME inbound gloss onto the vendor_replies row", () => {
    const loop = read("src/lib/agent-loop.ts");
    // Best-effort follow-up on the row this turn just wrote (the gloss is
    // computed after the insert), inside the inbound-gloss block.
    const block = loop.slice(loop.indexOf('finishBeforeResponse("inbound-gloss"'));
    expect(block).toMatch(/sbUpdate\("vendor_replies", `id=eq\.\$\{vr\[0\]\.id\}`, \{ english_gloss: english \}\)/);
  });

  it("/api/replies selects english_gloss (first tier only) and returns it as `english`", () => {
    const route = read("src/app/api/replies/route.ts");
    expect(route).toMatch(/select=id,vendor_id,vendor_name,reply_text,english_gloss,found/);
    expect(route).toMatch(/english: r\.english_gloss \?\? null/);
    // The degrade tiers survive WITHOUT the new column (pre-migration feed).
    expect(route).toMatch(
      /select=id,vendor_id,vendor_name,reply_text,found,price_per_day,matches_spec,confidence,auto,currency,deposit,delivers,created_at/
    );
  });

  it("the offer rows the client builds carry the gloss (Offer.messageEnglish)", () => {
    const page = read("src/app/page.tsx");
    expect(page).toMatch(/messageEnglish: r\.english\?\.slice\(0, 200\)/);
    expect(read("src/lib/types.ts")).toMatch(/messageEnglish\?: string/);
  });

  it("the status panel renders the gloss under the offer excerpt and the replied excerpt", () => {
    const page = read("src/app/page.tsx");
    // Offers & negotiations: raw shop words + gloss line.
    expect(page).toMatch(/v\.offer\.messageEnglish\.trim\(\) !== v\.offer\.message\.trim\(\)/);
    // Replied - your agent is on it: same doctrine on lastInboundText.
    expect(page).toMatch(/v\.lastInboundEnglish\.trim\(\) !== v\.lastInboundText\.trim\(\)/);
  });

  it("the activity client consumes lastOutboundText (it was silently dropped)", () => {
    const page = read("src/app/page.tsx");
    expect(page).toMatch(/lastOutboundText\?: string/);
    expect(page).toMatch(/sentText: last\.lastOutboundText/);
    // The gloss travels WITH its text - a newer English send clears the old gloss.
    expect(page).toMatch(/sentGloss: last\.lastOutboundText \? last\.lastOutboundEnglish/);
    // ...and the Awaiting-reply panel shows the REAL sent text, gloss second.
    expect(page).toMatch(/\{v\.sentText && <div className="line-clamp-2">📤 \{v\.sentText\}<\/div>\}/);
  });

  it("the feed shows the REAL text with the gloss beside it - never gloss-instead", () => {
    const route = read("src/app/api/activity/route.ts");
    // The old outbound gloss-instead read (which keyed on the inbound key
    // raw.english and so never fired) is gone in both places it lived.
    expect(route).not.toMatch(/m\.raw\?\.english \|\| m\.body/);
    // Outbound: detail = the real body, english = the outbound gloss key.
    expect(route).toMatch(/detail: \(m\.body \|\| ""\)\.slice\(0, 220\)/);
    expect(route).toMatch(/english: m\.raw\?\.englishGloss\?\.slice\(0, 220\)/);
    // Inbound reply items carry the stored gloss.
    expect(route).toMatch(/english: r\.english_gloss\?\.slice\(0, 220\)/);
    // The raw-inbound fallback query SELECTS the stored gloss (raw->>english),
    // so a reply whose agent turn has not run yet still shows its translation.
    expect(route).toMatch(/english:raw->>english/);
    expect(route).toMatch(/lastInboundEnglish = m\.english\?\.slice\(0, 240\)/);
    // And the feed client renders the second quiet line.
    const feed = read("src/components/activity/ActivityFeed.tsx");
    expect(feed).toMatch(/it\.english && it\.english\.trim\(\) !== it\.detail\.trim\(\)/);
  });

  it("ThreadPeek's always-visible one-line preview is gloss-first", () => {
    const peek = read("src/components/ThreadPeek.tsx");
    expect(peek).toMatch(/const preview = gloss && gloss !== msg\.text\.trim\(\) \? gloss : msg\.text/);
    expect(peek).toMatch(/summarize\(waPlain\(preview\)\)/);
    // ...and the card's SEEDED first reply carries the gloss too.
    expect(peek).toMatch(/fallbackReceivedEnglish/);
    expect(read("src/components/VendorCard.tsx")).toMatch(
      /fallbackReceivedEnglish=\{offer\?\.messageEnglish\}/
    );
  });

  it("the trips timeline shows shop replies (and agent sends) with the gloss", () => {
    const route = read("src/app/api/deals/route.ts");
    expect(route).toMatch(/english_gloss/);
    expect(route).toMatch(/english: r\.english_gloss\?\.slice\(0, 90\)/);
    // Agent sends: real body as text, gloss beside it (undefined for the
    // traveller's own human-manual rows, whose text is a label).
    expect(route).toMatch(/english: human \? undefined : m\.raw\?\.englishGloss\?\.slice\(0, 90\)/);
    expect(route).not.toMatch(/m\.raw\?\.english \|\| m\.body/);
    const page = read("src/app/deals/page.tsx");
    expect(page).toMatch(/e\.english && e\.english\.trim\(\) !== e\.text\.trim\(\)/);
  });

  it("BargainDraftModal shows the draft's English gloss before the traveller approves it", () => {
    const modal = read("src/components/BargainDraftModal.tsx");
    expect(modal).toMatch(/data\.english/);
    expect(modal).toMatch(/\{gloss && !edited &&/);
  });

  it("the map cards carry the shop's last line + gloss", () => {
    const map = read("src/components/MapView.tsx");
    expect(map).toMatch(/lastLineEnglish\.trim\(\) !== lastLine\.trim\(\)/);
  });
});
