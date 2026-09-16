import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

const raw = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  raw(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// ---------------------------------------------------------------------------
// W8 #28: "AGENT SPEC VERIFICATION" WAS THE TRAVELLER'S OWN REQUEST.
// ---------------------------------------------------------------------------
//
// The block sat on the last screen before a deposit, under a savings-coloured
// check, headed as a verification - and its entire content came from
// `/api/negotiate` with `verify:true`, whose answer is `verificationMessage(rfq)`:
// the text we would SEND a shop. Nothing in it had been near a shop. On a failed
// fetch it left "Requesting confirmation from the vendor..." on screen for the
// life of the sheet, claiming an in-flight process that had already ended.

describe("W8 #28: the booking screen shows what the SHOP confirmed", () => {
  const sheet = raw("src/components/BookingSheet.tsx");
  // Comment-stripped, so the WHY note above the fix (which necessarily quotes
  // the old copy) cannot satisfy an assertion about what the sheet renders.
  const code = readCode("src/components/BookingSheet.tsx");

  it("the self-echo request is gone entirely - fetch, state and placeholder", () => {
    expect(code).not.toMatch(/verify: true/);
    expect(code).not.toMatch(/Agent spec verification/);
    expect(code).not.toMatch(/Requesting confirmation from the vendor/);
    expect(code).not.toMatch(/setVerification/);
    // NO EFFECT IN THIS COMPONENT MAY FETCH.
    //
    // This used to read `expect(code).not.toMatch(/useEffect/)`, on the note
    // that the self-echo request was "the only effect this component had" -
    // true when it was written, and a fact about the file rather than a rule
    // about it. A blanket ban on effects then failed the first time a
    // legitimate one arrived (the consented `booking_opened` funnel event,
    // which has to live here because five different call sites open this
    // sheet). What the removed defect actually WAS is an effect that fetched
    // on mount and rendered the answer as if a shop had sent it, so that is
    // what is banned: the four assertions above name the request itself, and
    // this one stops any other on-mount fetch taking its place.
    const effects = code.match(/useEffect\(\s*\(\)\s*=>\s*\{[\s\S]*?\n  \}, \[/g) ?? [];
    for (const body of effects) {
      expect(body, "an effect in BookingSheet is fetching on mount").not.toMatch(/fetch\(/);
    }
    // The two fetches that remain are both inside user-triggered handlers.
    expect(code).toMatch(/fetch\("\/api\/bookings"/);
    expect(code).toMatch(/fetch\("\/api\/negotiate\/close-deal"/);
  });

  it("what it shows instead is derived from the shop's own offer", () => {
    expect(sheet).toMatch(/What the shop confirmed/);
    // The vehicle-identity gate's verdict, the per-extra verdicts and the
    // deposit - the three things a shop actually states.
    expect(sheet).toMatch(/off\?\.vehicleStatus === "confirmed" \|\| off\?\.verified === true/);
    expect(sheet).toMatch(/a\.state === "confirmed"/);
    expect(sheet).toMatch(/a\.state === "refused"/);
    // D5: the deposit line goes through depositSummary so EVERY alternative
    // the shop stated renders ("Passport or ฿4,000 cash"), never only the
    // first, and never the raw stored label.
    expect(sheet).toMatch(/depositSummary\(/);
    expect(sheet).toMatch(/depositLine/);
  });

  it("nothing confirmed says so, and says what to do about it", () => {
    expect(sheet).toMatch(
      /The shop has not confirmed the exact vehicle in writing yet\. Check it with them before you pay anything\./
    );
    // ...and it is not dressed as a success: the tick only appears with evidence.
    expect(sheet).toMatch(
      /vehicleConfirmed \|\| confirmedLines\.length \? "text-savings" : "text-faint"/
    );
  });

  it("the traveller's own request is still shown - as a REQUEST", () => {
    // The list did not stop being useful; it stopped pretending to be an answer.
    expect(sheet).toMatch(/t\("What you asked for"\)/);
  });
});

// ---------------------------------------------------------------------------
// W8 #29: A RESTORED HUNT LOST ITS REGION, AND ITS OFFERS LOST THEIR FUTURE.
// ---------------------------------------------------------------------------

describe("W8 #29a: the region label survives a restore", () => {
  it("REPRODUCTION: the label is what `region` is, everywhere", () => {
    const page = readCode("src/app/page.tsx");
    // Bargain draft, mass push, market hint - all pass origin.label as region.
    expect((page.match(/region: origin\?\.label/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(page).toMatch(/region=\{origin\?\.label \?\? ""\}/);
  });

  it("...and with no region the draft route loses BOTH levers", () => {
    const draft = readCode("src/app/api/bargain-draft/route.ts");
    // Currency resolution and the market floor are both region-derived.
    expect(draft).toMatch(/region/);
  });

  it("the search row stores the label the traveller named", () => {
    const route = readCode("src/app/api/vendors/route.ts");
    expect(route).toMatch(/origin: \{ lat: number; lng: number; label\?: string \}/);
    expect(route).toMatch(/hasLabel \? \{ origin_label: label \} : \{\}/);
    // Seatbelted: the column is additive, and one unknown column 400s the row.
    expect(route).toMatch(/tableReady\("searches", "origin_label"\)/);
    const page = readCode("src/app/page.tsx");
    expect(page).toMatch(/origin: \{ lat: origin\.lat, lng: origin\.lng, label: origin\.label \?\? "" \}/);
  });

  it("restore reads it back instead of hardcoding an empty label", () => {
    const restore = readCode("src/app/api/deals/restore/route.ts");
    expect(restore).not.toMatch(/lat: originRow\.lat, lng: originRow\.lng, label: ""/);
    expect(restore).toMatch(/r\.origin_label \?\? ""/);
  });

  it("the three column tiers stay independent - a new column cannot cost the old ones", () => {
    const restore = readCode("src/app/api/deals/restore/route.ts");
    // widest (origin_label) -> wide (rfq/snapshot) -> narrow. Collapsing the
    // first two would make a database missing only origin_label ALSO lose the
    // RFQ and the vendor snapshot.
    expect(restore).toMatch(/const widest = await sbSelectStrict<SearchRow>\(/);
    expect(restore).toMatch(/widest\.error !== "missing"/);
    expect(restore).toMatch(/rfq,snapshot,origin_label,created_at/);
    expect(restore).toMatch(/rfq,snapshot,created_at/);
    // An OUTAGE must still not trigger a fallback - retrying an unreachable
    // database with fewer columns just fails twice.
    expect(restore).toMatch(/error: "unavailable"/);
  });

  it("the column is additive, so an existing deploy can adopt it by re-running schema.sql", () => {
    const schema = raw("supabase/schema.sql");
    expect(schema).toMatch(
      /alter table public\.searches add column if not exists origin_label text;/
    );
  });
});

describe("W8 #29b: a restored offer is UNKNOWN, not un-presentable", () => {
  it("REPRODUCTION: false was a one-way latch the poll could not lift", () => {
    const replies = readCode("src/app/api/replies/route.ts");
    // The poll's answer for a thread with no state is `undefined`...
    expect(replies).toMatch(/presentable: st \? isComplete\(st, r\.deposit\) : undefined/);
    // ...and the client merges with `??`, so undefined falls back to whatever
    // was already there. A stamped `false` therefore survived forever.
    const page = readCode("src/app/page.tsx");
    expect(page).toMatch(/presentable: r\.presentable \?\? v\.offer\?\.presentable/);
  });

  it("restore stamps undefined - it has read a price and nothing else", () => {
    const restore = readCode("src/app/api/deals/restore/route.ts");
    expect(restore).toMatch(/presentable: undefined,/);
    expect(restore).not.toMatch(/presentable: false,/);
  });

  it("undefined renders no banner, and is still polled", () => {
    // VendorCard tests `=== false`, so unknown shows nothing...
    expect(readCode("src/components/VendorCard.tsx")).toMatch(/offer\.presentable === false &&/);
    // ...and the reply loop keeps running until it is positively true.
    expect(readCode("src/app/page.tsx")).toMatch(/v\.offer\.presentable !== true/);
  });
});

// ---------------------------------------------------------------------------
// W8 #30: the menu and the location question froze on early chatter.
// ---------------------------------------------------------------------------

describe("W8 #30: the live poll reads the NEWEST inbound, not the oldest", () => {
  const replies = readCode("src/app/api/replies/route.ts");

  it("REPRODUCTION: the window was `received_at.asc LIMIT 200`", () => {
    // The first two hundred messages of the session, forever. A 24-shop batch
    // with photo bursts crosses that easily, and everything after it was
    // invisible to the block that builds the card's price MENU and the shop's
    // "where are you staying?" question.
    expect(replies).not.toMatch(
      /reading:raw->reading[\s\S]{0,400}order=received_at\.asc&limit=200/
    );
  });

  it("it asks newest-first...", () => {
    expect(replies).toMatch(/const inboundDesc = await sbSelect</);
    expect(replies).toMatch(/order=received_at\.desc&limit=200`/);
  });

  it("...and restores arrival order, because both readers are order-sensitive", () => {
    // optionsFromThread reads a conversation forwards; the location scan walks
    // backwards from the end to find the shop's LATEST asking.
    expect(replies).toMatch(/const inbound = \[\.\.\.inboundDesc\]\.reverse\(\);/);
    expect(replies).toMatch(/for \(let i = bodies\.length - 1; i >= 0; i--\)/);
  });
});

// ---------------------------------------------------------------------------
// W8 #31: "contacting shops" while nobody had been contacted.
// ---------------------------------------------------------------------------

describe("W8 #31: the order status is evidence-driven, not phase-driven", () => {
  const page = readCode("src/app/page.tsx");

  it("REPRODUCTION: `running` is the funnel ANIMATION, and it messages nobody", () => {
    // runFunnel walks the local cards to "found" over a couple of seconds.
    expect(page).toMatch(/setPhase\("running"\);/);
    expect(page).toMatch(/schedule\(\(\) => setPhase\("done"\), list\.length \* 200 \+ 1400\);/);
    // Outreach is an explicit tap - the consent flow exists so nobody is
    // messaged without one - so nothing in this phase contacts a shop.
    expect(page).not.toMatch(/phase === "running" && \(\s*<span className="ml-auto/);
  });

  it("the claim is gated on a shop actually being messaged or queued", () => {
    expect(page).toMatch(/const contactingShops =/);
    expect(page).toMatch(
      /stageCounts\.messaged \+\s*stageCounts\.replied \+\s*Math\.max\(stageCounts\.queued, queueItems\.length\) >\s*0;/
    );
  });

  it("both spinners say the true thing for each state", () => {
    expect(page).toMatch(
      /contactingShops \? t\("Agents contacting shops"\) : t\("Getting your shops ready"\)/
    );
    // D7: the ORDER-STATUS spinner claims ongoing work, so it runs only while
    // delivery is genuinely in flight (queued/sending) - `contactingShops`
    // stays true for the life of the hunt and animated "contacting" forever.
    expect(page).toMatch(/const deliveringNow =/);
    expect(page).toMatch(/deliveringNow\s*\? t\("Order status: contacting shops"\)/);
    expect(page).toMatch(/: t\("Order status: getting your shops ready"\)/);
    expect(page).not.toMatch(/contactingShops\s*\? t\("Order status: contacting shops"\)/);
  });

  it("the new copy is in the translation catalogue", async () => {
    const { I18N_CATALOG } = await import("./i18n-catalog");
    const cat = new Set(I18N_CATALOG);
    for (const s of [
      "Getting your shops ready",
      "Order status: getting your shops ready",
      "Agents contacting shops",
      "Order status: contacting shops",
    ]) {
      expect(cat.has(s), `${s} missing from the catalogue`).toBe(true);
    }
  });
});
