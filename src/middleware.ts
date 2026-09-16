import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  cookieGateRedirect,
  hasEssentialAcknowledgement,
  isCookieGatedPath,
} from "@/lib/cookies/required";

// TWO DOOR CHECKS, IN THIS ORDER, AND THE ORDER IS THE DESIGN.
//
// 1. SIGNED IN? Signed-out visitors hitting the app root meet the public
//    landing page (/welcome - outside the matcher, so it can never loop); any
//    other gated path goes to /login. This checks cookie PRESENCE at the edge;
//    API routes verify the HMAC signature and role server-side, so a forged
//    cookie gets no data.
//
// 2. HAVE THEY ANSWERED THE COOKIE QUESTION? Essential cookies are a condition
//    of using the app (see lib/cookies/required for why that is a condition of
//    service and not a cookie wall), so a signed-in person with no current
//    decision is sent to /cookies to make one. "Essential only" is one tap and
//    gets them the entire product - what is required is the decision, not a
//    particular answer.
//
// THE SESSION CHECK COMES FIRST because a signed-out visitor is not "using the
// app" yet, and bouncing them to a cookie screen before they have even seen
// the product would be exactly the wall this is not. It also keeps the two
// redirects from fighting: /welcome and /login are both outside the matcher,
// and so is /cookies, so no path here can bounce twice.
export function middleware(req: NextRequest) {
  const hasSession = Boolean(req.cookies.get("wd_session")?.value);
  const { pathname } = req.nextUrl;

  if (!hasSession && pathname !== "/login") {
    const url = req.nextUrl.clone();
    url.pathname = pathname === "/" ? "/welcome" : "/login";
    return NextResponse.redirect(url);
  }

  // The header, not `req.cookies`: `hasEssentialAcknowledgement` is the same
  // pure function the /cookies screen calls, and it takes a raw header so one
  // implementation serves the Edge, the server and a plain test.
  if (hasSession && isCookieGatedPath(pathname)) {
    if (!hasEssentialAcknowledgement(req.headers.get("cookie"))) {
      const url = req.nextUrl.clone();
      const target = new URL(cookieGateRedirect(pathname), req.nextUrl.origin);
      url.pathname = target.pathname;
      url.search = target.search;
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.next();
}

export const config = {
  // Kept in step with COOKIE_GATED_PATHS by a test - the gate and the matcher
  // disagreeing would mean a page the gate believes it covers and never sees.
  matcher: ["/", "/admin", "/profile", "/deals"],
};
