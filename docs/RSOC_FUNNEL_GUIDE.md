# RSOC funnel guide - from step 0 to production

Date: 2026-09-21. This is the single source of truth for WheelDeal's search
monetisation. Code: `src/lib/traffic/`, `src/components/traffic/`,
`src/app/search/`, `src/app/api/traffic/`. Admin screen: Admin -> Traffic.

You know RSOC as a business. This guide is about how THIS implementation
works, what each switch does, and the order to turn things on so the account
survives its first review.

---

## 0. What you are building, in one picture

```
  ORGANIC VISITOR                     SIGNED-IN TRAVELLER AT A DEAD END
  lands on a guide from Google        "No rental shops found near your stay"
        |                             or "this hunt went quiet"
        |                                        |
        |                              FUNNEL CARD (always shown, no ads in it)
        |                              - link to the price guide for their country
        |                              - a search box for all guides
        |                                        |
        v                                        v
  GUIDE (real article, 600+ words)  <-----------+
        |
        |  consent "Advertising and sponsored search" = yes
        v
  ONE related-search unit, after the article  (Google writes the terms)
        |
        |  visitor taps a term            visitor types in a search box
        v                                        |
  /search?q=...   <-------------------------------+
  - real results from the guides (server rendered)
  - ads, never more than the results, zero if zero results
        |
        v
  visitor clicks an ad  ->  Google / feed partner pays
```

Two things make this an RSOC funnel rather than a redirect, and both are
deliberate:

1. **Nothing is ever forwarded.** Google allows search ads only beside a query
   the visitor TYPED, or a term Google itself generated from real content.
   Sending a traveller's rental search onward to a broker is exactly what the
   policy forbids. So the dead end leads to an ARTICLE, and the article is what
   makes every later step legitimate.
2. **Every step is a tap the visitor chose.** No auto-redirects, no pop-unders,
   no interstitials. This is also WheelDeal's own rule
   (`docs/REVENUE-AND-TRAFFIC-PLAN.md`), not just Google's.

---

## 1. Step 0 - what must exist before any of this can earn

1. **A public domain with real content.** Done: 20 guides, each 600+ words,
   statically generated, in the sitemap. A test fails the build if this drops.
2. **AdSense site approval** for that domain. `public/ads.txt` and the
   `google-adsense-account` meta tag are already served unconditionally.
3. **Search monetisation access - ONE of:**
   - a direct Google AFS account with Related Search for Content enabled by
     your account manager (not self-serve: contract, AM activation, and the AM
     reviews a mock-up before launch), OR
   - a feed partner that lets you run RSOC on YOUR domain and hands you their
     `pub-` id, a style id and a channel id, OR
   - a link-style feed partner: a results URL with a keyword parameter and a
     sub-id parameter.
4. **Nothing else.** No paid service is required. See section 9 for exactly
   what "free" does and does not cover.

---

## 2. The five settings - everything is in Admin -> Keys

Nothing about the funnel is hardcoded. Open `https://<your domain>/admin` ->
**keys** tab. All five are plain text, not secrets, and take effect within 30
seconds with no redeploy.

### `TRAFFIC_MODE` - the master switch

- `off` (default, also when blank or unreadable) - nothing renders, nothing is
  logged.
- `test` - units render with Google's `adtest: on`. Real-looking ads, no
  impressions counted, no revenue, and nothing logged. **Use this for every
  look at a live unit** - clicking your own real ads is invalid traffic.
- `live` - earns.

### `TRAFFIC_PARTNERS` - who traffic may go to, one per line

```
id | kind | label | on/off | target | markets | revenue share
```

Google in-page unit (`afs`). The `pub-` id is accepted with or without the
`partner-` prefix; the channel is optional:

```
google|afs|Google AFS|on|pub-1234567890123456:1234567890:9876543210||1
```

Link partner (`link`). `{q}` and `{subid}` are required, https only, and they
may appear only in the query string (so a value can never choose the host):

```
feed-a|link|Feed A|on|https://search.partner.example/s?q={q}&subid={subid}|th,vn|0.8
```

- `markets` - ISO country codes, comma separated. Empty = every market. A
  partner that names the visitor's market wins over a market-neutral one.
- `revenue share` - your cut, 0 to 1. Reporting only.
- A line that fails validation is REJECTED and listed in red on Admin ->
  Traffic. A rejected partner is not live.

### `TRAFFIC_SETTINGS` - every other knob, one JSON object

Blank means all defaults. Give only what you want to change:

```json
{
  "raf": false,
  "relatedSearches": 5,
  "maxAds": 3,
  "placements": {
    "guide-inline": true,
    "guide-hub": true,
    "search-results": true,
    "no-coverage": true,
    "hunt-ended": true
  },
  "ignoredPageParams": ["utm_source", "utm_medium", "utm_campaign"],
  "linkTerms": { "th|scooter": ["scooter rental Phuket", "moped hire Thailand"] },
  "funnelGuides": { "th": "thailand-scooter-rental-prices" }
}
```

- `raf` - set `true` ONLY after Google has granted your account Restricted
  Access Features. It describes the account; it does not upgrade it.
- `relatedSearches` - suggestions per unit. Clamped to 3-5, or 3-10 with
  `raf`. Under 3 Google renders nothing.
- `maxAds` - ads in the results-page block. Clamped to 1-3, and always also
  capped by the number of real results.
- `placements` - switch any placement off individually.
- `ignoredPageParams` - tracking parameters Google's crawler should ignore so
  one article is one page. `rac` is always included.
- `linkTerms` - your own keywords for a link partner, keyed `market|category`.
  Without an entry the terms are generated from what the guide is about.
  (Never sent to Google's unit - supplying `terms` there is a RAF.)
- `funnelGuides` - which guide a country's funnel card points at. A slug that
  does not exist falls back to a real guide, never a 404.

**Configurable is not unbounded.** Out-of-range numbers are clamped and the
adjustment is shown in amber on Admin -> Traffic, because those ranges are
Google's limits, and a vault typo must not be able to become a policy strike.

### `TRAFFIC_AD_CREATIVES` - only if you buy traffic

One ad creative per line, verbatim. See section 7.

### `TRAFFIC_TCF_CMP` - opens Europe

`none` (default) or `google`. See section 6.

---

## 3. The placements

- `guide-inline` - Google's unit (or a link partner's rows) after a guide's
  article. The main earner.
- `search-results` - the ad block and one related-search unit on `/search`.
- `guide-hub` - the search box on `/guides`. No ads of its own; it feeds
  `/search` with typed queries.
- `no-coverage` - the funnel card when a search finds no shops.
- `hunt-ended` - the funnel card on Trips when a hunt went quiet.

In-app cards never render Google's unit: an app screen is not a content page,
and Google requires the unit to be "complementary" to real content. They show
the guide link and search box to everyone, and a link partner's labelled rows
only to consenting free-plan users. Paid plans never see a sponsored row.

---

## 4. Turn it on - about 15 minutes

### 4.1 Find your AFS values (skip for a link partner)

1. Open https://www.google.com/adsense and sign in.
2. Left menu -> **Ads** -> **By ad unit** -> **Search engine**.
3. Copy the **client id** (`partner-pub-` + 16 digits).
4. Left menu -> **Search styles** -> open or create a style -> copy the
   numeric **Style ID**.
5. Left menu -> **Reports** -> **Custom channels** (search) -> **Add channel**
   -> name it `wheeldeal-guides` -> copy its numeric **Channel ID**.

### 4.2 Paste the partner

1. `https://<your domain>/admin` -> **keys** tab.
2. Find **Search traffic partners** -> paste your line -> **Save**.
3. **traffic** tab -> confirm no red box at the top.

### 4.3 Look at it in TEST mode

1. **keys** -> **Search traffic mode** -> `test` -> **Save**.
2. Private window -> `/guides/thailand-scooter-rental-prices`.
3. Cookie banner -> **Accept all**.
4. Scroll to the end of the article. "Related searches" appears with a yellow
   "Test ads - no revenue" tag. A brand-new page can stay empty for up to an
   hour while Google crawls it; escalate to your AM after 48 hours.
5. Tap a term -> you land on `/search` with results and test ads.

### 4.4 Go live

1. **keys** -> `TRAFFIC_MODE` -> `live` -> **Save**.
2. **traffic** tab -> the **mode** tile reads LIVE.

Pause everything instantly: `TRAFFIC_MODE` = `off`. Pause one partner: change
its `on` to `off`. Pause one placement: `placements` in `TRAFFIC_SETTINGS`.

---

## 5. Consent - what the visitor agrees to, and what happens without it

- The category is named **"Advertising and sponsored search"**, and its text
  says the three true things: guides may end with sponsored search
  suggestions, WheelDeal is paid when the ads behind them are used, and their
  use is counted with no name, email or phone number.
- **No consent = nothing.** No Google script, no storage, no log row, not even
  the configuration fetch. `npm run check:cookies` proves it on the network.
- **An old yes does not cover it.** A visitor who accepted advertising before
  2026-09-20 keeps seeing display ads while the re-prompt is up, but gets no
  sponsored search until they answer the banner that actually describes it.
- **Global Privacy Control is a no**, for both Google products, in the browser
  and on the server, whatever was chosen before.
- **Withdrawing works.** Google's cookies on your domain are deleted and the
  page reloads, which is the only way to get a running ad script out of a page.
- A signed-out visitor's choice is provable later via a hashed random receipt
  number. No IP address and no user agent are stored with it.

---

## 6. Regions - where it runs, honestly

It works on every device and browser. It does NOT earn everywhere on day one:

- **Outside the EEA, the UK and Switzerland:** live as soon as `TRAFFIC_MODE`
  is `live`.
- **Inside them:** Google serves NO search ads without a Google-certified TCF
  consent platform, and WheelDeal's banner, however good, is not one. So
  Google's unit is not even requested there. To open Europe, free, about 10
  minutes:
  1. https://www.google.com/adsense -> **Privacy & messaging**.
  2. **GDPR** card -> **Create** -> select this site -> keep both "Consent" and
     "Do not consent" on the first screen -> **Publish**.
  3. If the card says search ads need enabling, ask your AFS account manager to
     enable Privacy & messaging for the Search Ads tag.
  4. Admin -> **keys** -> **Google-certified TCF consent platform** -> `google`
     -> **Save**.
- Link partners are unaffected by this gate - their own page handles consent.
- Region is read from the browser's time zone, because Cloud Run supplies no
  country header. Every `Europe/*` zone counts as inside, including a few
  countries that are not (Turkey, Serbia). Over-including costs a little
  revenue; under-including would mean requesting ads with no consent string
  inside the EEA. The two mistakes are not the same size.

---

## 7. Buying traffic to a guide (arbitrage)

Organic visitors need nothing extra. For paid arrivals Google has required
since 1 Nov 2025 that the ad's creative text is passed verbatim, and an
inaccurate one is a named strike category. Both steps are needed:

1. **Declare the creative.** Admin -> **keys** -> **Ad creatives you run to the
   guides** -> the ad's exact text, one per line -> **Save**.
2. **Put the same text on the landing URL** as `rac`:

   ```
   /guides/thailand-scooter-rental-prices?rac=Compare%20scooter%20rental%20prices%20in%20Thailand
   ```

A creative is declared to Google ONLY when the URL's `rac` exactly matches a
line you declared (case-sensitive; extra spaces are forgiven). Anyone can link
to a guide with `?rac=anything`; without the list, a stranger's link could make
this site declare a false creative and earn the account a strike.

The ad, the landing page and the search terms must describe the same thing -
"traffic sources must accurately describe the destination". Land a Thailand
scooter ad on the Thailand scooter guide, not on the hub.

---

## 8. The rules the code keeps, so you do not have to remember them

Breaking one of these does not fail loudly. It gets the account struck weeks
later. Each is enforced in code and pinned by a test or a browser check.

- **One related-search unit per page, Google's own terms, no click tracking
  inside the unit, no custom sizing.** All four are Restricted Access Features
  since 25 Aug 2025 (AM approval plus over $10,000 a month). None is used. If
  you hold RAF status, set `"raf": true` and tell Claude which features.
- **One ad request per document.** Guides and `/search` link onward with plain
  anchors so each is a real page load; a guard refuses a second request.
- **`/search` is a real results page.** Results cap the ads; zero results means
  zero ads and an honest "nothing found". It is `noindex`. The box is never
  pre-filled.
- **The unit sits after the article**, never inside or above it.
- **Nothing identifying reaches a partner.** The sub-id is
  `p<placement>-m<market>-c<category>-<hash8>`: fixed codes plus a hash that
  rotates every UTC day. Hostile input collapses to a neutral bucket.
- **A typed query is never stored.** The log keeps a term only when Google
  issued it.
- **No empty sponsored frames.** A unit that did not fill leaves nothing on the
  page.

---

## 9. "100% free" - exactly what that covers

Free, permanently:

- The whole module. It uses no paid library, API or service.
- Google AFS and feed partners: revenue share, no fee to join.
- Google's Privacy & messaging consent platform.
- Hosting the funnel itself: `/guides` are static, `/search` is one cheap
  server render, and the log is a few narrow rows per visit.

Not free, and not something code can change:

- Feed partners have minimums. Tonic, for example, expects four-digit daily
  spend before it approves an account.
- Your existing stack's free tiers are the ceiling on TRAFFIC, not on this
  module: Supabase's free plan allows 5 GB of egress a month and 500 MB of
  storage. The funnel adds little to either, but a genuinely successful content
  site will outgrow them, and that is a good problem.

---

## 10. Operating it

**Daily, in the first two weeks:** Admin -> Traffic.

- **fill rate** - shown / (shown + empty). Low on a new page for the first
  hour is normal.
- **reached /search** - arrivals on the results page. This site cannot see
  clicks inside Google's unit, so this is the nearest first-party fact.
- Any red (rejected partner line) or amber (clamped setting) box.

**Weekly:** import each partner's report (owner only).

1. Download the CSV from the partner: date, sub-id or channel, clicks,
   revenue. Any column order.
2. Admin -> Traffic -> **Import a partner's revenue report** -> pick the
   partner -> **Choose CSV**.
3. Importing the same day again REPLACES it - load the finalised file over the
   early estimate (partners finalise 7 to 10 days later).
4. Read the flags:
   - **UNDER-COUNTED** - a link partner counted under 60% of the clicks you
     sent. It is discarding them as invalid. Look at that placement's traffic
     source now, before payout, not after a clawback.
   - **WE UNDER-LOGGED** - the partner reports far more clicks than you logged.
   - For Google's unit all revenue shows as **unattributed**: Google reports by
     channel, not sub-id. Expected.

---

## 11. Verifying a change

```
npm run typecheck && npx vitest run
npm run build && npm run check:cookies   # nothing loads without consent
npm run build && npm run check:traffic   # what loads is what policy allows
```

`check:traffic` replaces Google's script with a recorder, so it never touches
Google and never produces an impression, and asserts on the exact options
sent. Set `TRAFFIC_CHECK_SHOTS=/some/dir` for screenshots. Both checks are hard
gates in CI: a red one blocks the deploy.

---

## 12. Troubleshooting

- **Nothing shows on a guide.** In order: `TRAFFIC_MODE` is `off`; you did not
  accept advertising in THIS browser; your browser sends Global Privacy Control
  (Brave and Firefox can); your time zone is European and `TRAFFIC_TCF_CMP` is
  `none`; the partner line was rejected (red box); the `guide-inline` placement
  is off; or Google has not crawled a new page yet.
- **The unit shows but `/search` has no ads.** The query matched no guide (by
  design: zero results, zero ads), or `search-results` is off, or `maxAds`
  exceeds the result count and was capped.
- **A setting seems ignored.** Look for the amber box on Admin -> Traffic - it
  was clamped or could not be parsed.
- **`rac` is not being passed.** It must match a declared creative exactly.
- **ads.txt.** `public/ads.txt` authorises this site's own AdSense account. If
  a feed partner gave you THEIR `pub-` id they will also give you an ads.txt
  line; it is a code change (a test pins the file), so tell Claude the line.

---

## 13. Not built yet

- Consented first-touch attribution (source, campaign, landing, referrer).
- Partner reporting APIs (System1, Tonic) in place of the CSV import.
- A funnel entry on `/welcome` and at the free-plan limit.
- Translated guides. The unit passes the page language (`hl`), but the articles
  themselves are English.

## 14. Known limits, stated plainly

- The name of Google's click-token parameter (`afdToken`) comes from
  observation, not Google's documentation. If Google renames it the only effect
  is that terms stop being stored - the safe direction.
- This has been verified against a recorder standing in for Google's script,
  and in `test` mode it can be seen against the real one. It has not yet earned
  a real dollar, because no partner credentials have been configured.
