// THE COOKIE INVENTORY - the one list, and the one that has to be TRUE.
//
// A cookie banner is a promise about what the app stores. Every cookie banner
// that ships as a component and nothing else makes that promise blind: the
// categories are a dropdown somebody typed once, the policy page lists whatever
// was true the week it was written, and six months later the app writes four
// keys nobody ever told the traveller about. The banner still says "you are in
// control", which by then is simply false.
//
// So the inventory is CODE, it is the only inventory, and it is pinned:
//
//   - the banner's category toggles render from it,
//   - the /cookies policy page is GENERATED from it (the document cannot drift
//     from the app because it is not a separate document),
//   - the storage helpers ask it which category a key belongs to, and
//   - cookies.test.ts greps src/ for every localStorage/sessionStorage/cookie
//     write in the app and FAILS THE BUILD on a key that is not declared here.
//
// That last one is the whole point. A new `localStorage.setItem("wd_...")` in
// a feature branch is a new thing we store about a person, and it does not get
// to ship until somebody has decided which category it is and what to tell the
// traveller it is for.
//
// NO "server-only" HERE. The banner, the policy page and the storage gate all
// read this, on both sides of the wire.

/**
 * The four categories, in the order they are shown.
 *
 * `necessary` is deliberately first and deliberately not togglable: it is the
 * signed session cookie and the record of this very choice. Presenting those as
 * a switch the traveller can flip would be a lie - turning them off would sign
 * them out and forget the decision they just made.
 */
export const COOKIE_CATEGORIES = ["necessary", "preferences", "analytics", "marketing"] as const;

export type CookieCategory = (typeof COOKIE_CATEGORIES)[number];

/** The categories a person actually decides. `necessary` is not one of them. */
export const OPTIONAL_CATEGORIES: readonly CookieCategory[] = [
  "preferences",
  "analytics",
  "marketing",
];

/**
 * Bumped when the STORED SET changes in a way a person would want to know
 * about - a new category, a new third party, a new purpose. A bump re-asks
 * everyone (see `needsCookieChoice`), so it is not for typos: re-prompting the
 * whole user base over a reworded sentence trains people to click the first
 * button, which is how consent becomes meaningless.
 *
 * 2026-09-16: first version. Consent gating for the AdSense SDK, the
 * preference-storage gate, and the first-party analytics id.
 *
 * 2026-09-20: the advertising category now also covers SPONSORED SEARCH - a
 * new purpose (search suggestions that lead to a results page with ads, and a
 * count of their use), a new Google script (AdSense for Search) with its own
 * cookies, a new first-party key (wd_tsid), and a receipt number inside
 * wd_cookie_prefs. That is squarely "a new third party, a new purpose", so
 * everyone is asked again: a yes given to display ads last week was not a yes
 * to this, and treating it as one is exactly the consent-by-inertia this
 * version number exists to prevent.
 */
export const COOKIE_POLICY_VERSION = "2026-09-20";

/** Where a stored value actually lives. Said plainly, because "cookies" in the
 *  legal sense covers all three and travellers reasonably read it as none. */
export type StorageMedium = "cookie" | "localStorage" | "sessionStorage";

export interface CookieEntry {
  /** The literal key. For `wd_i18n_*` style families, the prefix + `*`. */
  name: string;
  medium: StorageMedium;
  category: CookieCategory;
  /** Who sets it. `first` = this app; anything else is a third party by name. */
  party: "first" | "Google";
  /** Plain-English purpose. Rendered verbatim on /cookies and in the banner. */
  purpose: string;
  /** Human duration, rendered verbatim. "Session" = gone when the tab closes. */
  duration: string;
  /**
   * For a THIRD party's entry: the literal cookie names its script writes onto
   * THIS site's own domain, which is where the purge can reach them.
   *
   * "Third party" describes who sets a cookie, not where it is stored, and the
   * purge used to conflate the two - it skipped all of Google's cookies as
   * being "on another domain", which is true of IDE (doubleclick.net) and
   * false of the rest. A name listed here is expired when its category is
   * withdrawn; a name left out is one this site genuinely cannot delete, and
   * the policy page says so rather than claiming otherwise.
   */
  siteCookies?: string[];
}

/**
 * EVERY key this app writes to a browser. Pinned by `cookies.test.ts` against a
 * grep of src/ - a write to an undeclared key fails the suite.
 *
 * Third-party entries (Google) are the ones we do not set ourselves but CAUSE
 * to be set by loading somebody's script. They belong here for exactly that
 * reason: from the traveller's side of the screen there is no difference.
 */
export const COOKIE_MANIFEST: CookieEntry[] = [
  // ---- necessary ------------------------------------------------------------
  {
    name: "wd_session",
    medium: "cookie",
    category: "necessary",
    party: "first",
    purpose:
      "Keeps you signed in. It is signed so it cannot be forged, and it is readable only by the server, never by scripts on the page.",
    duration: "30 days, renewed while you use the app (90 days maximum from first sign-in)",
  },
  {
    name: "wd_cookie_prefs",
    medium: "cookie",
    category: "necessary",
    party: "first",
    purpose:
      "Remembers the choice you make in this panel, so you are not asked again on every screen. Without it there is nowhere to record that you said no. It also holds a random receipt number, used for one thing only: so that the choice you made can be proven later. It is never used to recognise you for advertising or analytics.",
    duration: "180 days",
  },

  // ---- preferences ----------------------------------------------------------
  {
    name: "wd_theme",
    medium: "localStorage",
    category: "preferences",
    party: "first",
    purpose: "Remembers whether you chose the light or dark theme.",
    duration: "Until you clear your browser data",
  },
  {
    name: "wd_lang",
    medium: "localStorage",
    category: "preferences",
    party: "first",
    purpose: "Remembers the language you picked, so the app opens in it next time.",
    duration: "Until you clear your browser data",
  },
  {
    name: "wd_i18n_*",
    medium: "localStorage",
    category: "preferences",
    party: "first",
    purpose:
      "Caches the translated interface text for your language, so switching languages is instant instead of a fresh round trip every visit.",
    duration: "Until you clear your browser data",
  },
  {
    name: "wd_translate_seen",
    medium: "localStorage",
    category: "preferences",
    party: "first",
    purpose: "Remembers that you have already seen the language hint, so it stops appearing.",
    duration: "Until you clear your browser data",
  },
  {
    name: "wd_currency",
    medium: "localStorage",
    category: "preferences",
    party: "first",
    purpose: "Remembers the currency you chose to see prices in.",
    duration: "Until you clear your browser data",
  },
  {
    name: "wd_prefs",
    medium: "localStorage",
    category: "preferences",
    party: "first",
    purpose:
      "Remembers your app preferences (notification and display choices) between visits.",
    duration: "Until you clear your browser data",
  },
  {
    name: "wd_list_axis",
    medium: "localStorage",
    category: "preferences",
    party: "first",
    purpose: "Remembers whether you sort offers by price or by distance.",
    duration: "Until you clear your browser data",
  },
  {
    name: "wd_local_lang",
    medium: "localStorage",
    category: "preferences",
    party: "first",
    purpose:
      "Remembers whether your agents should write to shops in the shop's own local language.",
    duration: "Until you clear your browser data",
  },
  {
    name: "wd_onboarded",
    medium: "localStorage",
    category: "preferences",
    party: "first",
    purpose: "Remembers that you have finished the intro, so it is not shown again.",
    duration: "Until you clear your browser data",
  },
  {
    name: "wd_push_on",
    medium: "localStorage",
    category: "preferences",
    party: "first",
    purpose:
      "Remembers that you turned on push notifications on this device, so the button shows the right state.",
    duration: "Until you clear your browser data",
  },
  {
    name: "wd_wa_linked",
    medium: "localStorage",
    category: "preferences",
    party: "first",
    purpose:
      "Caches, for a few minutes, whether your WhatsApp is linked - so the screen does not flash a lock while it checks.",
    duration: "Until you clear your browser data",
  },
  {
    name: "wd_game_high",
    medium: "localStorage",
    category: "preferences",
    party: "first",
    purpose: "Your high score in the small game that runs while your agents wait on shops.",
    duration: "Until you clear your browser data",
  },
  {
    name: "wd_will",
    medium: "sessionStorage",
    category: "preferences",
    party: "first",
    purpose:
      "Keeps your conversation with Will (the in-app assistant) alive while you move between screens in this visit.",
    duration: "Session - cleared when you close the tab",
  },
  {
    name: "wd_will_dismissed",
    medium: "sessionStorage",
    category: "preferences",
    party: "first",
    purpose: "Remembers which of Will's tips you dismissed during this visit.",
    duration: "Session - cleared when you close the tab",
  },
  {
    name: "wd_wa_just_linked",
    medium: "sessionStorage",
    category: "preferences",
    party: "first",
    purpose:
      "Carries the 'your WhatsApp is now linked' confirmation across the one page hop after linking.",
    duration: "Session - cleared when you close the tab",
  },
  {
    name: "wd_ops_detect_at",
    medium: "sessionStorage",
    category: "preferences",
    party: "first",
    purpose:
      "Operator-only: marks where you were last reading in the internal review console. Never set for travellers.",
    duration: "Session - cleared when you close the tab",
  },

  // ---- analytics ------------------------------------------------------------
  {
    name: "wd_aid",
    medium: "cookie",
    category: "analytics",
    party: "first",
    purpose:
      "A random id with no name, email or number in it, so the screens you visit in one session can be counted as one session rather than as strangers. Set only if you turn Analytics on, deleted the moment you turn it off.",
    duration: "180 days",
  },

  // ---- marketing ------------------------------------------------------------
  //
  // We set none of these ourselves. Loading Google's ad script is what causes
  // them, which is why the script is not loaded at all until this category is
  // granted - see AdSenseScript in the root layout.
  {
    name: "wd_tsid",
    medium: "sessionStorage",
    category: "marketing",
    party: "first",
    purpose:
      "A random number kept for this visit only, so that one visit's use of the sponsored search suggestions is counted once rather than many times. It never leaves your browser: what is recorded is a short code worked out from it that changes every day and cannot be traced back to it.",
    duration: "Session - cleared when you close the tab",
  },
  {
    name: "__gads, __gpi, _gcl_au, IDE",
    medium: "cookie",
    category: "marketing",
    party: "Google",
    purpose:
      "Set by Google AdSense to choose and cap the ads shown on the free plan, and to detect ad fraud. WheelDeal does not load Google's ad script at all unless you turn this on, and paid plans never show ads.",
    duration: "Up to 13 months, set and controlled by Google",
    // Written by Google's script onto this site's own domain, so withdrawing
    // advertising deletes them. IDE is absent on purpose: it lives on
    // doubleclick.net, out of this site's reach.
    siteCookies: ["__gads", "__gpi", "__eoi", "_gcl_au"],
  },
  // AdSense for Search - a DIFFERENT Google script (google.com/adsense/search)
  // from the display SDK above, loaded by the sponsored-search placements in
  // lib/traffic. Same category, same gate, its own line: a person reading the
  // list should be able to see that two Google products are involved.
  {
    name: "__gsas, NID",
    medium: "cookie",
    category: "marketing",
    party: "Google",
    purpose:
      "Set by Google when the sponsored search suggestions or the search ads load, to choose the ads, cap how often you see them and detect ad fraud. WheelDeal does not load Google's search script at all unless you turn this on.",
    duration: "Up to 13 months, set and controlled by Google",
    // __gsas is written onto this site's domain; NID belongs to google.com.
    siteCookies: ["__gsas"],
  },
];

/** What a category means, in one sentence, on the banner and the policy page. */
export const CATEGORY_COPY: Record<
  CookieCategory,
  { title: string; blurb: string; consequence: string }
> = {
  necessary: {
    title: "Strictly necessary",
    blurb:
      "Signing you in and remembering the choice you make right here. These cannot be switched off - without them there is no session and nowhere to record a 'no'.",
    consequence: "Always on.",
  },
  preferences: {
    title: "Preferences",
    blurb:
      "Your theme, language, currency and sort order, remembered on this device so the app opens the way you left it.",
    consequence:
      "Off: the app still works, it just forgets your theme, language and currency every visit.",
  },
  analytics: {
    title: "Analytics",
    blurb:
      "A record of which screens you reach and where a search stalls, so the parts that quietly fail can be found and fixed. It is never sold and never used to advertise to you.",
    consequence:
      "Off: nothing about how you use the app is recorded, on this device or on our servers.",
  },
  marketing: {
    title: "Advertising and sponsored search",
    // THIS IS THE SENTENCE A VISITOR CONSENTS TO, so it says the three things
    // that are true and that a person would want to know: the guides may end
    // with sponsored search suggestions, WheelDeal is paid when the ads behind
    // them are used, and their use is counted without identifying anyone. A
    // blurb that said only "advertising" would collect a yes to display ads and
    // spend it on something the person was never told about.
    blurb:
      "Pays for the free plan and the free guides. Turning this on lets Google show ads, and lets the guides end with sponsored search suggestions that lead to a results page carrying ads. WheelDeal earns money when those ads are used. Google's scripts set Google's own cookies under Google's rules, and we count - with no name, email or phone number - that a suggestion was shown or followed.",
    consequence:
      "Off: Google's scripts are never loaded, you see no ads and no sponsored suggestions, and nothing about them is counted.",
  },
};

/** Every declared entry in one category, in manifest order. */
export function entriesFor(category: CookieCategory): CookieEntry[] {
  return COOKIE_MANIFEST.filter((c) => c.category === category);
}

/**
 * Which category governs a storage key - the question the storage gate asks
 * before every write.
 *
 * A key nobody declared answers `null`, and the gate treats `null` as REFUSED
 * rather than as allowed. Failing closed is the only safe direction here: an
 * undeclared key is by definition one the traveller was never told about, so it
 * is not one their consent can be said to cover. The test that greps for
 * undeclared keys means this should never fire in a shipped build - it is the
 * belt to that test's braces.
 */
export function categoryForKey(key: string): CookieCategory | null {
  const k = String(key ?? "");
  if (!k) return null;
  for (const entry of COOKIE_MANIFEST) {
    if (entry.name === k) return entry.category;
    // `wd_i18n_*` - a family declared by its prefix.
    if (entry.name.endsWith("*") && k.startsWith(entry.name.slice(0, -1))) return entry.category;
  }
  return null;
}
