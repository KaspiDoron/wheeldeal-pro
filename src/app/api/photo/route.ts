import { mapsKey } from "@/lib/google";

// Streams a Google Places photo without exposing the API key to the browser.
// Supports both APIs:
//   ?name=places/XXX/photos/YYY  - Places API (New) photo resource name
//   ?ref=<photo_reference>       - legacy Places photo reference
//
// WHY THIS ROUTE IS LOUD NOW. It used to answer every failure - bad input, no
// key, Google refusing, a timeout - with an identical bare 404 and no log. When
// every shop photo on the app went blank, that 404 said nothing about which of
// those four had happened, and the Maps doctor never fetched an image at all,
// so the diagnostics panel read all-green. A proxy that cannot explain itself
// costs more than it saves: each failure now carries its reason on the response
// and in the server log, and `runMapsDiagnostics` pulls a real image so the
// owner can read Google's own words in one tap.
//
// Strict input shapes remain: a crafted value must never be able to inject
// query params (a "?" in `name` would turn /media?key=... into an arbitrary
// authenticated Google call billed to the owner's key).

// Google's resource ids are URL-safe base64-ish. The name is anchored to the
// exact two-segment shape; the reference is a single opaque token. Neither may
// contain "?", "&", "#" or a path separator, which is the whole security point.
const NAME_RX = /^places\/[A-Za-z0-9_.~-]{1,256}\/photos\/[A-Za-z0-9_.~-]{1,2048}$/;
const REF_RX = /^[A-Za-z0-9_.~-]{1,2048}$/;

/** A failure must never be cached: once broken it would stay broken for the
 *  whole session even after the real cause cleared. */
const FAIL_HEADERS = { "Cache-Control": "private, no-store" };

function fail(status: number, reason: string, logDetail?: string): Response {
  // The DETAIL goes to the log pipeline (where the owner reads it); the header
  // carries only `reason`, which for upstream failures is a coarse code - this
  // route is deliberately unauthenticated, and Google's own error text names
  // the GCP project id, which is not the anonymous internet's business.
  console.warn(`[api/photo] ${status} ${logDetail ?? reason}`);
  return new Response(null, {
    status,
    headers: { ...FAIL_HEADERS, "X-Photo-Error": reason.slice(0, 200) },
  });
}

/** Collapse Google's raw error text into a coarse, project-id-free code. The
 *  distinct fixes the detailed messages point at ("enable the API", "raise the
 *  quota", "fix the key") stay distinguishable - by code, not by echo. */
function coarseUpstreamCode(status: number, msg: string): string {
  if (/has not been used|is disabled|not enabled/i.test(msg)) return "places-api-not-enabled";
  if (/quota|RESOURCE_EXHAUSTED|rate/i.test(msg) || status === 429) return "quota-exceeded";
  if (/API key|expired|denied|PERMISSION/i.test(msg) || status === 403) return "api-key-refused";
  if (/not found|NOT_FOUND/i.test(msg) || status === 404) return "photo-not-found";
  return `google-${status}`;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const name = url.searchParams.get("name") ?? "";
  const ref = url.searchParams.get("ref") ?? "";

  if (!ref && !name) return fail(400, "no name or ref");

  // AN UNMETERED, UNAUTHENTICATED PROXY IN FRONT OF A BILLED API.
  //
  // This route had no session check, no rate limit and - the part that made it
  // invisible - no `recordApi("photo")`, so the `photo` quota in usage.ts could
  // only ever read zero. Photo URLs are public and a results page renders
  // 12-20 of them, and `rate-limit.ts` documents that there is no CDN in front
  // of Cloud Run, so `s-maxage` buys nothing here either. Anyone with a URL
  // could spend the Maps key.
  //
  // Kept unauthenticated on purpose: these images render on the public
  // marketing surface too, and requiring a session would break that. An IP
  // bucket is the right shape - generous enough that a real user scrolling a
  // results page never notices, tight enough that a scraper does.
  const { rateLimit, clientIp } = await import("@/lib/rate-limit");
  const rl = await rateLimit("photo", clientIp(req), 300, 3600);
  if (!rl.ok) return fail(429, "too many photo requests - slow down");
  if (name && !NAME_RX.test(name)) return fail(400, "malformed photo name");
  if (!name && ref && !REF_RX.test(ref)) return fail(400, "malformed photo ref");

  const key = await mapsKey();
  if (!key) return fail(503, "no Google Maps key configured");

  const target = name
    ? `https://places.googleapis.com/v1/${name}/media?key=${key}&maxWidthPx=800`
    : `https://maps.googleapis.com/maps/api/place/photo?maxwidth=640&photo_reference=${encodeURIComponent(
        ref
      )}&key=${key}`;

  // Bound the header wait so a stalled Google media endpoint cannot hang this
  // proxy invocation until the request-timeout ceiling - browser fan-out (up to
  // 12 photo URLs per result view) would otherwise pile hung invocations against
  // the concurrency ceiling and starve real routes. The timer is cleared once
  // headers arrive; the body then streams straight to the client.
  //
  // ONE retry, because a single cold-start blip should not blank an entire
  // results page - which is how this presented: every card at once.
  let res: Response | null = null;
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 250));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      res = await fetch(target, {
        // `no-store` on the UPSTREAM fetch defeated the runtime's own cache as
        // well, so even a warm instance re-fetched from Google every time. The
        // image is immutable for the life of its photo reference; caching it is
        // the whole point of proxying it.
        cache: "force-cache",
        signal: ctrl.signal,
        headers: { Accept: "image/*" },
      });
    } catch (e) {
      lastError = e instanceof Error ? e.name === "AbortError" ? "upstream timed out (10s)" : e.message : "network error";
      res = null;
      continue;
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) break;
    // Read Google's own explanation - "Places API (New) has not been used in
    // project X", "quota exceeded" and "API key not valid" are different
    // problems with different fixes, and the old 404 hid all three. The full
    // text goes to the SERVER LOG only (W9): it names the GCP project, and
    // this endpoint answers anyone. The header gets the coarse code.
    const body = await res.text().catch(() => "");
    let msg = "";
    try {
      msg = JSON.parse(body)?.error?.message ?? "";
    } catch {
      msg = body.replace(/\s+/g, " ").slice(0, 200);
    }
    lastError = coarseUpstreamCode(res.status, msg);
    const logDetail = `Google ${res.status}${msg ? `: ${msg}` : ""}`;
    // 4xx is a settled answer (bad id, key refused) - retrying just burns quota.
    if (res.status < 500) return fail(502, lastError, logDetail);
    res = null;
  }

  if (!res || !res.body) return fail(502, lastError || "no image body");

  const type = res.headers.get("Content-Type") ?? "image/jpeg";
  if (!type.startsWith("image/")) return fail(502, `upstream returned ${type}, not an image`);

  // METER WHAT WE SPENT. The `photo` quota existed in usage.ts and nothing ever
  // wrote to it, so the panel reporting Google spend read zero for this route
  // forever. Counted on SUCCESS only - a 502 from Google is not a billed call.
  const { recordApi } = await import("@/lib/usage");
  void recordApi("photo");

  return new Response(res.body, {
    headers: {
      "Content-Type": type,
      // Only a SUCCESSFUL image is cacheable, and it is public: a shop photo is
      // the same for everyone and never traveller-specific.
      // A PLACE PHOTO IS IMMUTABLE, AND NOTHING WAS CACHING IT BUT THE BROWSER.
      //
      // The old header was browser-only: `max-age` alone tells a CDN nothing,
      // so every viewer of every shop re-fetched an 800px original THROUGH this
      // Node route, which re-fetched it from Google. On a results page that is
      // up to a dozen cold round trips behind a serverless cold start, which is
      // the "shop images load too slowly" the owner reported.
      //
      // `s-maxage` gives the CDN a year (the photo reference encodes the image;
      // Google mints a new reference when the photo changes, so the URL is the
      // version). `immutable` stops revalidation entirely.
      // `stale-while-revalidate` means a expiring entry is still served
      // instantly while it refreshes behind the request.
      "Cache-Control":
        "public, max-age=31536000, s-maxage=31536000, immutable, stale-while-revalidate=86400",
    },
  });
}
