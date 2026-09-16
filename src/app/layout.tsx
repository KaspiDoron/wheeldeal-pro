import type { Metadata, Viewport } from "next";
import {
  Baloo_2,
  Baloo_Bhaijaan_2,
  Cairo,
  Comfortaa,
  Heebo,
  Hind,
  IBM_Plex_Sans_Arabic,
  IBM_Plex_Sans_Thai,
  Mitr,
  Mukta,
  Nunito,
  Rubik,
  Sarabun,
  Secular_One,
  Space_Grotesk,
} from "next/font/google";
import { I18nProvider } from "@/lib/i18n";
import { WillAssistantProvider } from "@/components/will/WillAssistantProvider";
import { NavVeil } from "@/components/NavVeil";
import { AmbientGlow } from "@/components/AmbientGlow";
import { PageFade } from "@/components/PageFade";
import { OfflineBanner } from "@/components/OfflineBanner";
import { ADSENSE_PUBLISHER, resolveSiteOrigin } from "@/lib/site";
import { TestModeBanner } from "@/components/TestModeBanner";
import { FirstTouchTerms } from "@/components/FirstTouchTerms";
import { CookieConsent } from "@/components/CookieConsent";
import { ScreenTracker } from "@/components/ScreenTracker";
import "./globals.css";

// SELF-HOSTED, NOT FETCHED AT RUNTIME.
//
// The two brand faces were pulled with a `<link>` to fonts.googleapis.com, so
// every cold open cost a DNS lookup, a TLS handshake and a CSS round trip to a
// third party BEFORE a single glyph could be requested - and `display=swap`
// meant the app painted in the system font and then reflowed when they landed.
// That reflow is layout shift on the most text-dense screen in the app, and on
// a hotel wifi in Ko Tao it is a visible second of it.
//
// `next/font` downloads both families at BUILD time, serves them from our own
// origin, and emits a `@font-face` with metric overrides so the fallback
// occupies the same space as the real face - the swap stops moving anything.
// It also removes a third-party request from the critical path, which is the
// part that mattered on a slow connection.
// THE FONT MATRIX (owner report 4, item 2): every translated language gets at
// least THREE premium faces - display (headings), body (prose), accent
// (prices/numbers/badges) - via per-CHARACTER fallback ladders in globals.css.
// Latin faces lead every ladder so Latin stays pixel-identical; each script's
// faces sit behind them and only its own glyphs fall through. next/font emits
// unicode-range @font-face per subset, so a browser downloads only the
// subsets it actually paints - the Latin cold start pays nothing for Thai.
// CJK (zh/ja/ko) deliberately uses native system stacks appended to the
// ladders: a CJK webfont is 3-15MB even subsetted, and the native faces are
// what those users' eyes expect anyway.
const nunito = Nunito({
  // latin-ext covers Polish/Turkish diacritics; cyrillic covers ru/uk prose;
  // vietnamese its tonal stack - all previously falling to a system face.
  subsets: ["latin", "latin-ext", "cyrillic", "cyrillic-ext", "vietnamese"],
  weight: ["400", "600", "700", "800"],
  variable: "--wd-font-body",
  display: "swap",
  // Adjusts the fallback face's metrics to match, so the swap is invisible.
  adjustFontFallback: true,
});

const baloo = Baloo_2({
  // Baloo 2 natively ships Devanagari - Hindi headings come free here.
  subsets: ["latin", "latin-ext", "vietnamese", "devanagari"],
  weight: ["600", "700", "800"],
  variable: "--wd-font-display",
  display: "swap",
  adjustFontFallback: true,
});

// The app-wide ACCENT face: prices, savings numbers, counters, plan cards.
// A tabular-figured grotesk that reads "engineered" next to the rounded
// brand faces - the third premium face for every Latin-script language.
const grotesk = Space_Grotesk({
  subsets: ["latin", "latin-ext", "vietnamese"],
  weight: ["500", "700"],
  variable: "--wd-font-accent",
  display: "swap",
  adjustFontFallback: true,
});

// THE HEBREW FACES (owner report 3, item 10). Neither brand font carries
// Hebrew glyphs, so Hebrew fell through to an arbitrary system face - the
// "not premium enough" in the owner's screenshots. These sit AFTER the Latin
// families in the --font-body/--font-display ladders (globals.css): font
// fallback is per-CHARACTER, so Latin stays pixel-identical on Nunito/Baloo
// while Hebrew glyphs resolve to Rubik (body) and Secular One (display).
const rubik = Rubik({
  // + cyrillic: Rubik doubles as the Cyrillic body/accent letterface, so
  // ru/uk get a designed face even where Nunito's coverage thins.
  subsets: ["hebrew", "latin", "cyrillic"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--wd-font-body-he",
  display: "swap",
  adjustFontFallback: true,
});

const secular = Secular_One({
  // Secular One ships ONE weight; .font-display gets font-synthesis-weight:
  // none so browsers never smear a fake bold onto it.
  subsets: ["hebrew", "latin"],
  weight: "400",
  variable: "--wd-font-display-he",
  display: "swap",
  adjustFontFallback: true,
});

const heebo = Heebo({
  subsets: ["hebrew", "latin"],
  weight: ["500", "700"],
  variable: "--wd-font-accent-he",
  display: "swap",
  adjustFontFallback: true,
});

// ARABIC trio (RTL already handled by the dir() plumbing).
const balooArabic = Baloo_Bhaijaan_2({
  subsets: ["arabic", "latin"],
  weight: ["700"],
  variable: "--wd-font-display-ar",
  display: "swap",
  adjustFontFallback: true,
});

const plexArabic = IBM_Plex_Sans_Arabic({
  subsets: ["arabic", "latin"],
  weight: ["400", "700"],
  variable: "--wd-font-body-ar",
  display: "swap",
  adjustFontFallback: true,
});

const cairo = Cairo({
  subsets: ["arabic", "latin"],
  weight: ["500", "700"],
  variable: "--wd-font-accent-ar",
  display: "swap",
  adjustFontFallback: true,
});

// CYRILLIC display (Baloo 2 has no Cyrillic; Comfortaa is its rounded cousin).
const comfortaa = Comfortaa({
  subsets: ["cyrillic", "latin"],
  weight: ["700"],
  variable: "--wd-font-display-cy",
  display: "swap",
  adjustFontFallback: true,
});

// DEVANAGARI body + accent (display rides Baloo 2's own devanagari subset).
const mukta = Mukta({
  subsets: ["devanagari", "latin"],
  weight: ["400", "700"],
  variable: "--wd-font-body-hi",
  display: "swap",
  adjustFontFallback: true,
});

const hind = Hind({
  subsets: ["devanagari", "latin"],
  weight: ["500", "700"],
  variable: "--wd-font-accent-hi",
  display: "swap",
  adjustFontFallback: true,
});

// THAI trio.
const mitr = Mitr({
  subsets: ["thai", "latin"],
  weight: ["700"],
  variable: "--wd-font-display-th",
  display: "swap",
  adjustFontFallback: true,
});

const sarabun = Sarabun({
  subsets: ["thai", "latin"],
  weight: ["400", "700"],
  variable: "--wd-font-body-th",
  display: "swap",
  adjustFontFallback: true,
});

const plexThai = IBM_Plex_Sans_Thai({
  subsets: ["thai", "latin"],
  weight: ["500", "700"],
  variable: "--wd-font-accent-th",
  display: "swap",
  adjustFontFallback: true,
});

const FONT_VARS = [
  nunito.variable,
  baloo.variable,
  grotesk.variable,
  rubik.variable,
  secular.variable,
  heebo.variable,
  balooArabic.variable,
  plexArabic.variable,
  cairo.variable,
  comfortaa.variable,
  mukta.variable,
  hind.variable,
  mitr.variable,
  sarabun.variable,
  plexThai.variable,
].join(" ");

const title = "WheelDeal - cheapest local rides, negotiated for you";
const description =
  "AI agents find and negotiate the cheapest car, manual motorcycle & automatic scooter rentals near your hotel. Live bargaining, map + list, biggest savings first.";

// Correct absolute URLs are what make the WhatsApp/Telegram/X share preview
// (og:image) work. The resolution order - owner-set APP_DOMAIN in the Key Vault
// (so a domain move needs no redeploy), then the build env, then the brand
// default - lives in `@/lib/site` and is shared with push identity, the
// geocoder User-Agent, robots and the sitemap.
export async function generateMetadata(): Promise<Metadata> {
  const siteUrl = await resolveSiteOrigin();
  // Same resolution order as every other key: the admin Key Vault first, then
  // the environment. Best-effort - social card metadata never blocks a render.
  const { getConfig } = await import("@/lib/runtime-config");
  const twitterHandle = await getConfig("TWITTER_HANDLE").catch(() => "");
  return {
    metadataBase: new URL(siteUrl),
    title: { default: title, template: "%s · WheelDeal" },
    description,
    applicationName: "WheelDeal",
    keywords: [
      "car rental",
      "motorcycle rental",
      "scooter hire",
      "travel savings",
      "rental negotiation",
      "cheap rentals",
    ],
    authors: [{ name: "WheelDeal" }],
    creator: "WheelDeal",
    manifest: "/manifest.webmanifest",
    appleWebApp: {
      capable: true,
      title: "WheelDeal",
      statusBarStyle: "default",
    },
    formatDetection: { telephone: false },
    openGraph: {
      type: "website",
      siteName: "WheelDeal",
      title,
      description,
      url: siteUrl,
      locale: "en_US",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      // ONE PLACE A KEY LIVES. The admin Key Vault writes TWITTER_HANDLE and
      // the Keys screen reads it back, so the owner sets it and nothing
      // changes - this read went straight to process.env, which on Cloud Run
      // is whatever was baked at deploy time. Every other integration key
      // resolves through getConfig for exactly this reason.
      site: twitterHandle || undefined,
      creator: twitterHandle || undefined,
    },
    robots: { index: true, follow: true },
    alternates: { canonical: "/" },
    category: "travel",
    generator: "WheelDeal",
    referrer: "origin-when-cross-origin",
    icons: {
      icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
      apple: [{ url: "/apple-icon", sizes: "180x180", type: "image/png" }],
    },
    other: {
      "msapplication-TileColor": "#2f6fed",
      "apple-mobile-web-app-title": "WheelDeal",
      // Google AdSense account verification. Google looks for this tag (or the
      // ads.txt file, or the script) when reviewing site ownership, and it must
      // be present on EVERY page - hence the root layout rather than a page.
      "google-adsense-account": ADSENSE_PUBLISHER,
    },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Pinch-zoom stays ENABLED for accessibility (WCAG 1.4.4). Form controls are
  // all >= 16px so iOS never auto-zooms on focus - we don't need to disable it.
  maximumScale: 5,
  userScalable: true,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f6f9" },
    { media: "(prefers-color-scheme: dark)", color: "#17191d" },
  ],
};

// Apply the saved theme AND direction before first paint.
//
// The theme half avoids a colour flash. The direction half fixes I-6c: `dir`
// was set only by the i18n provider's effect, which runs AFTER hydration - so
// every Hebrew/Arabic cold load painted left-to-right and then snapped to RTL,
// a visible mirror-flip on the first frame. Reading `wd_lang` here and stamping
// `dir`/`lang` on <html> before paint makes the very first frame correct.
//
// The RTL set is inlined as a literal rather than imported because this string
// runs before any module loads. It must stay in sync with LANGS' `rtl: true`
// entries in src/lib/i18n.tsx - a test pins that it does.
//
// The storage read sits in its OWN try: when localStorage throws (private
// mode, blocked storage) the OS fallback and the attribute stamp must still
// run - one shared try/catch made a storage exception silently strand a
// dark-OS visitor on the light theme. The stored value is also validated, so
// a corrupted "wd_theme" falls back to the OS instead of stamping garbage.
const themeScript = `
var t = null;
try { t = localStorage.getItem("wd_theme"); } catch (e) {}
try {
  if (t !== "dark" && t !== "light")
    t = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", t);
} catch (e) {}
try {
  var l = localStorage.getItem("wd_lang");
  if (l) {
    document.documentElement.setAttribute("lang", l);
    document.documentElement.setAttribute("dir", (l === "he" || l === "ar") ? "rtl" : "ltr");
  }
} catch (e) {}
`;

// THE ADVERTISING GATE, AND WHY IT RUNS BEFORE PAINT.
//
// Google's ad SDK sets Google's cookies the moment it loads - before any ad is
// requested and whether or not a slot ever renders. So consent cannot be
// checked in a React effect: by the time a component mounts, the script tag in
// this <head> has already been fetched and the cookies are already set. The
// only place the decision can be made is here, in a synchronous script that
// runs before the browser reaches anything else.
//
// The <script src> that used to sit in <head> unconditionally is therefore
// gone, and this injects it instead - only when `wd_cookie_prefs` grants
// `marketing`.
//
// THIS DOES NOT BREAK ADSENSE REVIEW, AND THE OLD COMMENT'S WORRY WAS ABOUT
// THE WRONG TAG. Site ownership is verified by <meta name="google-adsense-
// account">, which generateMetadata emits on every page, unconditionally, and
// still does. That is the mechanism Google's own docs prescribe, and it is
// untouched. Loading the SDK for a visitor who has not consented is, in the
// EEA and the UK, a breach of Google's own EU user consent policy - so the
// gate is not a trade against monetisation, it is the condition of it.
//
// The parse is a hand-rolled copy of decodeCookieConsent because this string
// runs before any module loads and cannot import one. It is deliberately
// minimal and fails closed: any throw, any missing field, anything other than
// marketing === true, and no script is added. cookies.test.ts pins it against
// the real decoder so the two cannot drift.
//
// A STALE POLICY VERSION STILL COUNTS. The version is not checked here, on
// purpose: a bump re-asks (the banner appears on this very load), and until the
// person answers, their last word stands in BOTH directions. Silently revoking
// a yes misrepresents their choice exactly as much as silently honouring a no
// would - and the re-prompt is already on screen.
const adConsentScript = `
(function () {
  try {
    var m = document.cookie.match(/(?:^|;\\s*)wd_cookie_prefs=([^;]*)/);
    if (!m) return;
    var b = m[1].replace(/-/g, "+").replace(/_/g, "/");
    b += "====".slice((b.length % 4) || 4);
    var d = JSON.parse(atob(b));
    if (!d || !d.g || d.g.marketing !== true) return;
    var s = document.createElement("script");
    s.async = true;
    s.crossOrigin = "anonymous";
    s.src = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_PUBLISHER}";
    document.head.appendChild(s);
  } catch (e) {}
})();
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      // Every font variable lands on the root, where globals.css reads them
      // into the three per-script ladders (display / body / accent).
      className={FONT_VARS}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        {/* Google AdSense, loaded ONLY with the traveller's advertising
            consent - see adConsentScript above for why the decision has to be
            made here rather than in a component, and why site verification
            (the google-adsense-account meta tag, still unconditional) is
            unaffected. The publisher id is public by design: it ships in
            ads.txt and in every ad request, so it is a constant, not a secret.

            Individual slots still render only on the free tier via <AdBanner>;
            paid plans stay 100% ad-free. This tag loads the SDK, it does not
            place an ad. */}
        <script dangerouslySetInnerHTML={{ __html: adConsentScript }} />
      </head>
      <body className="app-shell">
        <I18nProvider>
          {/* Will's concierge brain: funnel step + idle detection, shared across
              Find Deals / Profile / Login so guidance survives the pairing hop. */}
          <WillAssistantProvider>
            {/* The page canvas owns horizontal clipping so the ROOT does not -
                see .app-canvas in globals.css.
                
                It must NEVER carry a transform, a filter or an animation that
                leaves one behind: both would make it the containing block for
                every `position: fixed` element inside it. `page-fade` is
                opacity-only for exactly that reason. */}
            {/* The whole-screen loading wash - a permanent SIBLING of the
                canvas (never inside it: the canvas clips X and must stay
                transform-free). It paints only while something raised it. */}
            <AmbientGlow />
            {/* PageFade keys the canvas per pathname so the fade re-runs on
                CLIENT navigations too - under router.push this div used to
                persist and the new page popped in with no ease. The canvas
                rules (opacity-only, never a transform) live in PageFade. */}
            <PageFade>{children}</PageFade>
            <NavVeil />
            <OfflineBanner />
            <TestModeBanner />
            {/* MANDATORY FIRST TOUCH. Not dismissable, no backdrop tap: the app
                is behind it until the acceptance is RECORDED with its version,
                so a terms bump asks again instead of changing the document
                under everyone silently. Signed-out visitors never see it - the
                gate is decided server-side in /api/auth/me. */}
            <FirstTouchTerms />
            {/* The cookie choice. Unlike FirstTouchTerms this is NOT a gate: it
                is a bottom sheet over a fully usable page, and signed-out
                visitors meet it too (on /welcome, before any account exists).
                Nothing optional is stored until it is answered, so scrolling
                past it consents to nothing. It also owns the preferences panel,
                which the footer and Profile reopen by event - withdrawal has to
                stay as easy as consent. */}
            <CookieConsent />
            {/* The consented screen-view record. Renders nothing and collects
                nothing unless analytics is granted - see ScreenTracker. */}
            <ScreenTracker />
          </WillAssistantProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
