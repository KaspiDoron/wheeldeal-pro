# Sponsored search - how it works, and how to turn it on

Date: 2026-09-20. Code: `src/lib/traffic/`, `src/components/traffic/`,
`src/app/search/`, `src/app/api/traffic/`. Admin screen: Admin -> Traffic.

Sponsored search monetises consenting organic visitors to the guides. A guide
may end with one related-search unit; tapping a term opens `/search`, which
shows real results from the guides plus search ads. WheelDeal is paid when
those ads are used. It is OFF until you switch it on.

## What is built, and the rules it is built to

Every rule below is enforced in code and pinned by a test or a browser check,
because breaking one does not fail loudly - it gets the AdSense account struck
weeks later.

- **Consent first, and the consent says what it covers.** Nothing loads, is
  stored or is logged unless the visitor allowed the "Advertising and sponsored
  search" category. The banner text names sponsored search, that WheelDeal is
  paid through it, and that its use is counted anonymously. The cookie policy
  version was bumped to 2026-09-20, so every visitor is asked again - a yes
  given to display ads was not a yes to this.
- **A Global Privacy Control signal is a no**, whatever was chosen before, for
  both Google products, in the browser and on the server.
- **One unit per page, Google's own terms, no click tracking in the unit.**
  Since 25 Aug 2025 Google treats these as Restricted Access Features (they
  need account-manager approval and over $10,000 a month): more than one
  related-search unit, supplying your own `terms`, custom sizing, and click
  tracking inside the unit. None of them is used.
- **One ad request per document.** Guides link to each other with plain
  anchors so each is a real page load, and a guard refuses a second request if
  a soft navigation ever keeps the document alive.
- **`/search` is a real results page.** It searches the guides, and the number
  of results caps the number of ads. Zero results means zero ads and an honest
  "nothing found". It is `noindex`. The search box is never pre-filled.
- **Nothing identifying can reach a partner.** The sub-id is built only from
  fixed category codes and a hash that rotates every UTC day. Hostile input
  collapses to a neutral bucket; there is no path from a caller's string to it.
- **A typed query is never stored.** The log keeps a search term only when
  Google issued it (the visitor arrived with Google's own click token).
- **The EEA, the UK and Switzerland are excluded by default.** Google serves no
  search ads there without a Google-certified TCF consent platform, and this
  app's banner is not one. So they are not requested there at all until you
  install one (step 5).

## Turn it on - about 15 minutes

You need ONE of these before you start:

- a direct Google AdSense for Search (AFS) account with Related Search for
  Content enabled by your account manager, OR
- a feed partner's credentials for running RSOC on your own domain (they hand
  you their `pub-` id, a style id and usually a channel id), OR
- a link-style feed partner that gives you a results URL with a keyword
  parameter and a sub-id parameter.

### Step 1 - find your three AFS values (skip for a link partner)

1. Open https://www.google.com/adsense and sign in.
2. Left menu -> **Ads** -> **By ad unit** -> **Search engine** (the AFS area).
3. **Client id**: shown as `partner-pub-` followed by 16 digits. Copy it. The
   app accepts it with or without `partner-`.
4. Left menu -> **Search styles** -> open (or create) a style -> copy the
   numeric **Style ID** from the page URL or the code snippet.
5. Left menu -> **Reports** -> **Custom channels** (search) -> **Add channel**
   -> name it `wheeldeal-guides` -> copy its numeric **Channel ID**. Optional,
   but without it Google's report cannot separate this site from your others.

### Step 2 - paste the partner line

1. Open `https://<your app domain>/admin`.
2. Tap the **keys** tab.
3. Find **Search traffic partners** (`TRAFFIC_PARTNERS`). Paste ONE line per
   partner.

   Google in-page unit:

   ```
   google|afs|Google AFS|on|pub-1234567890123456:1234567890:9876543210||1
   ```

   Link partner (the `{q}` and `{subid}` placeholders are required, https only,
   and they may only appear in the query string):

   ```
   feed-a|link|Feed A|on|https://search.partner.example/s?q={q}&subid={subid}|th,vn|0.8
   ```

   Fields: `id | kind | label | on/off | target | markets | revenue share`.
   Markets are ISO country codes, comma separated; leave empty for every
   market. Revenue share is your cut, 0 to 1 (reporting only).
4. Tap **Save**.
5. Tap the **traffic** tab. If a line was rejected it is listed in red at the
   top with the reason. Fix it before going on - a rejected partner is not
   live.

### Step 3 - look at it in TEST mode

1. **keys** tab -> **Search traffic mode** (`TRAFFIC_MODE`) -> type `test` ->
   **Save**.
2. Open any guide in a private window, for example
   `/guides/thailand-scooter-rental-prices`.
3. Tap **Accept all** on the cookie banner.
4. Scroll to the end of the article. A "Related searches" unit appears with a
   yellow "Test ads - no revenue" tag. A brand-new page can stay empty for up
   to an hour: Google crawls the article before it writes terms for it.

`test` sets Google's `adtest: on`. Use it for every look at a live unit -
clicking your own real ads is invalid traffic. Test views are never logged.

### Step 4 - go live

1. **keys** tab -> `TRAFFIC_MODE` -> type `live` -> **Save**.
2. **traffic** tab -> the **mode** tile reads LIVE.

To pause everything instantly: set `TRAFFIC_MODE` to `off`. To pause one
partner: change its `on` to `off` in `TRAFFIC_PARTNERS`.

### Step 5 - open Europe (free, optional, about 10 minutes)

1. https://www.google.com/adsense -> left menu -> **Privacy & messaging**.
2. **GDPR** card -> **Create** -> choose this site -> keep "Consent" and
   "Do not consent" both on the first screen -> **Publish**.
3. If the GDPR card says search ads need enabling, ask your AFS account manager
   to enable Privacy & messaging for the Search Ads tag.
4. Back in the app: **keys** tab -> **Google-certified TCF consent platform**
   (`TRAFFIC_TCF_CMP`) -> type `google` -> **Save**.

Until step 4 of this section is done, visitors whose browser time zone is in
Europe are simply not shown Google's unit. Link partners are unaffected.

### Step 6 - ads.txt, only if the `pub-` id is NOT your own

`public/ads.txt` already authorises this site's own AdSense account. If a feed
partner gave you THEIR `pub-` id, they will also give you an ads.txt line
(usually ending `RESELLER`). Tell Claude the line and it will be added - a test
pins the file's exact contents, so it is a code change, not a paste.

## Reading the Traffic tab

- **units shown / units empty** - the unit loaded with, or without, suggestions.
- **reached /search** - visitors who arrived on the results page. This site
  cannot see clicks inside Google's unit, so arrival here is the nearest
  first-party fact.
- **fill rate** - shown / (shown + empty).
- **Import a partner's revenue report** (owner only) - a CSV with a date, a
  sub-id or channel, clicks and revenue, in any column order. Importing the
  same day again REPLACES it, so load the finalised file over the early
  estimate. Every import is on the audit trail.
- **UNDER-COUNTED** - a link partner counted under 60% of the clicks sent. It is
  discarding them as invalid: look at that placement's traffic source before
  payout, not after.
- For Google's unit all revenue shows as **unattributed**. That is expected:
  Google reports by channel, not by sub-id.

## If you buy traffic to a guide

Organic visitors need nothing extra. If you run paid ads to a guide, Google has
required since 1 Nov 2025 that the ad's creative text is passed verbatim. Add
it to the landing URL as `rac`:

```
/guides/thailand-scooter-rental-prices?rac=Compare%20scooter%20rental%20prices%20in%20Thailand
```

The unit forwards it as `referrerAdCreative`. An inaccurate value is a policy
violation, so it must be the literal text of the ad.

## Checks

```
npm run build && npm run check:cookies   # nothing loads without consent (27 checks)
npm run build && npm run check:traffic   # what loads is correct (54 checks)
```

`check:traffic` replaces Google's script with a recorder, so it never touches
Google and never produces an impression. Set `TRAFFIC_CHECK_SHOTS=/some/dir` to
save screenshots.

## Known limits, stated plainly

- The name of Google's click-token parameter (`afdToken`) is from observation,
  not from Google's documentation. If Google renames it the only effect is that
  terms stop being stored - the safe direction.
- Region is decided from the browser's time zone, because Cloud Run supplies no
  country header. Every `Europe/*` zone counts as inside, including a few
  countries that are not (Turkey, Serbia). That over-inclusion is deliberate.
- Revenue import is a CSV upload. Partner reporting APIs (System1, Tonic) can
  replace it once there is a partner to write against.
