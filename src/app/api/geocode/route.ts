import { NextResponse } from "next/server";
import { searchPlaces, reverseGeocode, resolvePlaceLocation } from "@/lib/google";

// Address / hotel search: Places (New) Autocomplete first (true prefix
// typeahead), then Text Search / Geocoding / OpenStreetMap Nominatim. Real
// data either way - no dummy dropdowns.
// With ?lat=&lng= it REVERSE-geocodes the traveller's GPS point into a real,
// named place (so "My location" resolves to e.g. "Bophut, Koh Samui,
// Thailand" and the local currency / language can be resolved from it).
// With ?placeId= it resolves a picked Autocomplete prediction to coordinates
// (one cheap Place Details call, closed under the same session token ?st=).
export async function GET(req: Request) {
  const { getSession } = await import("@/lib/session");
  const session = await getSession();
  if (!session) return NextResponse.json({ results: [], error: "signed-out" });
  // Management is never rate-limited here (the training studio depends on this
  // search), and every silent empty answer now says WHY - a mute dropdown made
  // the trainer look broken.
  if (session.role === "user") {
    const { checkDailyLimit, killSwitchOn } = await import("@/lib/usage");
    if (await killSwitchOn()) return NextResponse.json({ results: [], error: "paused" });
    const gate = await checkDailyLimit("geocode", session.email, "LIMIT_GEOCODE_PER_DAY", {
      plan: session.plan,
    });
    if (!gate.allowed) return NextResponse.json({ results: [], error: "daily-limit" });
    // The debit the gate above reads. `recordApi("geocoding")` in lib/google is
    // the COST tracker - a different kind, and no user_email - so this cap's
    // durable half summed to zero on every instance and only the in-memory
    // counter (reset by every cold start) was doing anything at all.
    const { recordApi } = await import("@/lib/usage");
    void recordApi("geocode", 1, session.email).catch(() => {});
  }

  const url = new URL(req.url);
  const st = url.searchParams.get("st")?.trim() || undefined;

  const placeId = url.searchParams.get("placeId")?.trim();
  if (placeId) {
    const label = url.searchParams.get("label")?.trim() || undefined;
    const place = await resolvePlaceLocation(placeId, label, st);
    return NextResponse.json({ place });
  }

  // CRITICAL: only treat this as a GPS reverse-geocode when lat/lng are
  // actually present. Number(null) is 0 (finite!), so checking Number(...)
  // alone silently hijacked EVERY ?q= text search into a reverse-geocode of
  // (0,0) - that single line was why autocomplete showed "No matches" in
  // production while the Google key itself tested green.
  const latRaw = url.searchParams.get("lat");
  const lngRaw = url.searchParams.get("lng");
  if (latRaw !== null && lngRaw !== null) {
    const lat = Number(latRaw);
    const lng = Number(lngRaw);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      const place = await reverseGeocode(lat, lng);
      return NextResponse.json({ place });
    }
  }

  const q = url.searchParams.get("q")?.trim() ?? "";
  // Suggest from 2 characters up (owner request: the most responsive autocomplete).
  if (q.length < 2) return NextResponse.json({ results: [] });
  const { results, error } = await searchPlaces(q, st);
  return NextResponse.json({ results, error });
}

// maxDuration: lift the request-timeout ceiling for slow upstreams.
export const maxDuration = 60;
