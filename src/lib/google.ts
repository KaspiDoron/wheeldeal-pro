// Google Maps Platform integration (server-side only - the key never reaches
// the browser; all calls are proxied through our API routes).
//
// IMPORTANT: keys created recently only work with "Places API (New)"
// (places.googleapis.com). We therefore call the NEW API first and fall back
// to the legacy endpoints for old keys. Errors are never swallowed - the
// exact Google status is surfaced so the admin can fix the key/console setup.
//
// With GOOGLE_MAPS_API_KEY configured:
//   - address/hotel search uses Places Text Search (finds hotels, POIs,
//     addresses - much better than plain geocoding), with Geocoding + OSM
//     Nominatim fallbacks
//   - vendor discovery uses Places Text Search around the stay (real rental
//     businesses)
//   - reviews/phone come from Place Details
//   - photos stream through /api/photo
// Without it, geocoding falls back to OpenStreetMap Nominatim (free, real
// data), and vendors fall back to clearly-labelled demo seeds.

import "server-only";
import { getConfig } from "./runtime-config";
import { haversineKm } from "./geo";
import { cacheGet, cacheSet, recordApi } from "./usage";
import type { Vendor, VehicleClass, VendorReview } from "./types";
import { digitsOnly } from "./phone";
import { mentionsClass, profileFor } from "./vehicle/class-profile";
import { resolveSiteHost } from "./site";

declare global {
  // eslint-disable-next-line no-var
  var __wd_last_maps_key__: string | undefined;
}

// fetch with a hard 12s timeout so a stalled Google Places response cannot hang
// a search request for the full request-timeout ceiling under load. The deadline
// stays armed across the body read (fetch resolves at headers; callers then
// await res.json()/res.text()); the timer is unref'd so it never holds the
// runtime, and an abort after completion is a harmless no-op. On abort fetch
// throws, which every call site's existing catch maps to the API fallback.
// A SHOP SEARCH HAS A BUDGET.
//
// This was 12 seconds per call, and the discovery chain makes more than one -
// a modern text search, then a legacy nearby search when that fails. Two
// timeouts in a row is 24 seconds of a traveller staring at a spinner, before
// the surrounding Supabase reads. Shops are supposed to be on screen in under
// ten. Seven seconds is far longer than a healthy Places call (they answer in
// a few hundred milliseconds); anything slower is not coming back in a useful
// time, and failing over quickly beats waiting politely.
const CALL_BUDGET_MS = 7_000;

async function timedFetch(url: string, init: RequestInit = {}, ms = CALL_BUDGET_MS): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  (timer as { unref?: () => void }).unref?.();
  return fetch(url, { ...init, signal: ctrl.signal });
}

export async function mapsKey(): Promise<string | undefined> {
  // Trim defensively: a key pasted into the host env with a trailing newline/space
  // breaks the X-Goog-Api-Key header while LOOKING configured.
  const k = (await getConfig("GOOGLE_MAPS_API_KEY"))?.trim();
  if (k) {
    // Last-known-good memo: if a later Supabase config read hiccups on this
    // instance (cold start, transient network), the key must NOT vanish -
    // that intermittent loss is what made autocomplete "randomly" empty.
    globalThis.__wd_last_maps_key__ = k;
    return k;
  }
  return globalThis.__wd_last_maps_key__;
}

const NEW_BASE = "https://places.googleapis.com/v1";

// ---- Geocoding / address search ---------------------------------------------

export interface PlaceSuggestion {
  label: string;
  lat: number;
  lng: number;
  source: "google" | "osm";
  // Places API (New) Autocomplete predictions carry a placeId instead of
  // coordinates; the client resolves lat/lng on pick via /api/geocode?placeId=
  // (one cheap Place Details call, closed under the same session token).
  placeId?: string;
}

/** Places API (New) Text Search - also the best "find my hotel" search. */
async function newTextSearch(
  key: string,
  body: Record<string, unknown>,
  fieldMask: string
): Promise<{ places: any[] | null; error?: string }> {
  try {
    const res = await timedFetch(`${NEW_BASE}/places:searchText`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": fieldMask,
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        places: null,
        error:
          data?.error?.message ??
          `Places API (New) responded ${res.status} - enable "Places API (New)" for this key in Google Cloud Console.`,
      };
    }
    return { places: (data.places as any[]) ?? [] };
  } catch (e) {
    return {
      places: null,
      error: e instanceof Error ? e.message : "network error reaching Google",
    };
  }
}

export interface PlaceSearchResult {
  results: PlaceSuggestion[];
  // When a Maps key IS set but every Google path failed, this carries the exact
  // Google reason so the picker can tell the owner how to fix the key (instead
  // of a mute empty dropdown). Never set when we have results.
  error?: string;
}

/**
 * Places API (New) Autocomplete - the purpose-built prefix typeahead. Returns
 * predictions with placeIds (no coordinates - those come from one Place
 * Details call when the traveller picks). With a sessionToken the whole typing
 * session bills as ONE autocomplete session instead of per keystroke.
 */
async function newAutocomplete(
  key: string,
  input: string,
  sessionToken?: string
): Promise<{ predictions: PlaceSuggestion[] | null; error?: string }> {
  try {
    const body: Record<string, unknown> = { input };
    if (sessionToken) body.sessionToken = sessionToken;
    const res = await timedFetch(`${NEW_BASE}/places:autocomplete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        predictions: null,
        error:
          data?.error?.message ??
          `Places Autocomplete responded ${res.status} - enable "Places API (New)" for this key.`,
      };
    }
    const predictions = ((data.suggestions as any[]) ?? [])
      .map((s) => s?.placePrediction)
      .filter((p) => p?.placeId && p?.text?.text)
      .slice(0, MAX_SUGGESTIONS)
      .map((p) => ({
        label: p.text.text as string,
        lat: 0,
        lng: 0,
        source: "google" as const,
        placeId: p.placeId as string,
      }));
    return { predictions };
  } catch (e) {
    return {
      predictions: null,
      error: e instanceof Error ? e.message : "network error reaching Google",
    };
  }
}

/**
 * Resolve a picked Autocomplete prediction to coordinates via Place Details
 * (New) with a location-only field mask (cheapest Details SKU). Passing the
 * same sessionToken closes the autocomplete billing session. Falls back to a
 * Text Search on the label so a pick NEVER dead-ends.
 */
export async function resolvePlaceLocation(
  placeId: string,
  label?: string,
  sessionToken?: string
): Promise<{ label: string; lat: number; lng: number } | null> {
  const key = await mapsKey();
  // DISTINCT NAMESPACE from placeDetails (OR11 E2.4). Both used `pd:<id>` with
  // INCOMPATIBLE shapes - a {label,lat,lng} here vs a {phone,rating,reviews,...}
  // there - so whichever populated the key first poisoned the other: a shop
  // resolved for its coordinates then read back as a details object with NaN
  // lat/lng (a broken map pin), or details read back as a location with no
  // phone/rating/reviews. Location-only key.
  const ck = `ploc:${placeId}`;
  const cached = cacheGet<{ label: string; lat: number; lng: number }>(ck);
  if (cached) return cached;
  if (key) {
    try {
      const st = sessionToken ? `?sessionToken=${encodeURIComponent(sessionToken)}` : "";
      const res = await timedFetch(`${NEW_BASE}/places/${encodeURIComponent(placeId)}${st}`, {
        headers: {
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": "location,formattedAddress,displayName",
        },
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      await recordApi("place_details");
      const lat = data?.location?.latitude;
      const lng = data?.location?.longitude;
      if (res.ok && Number.isFinite(lat) && Number.isFinite(lng)) {
        const out = {
          label:
            label ??
            [data.displayName?.text, data.formattedAddress].filter(Boolean).join(" - "),
          lat: lat as number,
          lng: lng as number,
        };
        cacheSet(ck, out, 24 * 3600_000);
        return out;
      }
    } catch {
      /* fall through to text search on the label */
    }
  }
  if (label) {
    const { results } = await searchPlaces(label, undefined, { skipAutocomplete: true });
    const hit = results.find((r) => Number.isFinite(r.lat) && (r.lat !== 0 || r.lng !== 0));
    if (hit) return { label: hit.label, lat: hit.lat, lng: hit.lng };
  }
  return null;
}

// Up to 10 rich suggestions per query so 2-letter typing shows a full list.
const MAX_SUGGESTIONS = 10;

// A descriptive, contactable User-Agent keeps Nominatim from throttling us as
// aggressively (their policy requires identifying the app). Include the deploy
// origin when we know it - the admin-set APP_DOMAIN wins over build-time env.
async function nominatimUA(): Promise<string> {
  return `WheelDeal/1.0 (vehicle-rental app; ${await resolveSiteHost()})`;
}

export async function searchPlaces(
  q: string,
  sessionToken?: string,
  opts?: { skipAutocomplete?: boolean }
): Promise<PlaceSearchResult> {
  const key = await mapsKey();

  // Cache identical queries for a day - address text never changes that fast,
  // and every cache hit is a free request.
  const ck = `sp:${q.trim().toLowerCase()}`;
  const cached = cacheGet<PlaceSuggestion[]>(ck);
  if (cached) return { results: cached };

  let googleError: string | undefined;
  // A missing server-side key must NEVER read as a mute "No matches" - the
  // owner needs to see WHY the dropdown is empty (this exact silence made
  // production autocomplete look broken while the key sat unset).
  if (!key) {
    googleError =
      "Google Maps key is not reaching the server - check GOOGLE_MAPS_API_KEY in Admin -> Keys (or the host env), then run 'Test Google key'";
  }

  if (key && !opts?.skipAutocomplete) {
    // 1) Places API (New) Autocomplete: THE prefix typeahead - matches partial
    // input ("Cangg") far better than Text Search and, with a session token,
    // an entire typing session bills as a single request.
    const { predictions, error } = await newAutocomplete(key, q, sessionToken);
    await recordApi("places_autocomplete");
    if (error) googleError = error;
    if (predictions && predictions.length) {
      cacheSet(ck, predictions, 24 * 3600_000);
      return { results: predictions };
    }
  }

  if (key) {
    // 2) Places API (New) Text Search: finds hotels, businesses, addresses.
    const { places, error } = await newTextSearch(
      key,
      { textQuery: q, maxResultCount: MAX_SUGGESTIONS },
      "places.displayName,places.formattedAddress,places.location"
    );
    await recordApi("places_search");
    if (error) googleError = error;
    if (places && places.length) {
      const out = places.map((p) => ({
        label: [p.displayName?.text, p.formattedAddress]
          .filter(Boolean)
          .join(" - "),
        lat: p.location?.latitude ?? 0,
        lng: p.location?.longitude ?? 0,
        source: "google" as const,
      }));
      cacheSet(ck, out, 24 * 3600_000);
      return { results: out };
    }

    // 3) Legacy Geocoding (works on older keys).
    try {
      const res = await timedFetch(
        `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
          q
        )}&key=${key}`,
        { cache: "no-store" }
      );
      const data = await res.json();
      await recordApi("geocoding");
      if (data.status === "OK") {
        const out = (data.results as any[]).slice(0, MAX_SUGGESTIONS).map((r) => ({
          label: r.formatted_address,
          lat: r.geometry.location.lat,
          lng: r.geometry.location.lng,
          source: "google" as const,
        }));
        cacheSet(ck, out, 24 * 3600_000);
        return { results: out };
      }
      if (data.status && data.status !== "ZERO_RESULTS") {
        googleError =
          googleError ??
          `${data.status}${data.error_message ? `: ${data.error_message}` : ""}`;
      }
    } catch {
      /* fall through to OSM */
    }
  }

  // 4) OpenStreetMap Nominatim - free, real data, no key needed. NOTE: it
  // often throttles/blocks datacenter IPs, so its failure must also
  // surface instead of masquerading as "no matches".
  try {
    const res = await timedFetch(
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=${MAX_SUGGESTIONS}&q=${encodeURIComponent(
        q
      )}`,
      {
        headers: { "User-Agent": await nominatimUA() },
        cache: "no-store",
      }
    );
    if (!res.ok) {
      return {
        results: [],
        error: googleError ?? `fallback place search rejected the request (${res.status})`,
      };
    }
    const data = (await res.json()) as any[];
    const out = (Array.isArray(data) ? data : []).map((r) => ({
      label: r.display_name,
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon),
      source: "osm" as const,
    }));
    // Surface the Google error only when BOTH tiers came up empty - so the owner
    // learns the key needs "Places API (New)" enabled even though OSM saved the UX.
    return { results: out, error: out.length ? undefined : googleError };
  } catch {
    return { results: [], error: googleError ?? "place search is unreachable right now" };
  }
}

/**
 * Reverse-geocode a lat/lng into a human place label that ENDS in the country
 * (so `currencyForRegion` and the local-language agents work). Google first,
 * OpenStreetMap Nominatim as the free fallback. Returns null on total failure
 * so callers can keep the raw coordinates. Cached for a day per rounded point.
 */
export async function reverseGeocode(
  lat: number,
  lng: number
): Promise<{ label: string; country?: string } | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const rlat = Math.round(lat * 1000) / 1000;
  const rlng = Math.round(lng * 1000) / 1000;
  const ck = `rev:${rlat},${rlng}`;
  const cached = cacheGet<{ label: string; country?: string }>(ck);
  if (cached) return cached;

  const key = await mapsKey();
  if (key) {
    try {
      const res = await timedFetch(
        `https://maps.googleapis.com/maps/api/geocode/json?latlng=${rlat},${rlng}&key=${key}`,
        { cache: "no-store" }
      );
      const data = await res.json();
      await recordApi("geocoding");
      if (data.status === "OK" && data.results?.length) {
        // Prefer a locality-level result; fall back to the first (most precise).
        const pick =
          (data.results as any[]).find((r) =>
            r.types?.some((t: string) => ["locality", "postal_town", "administrative_area_level_2"].includes(t))
          ) ?? data.results[0];
        const country = (pick.address_components as any[])?.find((c) =>
          c.types?.includes("country")
        )?.long_name;
        const out = { label: pick.formatted_address as string, country };
        cacheSet(ck, out, 24 * 3600_000);
        return out;
      }
    } catch {
      /* fall through to OSM */
    }
  }

  // OpenStreetMap Nominatim reverse - free, real data, no key.
  try {
    const res = await timedFetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=12&lat=${rlat}&lon=${rlng}`,
      {
        headers: { "User-Agent": "WheelDeal/1.0 (rental savings app)" },
        cache: "no-store",
      }
    );
    const data = (await res.json()) as any;
    if (data?.display_name) {
      const out = {
        label: data.display_name as string,
        country: data.address?.country as string | undefined,
      };
      cacheSet(ck, out, 24 * 3600_000);
      return out;
    }
  } catch {
    /* give up - caller keeps the raw coordinates */
  }
  return null;
}

// ---- Vendor discovery ----------------------------------------------------------

const KEYWORDS: Record<VehicleClass, string> = {
  car: "car rental",
  motorbike: "motorcycle rental",
  scooter: "scooter rental",
};

export interface VendorDiscovery {
  vendors: Vendor[] | null; // null = no key OR the search failed (see error)
  error?: string; // exact Google error when a configured key failed
}

function newPlaceToVendor(
  p: any,
  origin: { lat: number; lng: number },
  vehicleClass: VehicleClass,
  i: number
): Vendor {
  const loc = {
    lat: p.location?.latitude ?? origin.lat,
    lng: p.location?.longitude ?? origin.lng,
  };
  const photoUrls: string[] = ((p.photos as any[]) ?? [])
    .filter((ph) => ph?.name)
    .slice(0, 12) // Google returns up to ~10; show them all, not just 6.
    .map((ph) => `/api/photo?name=${encodeURIComponent(ph.name)}`);
  // Today's opening line from Google's weekday descriptions.
  const weekday: string[] = p.currentOpeningHours?.weekdayDescriptions ?? [];
  const jsDay = new Date().getDay(); // 0=Sun; Google lists Mon..Sun
  const todayHours = weekday.length === 7 ? weekday[(jsDay + 6) % 7] : undefined;
  return {
    id: p.id ?? `g${i}`,
    placeId: p.id,
    name: p.displayName?.text ?? "Rental",
    lat: loc.lat,
    lng: loc.lng,
    rating: p.rating ?? 0,
    reviews: p.userRatingCount ?? 0,
    vehicleClasses: [vehicleClass],
    // EVIDENCE, not a restatement of the search. `vehicleClasses` above says
    // "this came back for a car search", which is a fact about our query, not
    // about the shop - so a "definitely rents cars" filter built on it would be
    // decoration. This says the shop's own listing NAMES the class, which is
    // something we actually observed.
    classEvidence: mentionsClass(
      `${p.displayName?.text ?? ""} ${(p.types ?? []).join(" ")} ${p.primaryTypeDisplayName?.text ?? ""}`,
      profileFor(vehicleClass)
    ),
    fulfillment: ["in-store", "hotel-delivery"],
    whatsapp: (p.internationalPhoneNumber ?? "").trim(),
    basePricePerDay: 0,
    partner: false,
    demo: false,
    address: p.formattedAddress,
    openNow: p.currentOpeningHours?.openNow,
    todayHours,
    priceLevel: undefined,
    photoUrl: photoUrls[0],
    photoUrls,
    distanceKm: haversineKm(origin, loc),
  } satisfies Vendor;
}

export async function findRealVendors(
  origin: { lat: number; lng: number },
  radiusKm: number,
  vehicleClass: VehicleClass,
  /** The traveller's app language (BCP-47-ish, e.g. "he"). Google localises
   *  formattedAddress and opening hours to it - without this a Hebrew app
   *  showed "Wednesday: Open 24 hours" inside an otherwise translated card. */
  lang?: string
): Promise<VendorDiscovery> {
  const key = await mapsKey();
  if (!key) return { vendors: null };

  // Only a sane language tag reaches Google or the cache key.
  const langCode = lang && /^[a-zA-Z-]{2,8}$/.test(lang) ? lang : undefined;

  // ~110m coordinate rounding + 10 min TTL: repeated searches around the same
  // stay cost ZERO extra Places requests. The LANGUAGE is part of the key -
  // localised fields make the cached payload language-specific, and without
  // it a Hebrew search within 10 minutes of an English one (or vice versa)
  // served the other locale's strings to everyone nearby.
  const ck = `fv:${origin.lat.toFixed(3)},${origin.lng.toFixed(3)},${Math.round(radiusKm)},${vehicleClass},${langCode ?? "en"}`;
  const cached = cacheGet<VendorDiscovery>(ck);
  if (cached) return cached;

  // 1) Places API (New) Text Search with a location bias circle.
  const { places, error: newError } = await newTextSearch(
    key,
    {
      textQuery: KEYWORDS[vehicleClass],
      maxResultCount: 20,
      ...(langCode ? { languageCode: langCode } : {}),
      locationBias: {
        circle: {
          center: { latitude: origin.lat, longitude: origin.lng },
          radius: Math.min(50000, radiusKm * 1000),
        },
      },
    },
    [
      "places.id",
      "places.displayName",
      "places.location",
      "places.rating",
      "places.userRatingCount",
      "places.formattedAddress",
      "places.currentOpeningHours",
      "places.internationalPhoneNumber",
      "places.photos",
    ].join(",")
  );
  await recordApi("places_search");
  if (places) {
    const mapped = places.map((p, i) => newPlaceToVendor(p, origin, vehicleClass, i));
    // Never surface shops we cannot actually message: drop any without a usable
    // phone number. (If that would empty the list, keep them so the map/list is
    // not blank, but the card still gates "Ask for price" on a real number.)
    const reachable = mapped.filter(
      (v) => digitsOnly(v.whatsapp).length >= 7
    );
    const list = reachable.length > 0 ? reachable : mapped;
    // Tag the fastest-replying quartile (Ultra insight).
    const { fastResponderPhones } = await import("./stats");
    const fast = await fastResponderPhones();
    if (fast.size) {
      for (const v of list) {
        if (fast.has(digitsOnly(v.whatsapp))) v.fastResponder = true;
      }
    }
    // Paid placements: glowing "Recommended" cards pinned to the top.
    const { tagSponsored } = await import("./sponsored");
    await tagSponsored(list);
    const out = { vendors: list };
    // SIX HOURS, NOT TEN MINUTES - the one Places lever that costs nothing.
    //
    // This is Text Search (Enterprise + Atmosphere), Google's top SKU tier, and
    // the audit put the worst case at ~22,500 calls/month across a 50-user
    // beta - the only line item in the whole system with unbounded dollar
    // downside. A ten-minute TTL meant a traveller reopening their hunt after
    // lunch re-bought the entire shop list.
    //
    // Six hours is honest for what this actually is: the set of rental shops
    // near a hotel does not change during a trip. (Note SCALING.md claimed
    // "cached for a day" - that was only ever true of GEOCODING; this read was
    // on ten minutes. The doc is corrected alongside this.)
    //
    // NOT DONE, deliberately: dropping `places.rating` / `userRatingCount` to
    // fall two SKU tiers. Those fields are rendered on VendorCard,
    // CompareSheet, MassBargainPreview and ReviewsSheet - removing them is a
    // visible product regression, not a cost optimisation.
    cacheSet(ck, out, 6 * 3600_000);
    return out;
  }

  // 2) Legacy Nearby Search (older keys).
  try {
    const res = await timedFetch(
      `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${origin.lat},${origin.lng}&radius=${Math.min(
        50000,
        radiusKm * 1000
      )}&keyword=${encodeURIComponent(KEYWORDS[vehicleClass])}&key=${key}`,
      { cache: "no-store" }
    );
    const data = await res.json();
    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      throw new Error(
        `${data.status}${data.error_message ? `: ${data.error_message}` : ""}`
      );
    }
    return {
      vendors: ((data.results as any[]) || []).map((p, i) => {
        const loc = p.geometry?.location ?? { lat: origin.lat, lng: origin.lng };
        return {
          id: p.place_id ?? `g${i}`,
          placeId: p.place_id,
          name: p.name ?? "Rental",
          lat: loc.lat,
          lng: loc.lng,
          rating: p.rating ?? 0,
          reviews: p.user_ratings_total ?? 0,
          vehicleClasses: [vehicleClass],
          fulfillment: ["in-store", "hotel-delivery"],
          whatsapp: "", // resolved on demand via Place Details
          basePricePerDay: 0,
          partner: false,
          demo: false,
          address: p.vicinity,
          openNow: p.opening_hours?.open_now,
          priceLevel: p.price_level,
          photoUrl: p.photos?.[0]?.photo_reference
            ? `/api/photo?ref=${encodeURIComponent(p.photos[0].photo_reference)}`
            : undefined,
          distanceKm: haversineKm(origin, loc),
        } satisfies Vendor;
      }),
    };
  } catch (e) {
    const legacyError = e instanceof Error ? e.message : "network error";
    return {
      vendors: null,
      error: `Google Maps key is set but both Places APIs failed. New API: ${
        newError ?? "unknown"
      }. Legacy API: ${legacyError}. In Google Cloud Console enable "Places API (New)" (and optionally the legacy "Places API") for this key, and remove API restrictions that exclude them.`,
    };
  }
}

// ---- Place details: phone + reviews -------------------------------------------

export interface PlaceDetailsResult {
  phone?: string;
  reviews: VendorReview[];
  rating?: number;
  total?: number;
  address?: string;
  website?: string;
}

export async function placeDetails(placeId: string): Promise<PlaceDetailsResult | null> {
  const key = await mapsKey();
  if (!key) return null;

  // Details rarely change - cache 6 hours per place. Namespaced apart from
  // resolvePlaceLocation's `ploc:` key (OR11 E2.4): they cache incompatible
  // shapes and used to collide on a shared `pd:` key.
  const ck = `pdet:${placeId}`;
  const cached = cacheGet<PlaceDetailsResult>(ck);
  if (cached) return cached;
  await recordApi("place_details");

  // 1) Places API (New) details.
  try {
    const res = await timedFetch(`${NEW_BASE}/places/${encodeURIComponent(placeId)}`, {
      headers: {
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask":
          "internationalPhoneNumber,nationalPhoneNumber,rating,userRatingCount,formattedAddress,websiteUri,reviews",
      },
      cache: "no-store",
    });
    if (res.ok) {
      const r = await res.json();
      const out: PlaceDetailsResult = {
        phone: r.internationalPhoneNumber ?? r.nationalPhoneNumber,
        rating: r.rating,
        total: r.userRatingCount,
        address: r.formattedAddress,
        website: r.websiteUri,
        reviews: ((r.reviews as any[]) || []).map((rv) => ({
          author: rv.authorAttribution?.displayName ?? "Traveller",
          rating: rv.rating ?? 0,
          text: rv.text?.text ?? "",
          timeAgo: rv.relativePublishTimeDescription ?? "",
          timestamp: rv.publishTime ? Date.parse(rv.publishTime) : 0,
        })),
      };
      cacheSet(ck, out, 6 * 3600_000);
      return out;
    }
  } catch {
    /* try legacy */
  }

  // 2) Legacy Place Details.
  try {
    const res = await timedFetch(
      `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=international_phone_number,formatted_phone_number,reviews,rating,user_ratings_total,formatted_address,website&key=${key}`,
      { cache: "no-store" }
    );
    const data = await res.json();
    if (data.status !== "OK") return null;
    const r = data.result;
    const out: PlaceDetailsResult = {
      phone: r.international_phone_number ?? r.formatted_phone_number,
      rating: r.rating,
      total: r.user_ratings_total,
      address: r.formatted_address,
      website: r.website,
      reviews: ((r.reviews as any[]) || []).map((rv) => ({
        author: rv.author_name ?? "Traveller",
        rating: rv.rating ?? 0,
        text: rv.text ?? "",
        timeAgo: rv.relative_time_description ?? "",
        timestamp: (rv.time ?? 0) * 1000,
      })),
    };
    cacheSet(ck, out, 6 * 3600_000);
    return out;
  } catch {
    return null;
  }
}

// ---- Key diagnostics (admin "Test key" button) ---------------------------------

export interface MapsDiagnostics {
  keyConfigured: boolean;
  placesNew: { ok: boolean; detail: string };
  placesAutocomplete: { ok: boolean; detail: string };
  placesLegacy: { ok: boolean; detail: string };
  geocoding: { ok: boolean; detail: string };
  /** Shop photos. Billed as its own SKU and enabled separately from search,
   *  so it can fail on its own - which is exactly how it failed in the field:
   *  every card photo broken while this whole panel reported green, because
   *  nothing here had ever actually fetched an image. */
  placePhotos: { ok: boolean; detail: string };
  /**
   * THE KEYLESS FALLBACK, WHICH IS ALSO A PRODUCTION PATH (Wave 7).
   *
   * OpenStreetMap Nominatim carries place search AND reverse geocoding
   * whenever Google is unset, over quota or restricted - including the
   * no-key path a fresh deployment runs on. Its own comment in this file
   * says it "often throttles/blocks datacenter IPs", and a scaled
   * deployment is by definition a datacenter IP, so the single most
   * likely time for it to be blocked is the moment it is most needed.
   * Nothing probed it. It is probed here, WITH or WITHOUT a Google key,
   * because "no key configured" never meant "no geocoder configured".
   */
  nominatim: { ok: boolean; detail: string };
}

/**
 * One real Nominatim search, with the same User-Agent the app sends.
 *
 * A 403 or 429 here is the honest signal that the free fallback is refusing
 * this deployment's IP - the failure that renders as an empty suggestion list
 * with no explanation anywhere.
 */
export async function probeNominatim(): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await timedFetch(
      "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=Canggu%20Bali",
      { headers: { "User-Agent": await nominatimUA() }, cache: "no-store" }
    );
    if (!res.ok) {
      return {
        ok: false,
        detail:
          res.status === 403 || res.status === 429
            ? `HTTP ${res.status} - OpenStreetMap is blocking or throttling this server's IP. With no Google key, address search and reverse geocoding return nothing.`
            : `HTTP ${res.status} from Nominatim.`,
      };
    }
    const data = (await res.json()) as unknown;
    const n = Array.isArray(data) ? data.length : 0;
    return n > 0
      ? { ok: true, detail: `OK - ${n} result(s). The keyless geocoder fallback is reachable.` }
      : { ok: false, detail: "Answered 200 with no results - unexpected for a known place; treat as degraded." };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : "unreachable" };
  }
}

/**
 * Fetch ONE real photo end to end and report Google's verbatim answer.
 *
 * Deliberately does the whole round trip - search for a place that has photos,
 * then pull the media - because those are two different SKUs and only the
 * second one produces the bytes a traveller sees.
 */
async function probePlacePhoto(key: string, lat: number, lng: number): Promise<{ ok: boolean; detail: string }> {
  const { places, error } = await newTextSearch(
    key,
    {
      textQuery: "scooter rental",
      maxResultCount: 1,
      locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: 10000 } },
    },
    "places.id,places.photos"
  );
  if (!places) return { ok: false, detail: `search failed: ${error ?? "unknown"}` };
  const name = (places[0]?.photos as any[] | undefined)?.[0]?.name;
  if (!name) return { ok: false, detail: "No place with photos nearby - inconclusive." };
  try {
    const res = await timedFetch(
      `${NEW_BASE}/${name}/media?key=${key}&maxWidthPx=200`,
      { cache: "no-store" }
    );
    if (res.ok) {
      const type = res.headers.get("Content-Type") ?? "";
      return type.startsWith("image/")
        ? { ok: true, detail: `OK - ${type}.` }
        : { ok: false, detail: `Got ${res.status} but Content-Type was "${type}", not an image.` };
    }
    // The whole point: surface Google's own words. "Places API (New) has not
    // been used in project X" and "quota exceeded" are different problems with
    // different fixes, and a bare 404 told the owner neither.
    const body = await res.text().catch(() => "");
    let msg = "";
    try {
      msg = JSON.parse(body)?.error?.message ?? "";
    } catch {
      msg = body.slice(0, 300);
    }
    return { ok: false, detail: `Google responded ${res.status}${msg ? `: ${msg}` : ""}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : "network error" };
  }
}

/** Run a real request against each Google API and report the exact outcome. */
export async function runMapsDiagnostics(): Promise<MapsDiagnostics> {
  const key = await mapsKey();
  if (!key) {
    const off = { ok: false, detail: "No key configured." };
    // NOT "no geocoder": with no Google key, Nominatim IS the geocoder, so it
    // is the one thing that must still be probed on this branch.
    return {
      keyConfigured: false,
      placesNew: off,
      placesAutocomplete: off,
      placesLegacy: off,
      geocoding: off,
      placePhotos: off,
      nominatim: await probeNominatim(),
    };
  }

  const probe = { lat: -8.6478, lng: 115.1385 }; // Canggu, Bali

  const [n, a, l, g, ph, osm] = await Promise.all([
    (async () => {
      const { places, error } = await newTextSearch(
        key,
        {
          textQuery: "scooter rental",
          maxResultCount: 1,
          locationBias: {
            circle: { center: { latitude: probe.lat, longitude: probe.lng }, radius: 10000 },
          },
        },
        "places.id,places.displayName"
      );
      return places
        ? { ok: true, detail: `OK - found ${places.length} result(s).` }
        : { ok: false, detail: error ?? "failed" };
    })(),
    (async () => {
      const { predictions, error } = await newAutocomplete(key, "Canggu");
      return predictions
        ? { ok: true, detail: `OK - ${predictions.length} suggestion(s).` }
        : { ok: false, detail: error ?? "failed" };
    })(),
    (async () => {
      try {
        const res = await timedFetch(
          `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${probe.lat},${probe.lng}&radius=10000&keyword=scooter%20rental&key=${key}`,
          { cache: "no-store" }
        );
        const data = await res.json();
        return data.status === "OK" || data.status === "ZERO_RESULTS"
          ? { ok: true, detail: `OK (${data.status}).` }
          : { ok: false, detail: `${data.status}${data.error_message ? `: ${data.error_message}` : ""}` };
      } catch (e) {
        return { ok: false, detail: e instanceof Error ? e.message : "network error" };
      }
    })(),
    (async () => {
      try {
        const res = await timedFetch(
          `https://maps.googleapis.com/maps/api/geocode/json?address=Canggu%20Bali&key=${key}`,
          { cache: "no-store" }
        );
        const data = await res.json();
        return data.status === "OK"
          ? { ok: true, detail: "OK." }
          : { ok: false, detail: `${data.status}${data.error_message ? `: ${data.error_message}` : ""}` };
      } catch (e) {
        return { ok: false, detail: e instanceof Error ? e.message : "network error" };
      }
    })(),
    probePlacePhoto(key, probe.lat, probe.lng),
    probeNominatim(),
  ]);

  return {
    keyConfigured: true,
    placesNew: n,
    placesAutocomplete: a,
    placesLegacy: l,
    geocoding: g,
    placePhotos: ph,
    nominatim: osm,
  };
}
