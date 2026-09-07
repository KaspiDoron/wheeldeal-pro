// AUDIT F147 - a free-plan booking must be able to leave `confirmed`.
//
// A free plan can create a booking (POST /api/bookings gates on the session
// only) and receives the "Did you return the vehicle? - tap to mark the trip
// completed" push that suggestCompletions sends to every plan. But /api/deals
// answered a free caller with `{locked:true, sessions:[], bookings:[]}` and the
// Trips page rendered only the upgrade gate, so the picked_up/completed taps -
// the ONLY writers of those two statuses - were unreachable. The booking stayed
// `confirmed` for ever, advanceBooking never ran, and the negotiation thread
// never reached the `completed` funnel stage.
//
// The traveller's own money record is not trips history. The locked branch now
// carries the lifecycle fields of their current rental and NOTHING else - no
// shop name, no price, no hunt - so the paywall is exactly as tight as it was.
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SHOP = "Krabi Bike Rent";
const PRICE = 250;
const HUNT_AT = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const PICKUP = "2026-09-20T10:00:00";

type StrictAnswer = { rows: Record<string, unknown>[] } | { error: "missing" | "unavailable" };

async function loadDealsGET(plan: string | null, bookingsStrict: StrictAnswer) {
  vi.resetModules();
  vi.doMock("@/lib/session", () => ({
    getSession: async () => ({ email: "t@example.com", plan }),
  }));
  vi.doMock("@/lib/google", () => ({ reverseGeocode: async () => null }));
  vi.doMock("@/lib/runtime-config", () => ({
    pgTimestamp: (iso: string) => encodeURIComponent(iso),
    sbSelectStrict: async (table: string) => {
      if (table === "searches") {
        return {
          rows: [
            {
              id: 1,
              query_text: "Ao Nang scooter",
              radius_km: 5,
              vehicle_class: "scooter",
              source: "vendors",
              results: 4,
              lat: 8.03,
              lng: 98.82,
              created_at: HUNT_AT,
            },
          ],
        };
      }
      if (table === "bookings") return bookingsStrict;
      return { error: "missing" as const };
    },
    sbSelect: async (table: string) => {
      if (table === "bookings") {
        return [
          {
            id: 77,
            vendor_name: SHOP,
            price_per_day: PRICE,
            total_price: PRICE * 2,
            currency: "THB",
            fulfillment: "pickup",
            scheduled_at: PICKUP,
            status: "confirmed",
            duration_days: 2,
            created_at: HUNT_AT,
          },
        ];
      }
      return [];
    },
  }));
  const mod = await import("@/app/api/deals/route");
  return mod.GET;
}

const liveBooking = {
  rows: [{ id: 77, status: "confirmed", scheduled_at: PICKUP, duration_days: 2 }],
} as StrictAnswer;

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("@/lib/session");
  vi.doUnmock("@/lib/google");
  vi.doUnmock("@/lib/runtime-config");
});

describe("F147 - the free plan's own rental reaches the page that ends it", () => {
  it("THE BUG: a free caller with a live booking gets the lifecycle fields", async () => {
    const GET = await loadDealsGET("free", liveBooking);
    const body = await (await GET()).json();
    expect(body.locked).toBe(true);
    expect(body.rental).toEqual({
      id: 77,
      status: "confirmed",
      scheduledAt: PICKUP,
      durationDays: 2,
    });
  });

  it("...and the paywall is not one byte looser", async () => {
    const GET = await loadDealsGET("free", liveBooking);
    const body = await (await GET()).json();
    // The gate's own assertions, unchanged.
    expect(body.sessions).toEqual([]);
    expect(body.bookings).toEqual([]);
    const wire = JSON.stringify(body);
    expect(wire).not.toContain(SHOP);
    expect(wire).not.toContain(String(PRICE));
    expect(wire).not.toContain("Ao Nang");
  });

  it("a rental already completed is not offered again", async () => {
    const GET = await loadDealsGET("free", { rows: [] });
    const body = await (await GET()).json();
    expect(body.rental).toBeNull();
    expect(body.rentalUnknown).toBe(false);
  });

  it("a store that cannot be read says UNKNOWN, never a confident no-rental", async () => {
    const GET = await loadDealsGET("free", { error: "unavailable" });
    const body = await (await GET()).json();
    expect(body.rental).toBeNull();
    expect(body.rentalUnknown).toBe(true);
  });

  it("a database with no bookings table yet is a real absence, not an unknown", async () => {
    const GET = await loadDealsGET("free", { error: "missing" });
    const body = await (await GET()).json();
    expect(body.rental).toBeNull();
    expect(body.rentalUnknown).toBe(false);
  });

  it("a paying caller is untouched - the full hunt, no locked branch", async () => {
    const GET = await loadDealsGET("pro", liveBooking);
    const body = await (await GET()).json();
    expect(body.locked).toBeUndefined();
    expect(body.sessions).toHaveLength(1);
  });
});

describe("F147 - the taps the push points at actually render", () => {
  const page = readFileSync(join(process.cwd(), "src/app/deals/page.tsx"), "utf8");

  it("the locked page reads the rental the route now ships", () => {
    expect(page).toContain("rental");
    expect(page).toMatch(/lockedRental/);
  });

  it("its two taps are the same PATCH the paid card uses", () => {
    // One writer, not a second copy of the lifecycle rules - and the honest
    // per-booking failure note rides along with it.
    expect(page).toContain('tapBookingAction(r.id, "picked_up")');
    expect(page).toContain('tapBookingAction(r.id, "completed")');
    expect(page).toContain("bookingNote[r.id]");
  });

  it("an unreadable answer is said out loud, not rendered as no rental", () => {
    expect(page).toContain("rentalUnknown");
  });
});
