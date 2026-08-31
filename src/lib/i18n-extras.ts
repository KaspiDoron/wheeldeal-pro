// DECLARED UI COPY THAT NO GREP CAN FIND.
//
// scripts/gen-i18n-catalog.js builds the catalogue from literal `t("...")`
// calls. Some user-facing sentences never appear as a literal argument: they
// live in a constant table and reach `t()` through a variable -
// `t(badge.what)`, `t(m)`, `t(q)`. The grep sees `t(m)` and finds nothing, so
// those lines shipped untranslated.
//
// This file is where they are declared. It is not decoration: since `t()` now
// refuses to queue anything outside the catalogue (a string handed to `t()` is
// POSTed to /api/translate and cached into a GLOBALLY SHARED row, so an
// unbounded input is a cross-user leak), a string that is not in the catalogue
// is not translated at all. Adding computed copy here is the ONLY way it gets
// translated.
//
// The generator picks up every two-space-indented quoted line below, so keep
// the plain array shape. Run `node scripts/gen-i18n-catalog.js` after editing.
export const I18N_EXTRAS: string[] = [
  // src/components/Tracker.tsx - StageBadge + stageCaption. Rendered as
  // t(s.text) / t(stageCaption(...).text), so no literal exists for the grep.
  // Owner report 3, item 10: every stage chip and caption stayed English in a
  // Hebrew app because none of these ever entered the pipeline.
  "Queued",
  "Locating",
  "Ready",
  "No WhatsApp",
  "Sending",
  "RFQ sent",
  "Awaiting reply",
  "Negotiating",
  "Offer in",
  "Counter sent",
  "No response",
  "Out of stock",
  "Declined",
  "Queued - your agent starts on this shop in a moment.",
  "Your agent is finding this shop's WhatsApp number.",
  "Shop found - ask for the price and your agent takes it from there.",
  "No WhatsApp number found for this shop - a nearby shop may work better.",
  "Your agent messaged the shop asking for the best price.",
  "Waiting for the shop to reply - your agent is watching for it.",
  "Your agent is haggling with the shop for a lower price.",
  "Price is in - review the shop's offer below.",
  "Your agent countered the shop's quote - pushing for a better price.",
  "No reply yet. Your agent will keep watching for one.",
  "No vehicle available here right now - your agent asked when one is back.",
  "This shop passed - other shops are still negotiating.",
  "Your agent is on it.",
  // src/components/PhotoGallery.tsx - the count line is a {n} template
  // (translated WHOLE, number substituted after - RTL puts it on the other
  // side of a concatenation).
  "{n} photos",
  // src/lib/queue-reason.ts - queueReasonWhy(). Rendered as
  // t(queueReasonWhy(...)), so there is no literal for the grep to find. These
  // explain WHY a first message waits, which matters more since cold intros
  // stopped going out overnight: without the reason, a shop sitting untouched
  // until morning reads as a broken app.
  "This shop is closed right now. A first message sent at 3am is still read at 9am - it only makes your number look automated, which is what gets WhatsApp numbers restricted. Shops already talking to you are answered immediately, day or night.",
  "You have used today's batch of NEW shops. Conversations already open keep running normally - only first messages wait.",
  "Your plan opens new shops in batches, so your number stays under WhatsApp's radar. Shops already replying are unaffected.",
  "WhatsApp pushed back on this number, so first messages pause while it settles. Replies to shops that wrote to you still go out.",
  // src/components/UpgradeSheet.tsx - the warm-up gate. The progress line is
  // rendered as t(warm.progress.template) and the checklist as t(x.label), so
  // neither is a literal the grep can see. The {n} templates are translated
  // WHOLE and substituted afterwards - concatenating a count onto a translated
  // fragment puts the number on the wrong side in RTL.
  "Connect WhatsApp to get started.",
  "One search away.",
  "{n} searches away.",
  "One more shop away.",
  "{n} more shops away.",
  "One shop reply away.",
  "{n} shop replies away.",
  "WhatsApp connected",
  "Searches run",
  "Shops reached",
  "Shops that replied",
  "We want you to get the most out of Premium, so unlock it by using the app a little more first.",

  // src/components/landing/TrustPanel.tsx - MECHANICS + CANNOT_PROMISE,
  // rendered as t(m) and t(CANNOT_PROMISE).
  //
  // THESE HAD DRIFTED, AND THE DRIFT WAS THE WORST POSSIBLE KIND. The six
  // strings that used to sit here were RETRACTED from the component - the
  // panel's own header explains why, at length: an affirmative misstatement of
  // present fact on the screen that induces someone to link their personal
  // number is not cured by a disclaimer elsewhere. They were rewritten to
  // describe only what the code actually does.
  //
  // But this file was never updated. So the app was paying, on every language
  // switch, to translate six sentences NOTHING renders - while the five that
  // ARE rendered, and the one line that says what we cannot promise, were
  // absent from the catalogue and therefore shipped in English to all nineteen
  // other languages. A traveller reading in Thai or Hebrew got an untranslated
  // wall of English at exactly the moment they were deciding whether to trust
  // us with their WhatsApp number.
  //
  // If MECHANICS or CANNOT_PROMISE changes again, change it here in the same
  // commit. There is a test asserting the two stay in step.
  "Human pacing: randomised gaps between messages, a per-shop send lock, and a hard hourly and daily budget.",
  "Business-hours awareness: we know each shop's local hours and message the open ones first. A closed shop still gets your message - it simply waits unread until they open.",
  "Every message is uniquely worded - no two shops receive the same text, and your dates are always included so a shop can actually answer.",
  "One introduction per shop. After that your agent only writes again once the shop has actually written back.",
  "If WhatsApp pushes back on a new conversation, your agent stops opening new ones and keeps answering the shops already talking to you.",
  "What we cannot promise: WhatsApp decides what happens to your number. Messaging many new shops who never reply is what gets personal numbers restricted, and no amount of pacing rules that out. Link a number you could manage without.",

  // src/components/Filters.tsx - the sort/filter rail. The vehicle-class chips
  // render t(vehicleLabelPlural(v)) and the verified-terms chips render
  // t(label) from a table, so neither is a literal the grep can see.
  "Automatic scooters",
  "Manual motorcycles",
  "Cars",
  "Rents cars",
  "Delivers",
  "No deposit",
  "Passport deposit",
  "Cash deposit",
  "Helmets",
  "Insurance",

  // src/components/will/WillSheet.tsx - QUICK chips, rendered as t(q)
  "What can you do?",
  "What's happening right now?",
  "Compare the top 3",
  "Why is this the best option?",
  "Try negotiating harder",
  "Open my trips",
  "Pause this search",

  // src/lib/offer-badges.ts - OFFER_BADGES, rendered as t(badge.label/what/next)
  "VERIFIED",
  "SHOP QUOTE",
  "UNVERIFIED",
  "DIFFERENT VEHICLE",
  "The shop confirmed IN WRITING that this price is for the exact vehicle you asked for. This is the strongest state an offer reaches, and it is safe to lock.",
  "A real price a real shop gave us for your request. It has not been double-confirmed against the exact model yet - which is normal, not a warning.",
  "Nothing to do. Lock it if you like it, or let the agent keep pushing.",
  "The price is real and lockable. Your agent is asking the shop to confirm exactly which model it covers, and this badge flips to VERIFIED on its own when it answers.",
  "Nothing to do - it resolves itself, usually within a few minutes.",
  "This price is for a DIFFERENT vehicle than the one you asked for - a smaller engine, an automatic instead of a manual, or another class entirely. It is not counted as your best deal.",
  "Your agent is asking the shop about the vehicle you wanted. If you would take this one instead, say so and it becomes the target.",

  // src/components/RequestBuilder.tsx - the review chips capitalise the chosen
  // vehicle and echo the gearbox/body words back, none of them as literals.
  "Scooter",
  "Motorbike",
  "Car",
  "automatic",
  "manual",

  // src/components/AgenticSummary.tsx - t(reading.confidence)
  "high",
  "medium",
  "low",

  // src/lib/media/reading.ts - readingHeadline() and readingEmptyLine() reach
  // the panel as t(readingHeadline(r)) / t(readingEmptyLine(r)), so no literal
  // exists for the grep. Owner report 5: THREE different failures of OURS (an
  // unparseable answer, a generation cut off at our token ceiling, a price our
  // own sanity net rejected) all rendered as the ONE sentence reserved for "the
  // photo was blank". Each says what actually happened now, so each needs a
  // translation - a traveller reading in Thai got the honest English or
  // nothing.
  "Your agent is re-reading this one",
  "Too long to read in one go - re-reading",
  "One price here looks wrong - checking",
  "Could not read this one yet",
  "Nothing readable in this one",
  "Your agent could not read this one yet - our reader answered with something we could not use. That is our side failing, not your photo, and it is being retried.",
  "This board is longer than our reader was allowed to answer, so its reading was cut off part-way. That is our limit, not your photo - your agent is reading it again with more room.",
  "We read a price off this one that cannot be right for this area - so your agent is asking the shop to confirm it instead of quoting a number we do not trust.",
  "We could not read anything usable from this one.",

  // src/components/SiteFooter.tsx - the public guides hub link (wave 4.4)
  "Guides",

  // src/components/PlaceAutocomplete.tsx - the prop DEFAULT reaches t() as
  // t(placeholder), so the literal lives in the parameter list, not in a
  // t("...") call the grep can see.
  "Search hotel, address or area...",

  // src/components/FeedbackModal.tsx - the category chips and the status pills
  // reach t() as t(c.label) / t(meta.label), so no literal exists for the grep
  // (W6.2: categories now drive a filter on both sides, which made them
  // suddenly much more visible).
  "Bug",
  "UI / layout",
  "Slow / performance",
  "Crash / blank",
  "Suggestion",
  "Question",
  "Other",
  "All",
  "Open",
  "In progress",
  "Resolved",
  "Closed",

  // src/app/deals/page.tsx - TripsUpgradeGate renders the shared plan
  // catalogue (lib/plans) through t(p.name) / t(p.blurb) / t(f), so no literal
  // exists for the grep. W6.1: Trips is a Pro/Ultra section and a free
  // traveller meets these tier cards, so they are user-facing copy now.
  "Pro Traveller",
  "Best for frequent travellers",
  "100% ad-free experience",
  "Priority negotiation agents",
  "Mass bargain: ask many shops at once",
  "Schedule pickups for future days",
  "Saved trips & full order history",
  "Ultra",
  "The ultimate bargaining machine",
  "Everything in Pro",
  "Agents bargain in the shop's LOCAL language - real street talk",
  "Locals-only pricing: agents anchor to the real local market floor",
  "See the English translation of every local-language message",
  "Fast-responder insights: which shops reply quickest",
  // ---- W8 #15: THREE WHOLE TRAVELLER-FACING SURFACES SHIPPED IN ENGLISH ----
  //
  // `t()` refuses any string that is not in the catalogue (an uncatalogued
  // string would be POSTed to /api/translate and cached into a GLOBALLY SHARED
  // row, so unbounded input is a cross-user leak). Everything below IS wrapped
  // in `t()` at the render site and was never in the catalogue, so all of it
  // rendered English in all nineteen non-English languages - silently, with no
  // error anywhere, on three surfaces a traveller reads constantly.

  // src/app/api/activity/route.ts - STAGE_TITLES. Every line of the Activity
  // tab's feed is authored server-side and rendered as t(it.title).
  "Listened to the shop's voice note",
  "Read the shop's reply",
  "Double-checked the photo against the conversation",
  "Checked what the deal is still missing",
  "Chose the next move",
  "Bargained for a better price",
  "Asked the shop to clarify",
  "Answered the shop's question",
  "Asked about the deposit",
  "Asked how you get the vehicle",
  "Shared your pickup location (with your consent)",
  "Wrapped up the conversation",
  "Marked this offer ready for you",
  "Sent the closing message",
  "Message on its way to the shop",
  // ...and the feed's non-trace titles, from the same route.
  "You messaged the shop yourself",
  "Message sent to the shop",
  "The shop replied (with a photo)",
  "The shop replied",
  "Confirmed offer in",
  "Offer in (unconfirmed)",
  "Will is waiting on purpose",
  "A shop shared a contact",
  "Will flagged this reply - please review",

  // src/lib/wa/safety-signals.ts - dropFeedItem(). A closed set of app-authored
  // sentences (never shop text), so the DETAIL is translated too.
  "A shop reply needs attention",
  "A message was not sent",
  "A message arrived from a number your agent never contacted, so it was not linked to any shop.",
  "A reply arrived from a hidden WhatsApp identity and couldn't be matched to a shop yet.",
  "The shop sent a photo or voice note that couldn't be downloaded.",
  "A reply was saved but couldn't be linked to a shop card.",
  "A reply couldn't be checked on the first try - it is retried automatically.",
  "A reply couldn't be saved on the first try - it is retried automatically.",
  "A recovered reply couldn't be answered on the first try - it is retried automatically.",
  "Checking this shop's thread failed once - it is retried automatically.",
  "A reply couldn't be answered because your records were briefly unreadable - it retries automatically.",
  "A reply couldn't be processed automatically.",
  // W12a: the funnel ledger finally reaches the card, so the card can say
  // "they answered" without claiming a price is being pinned down.
  "Replied",
  "The shop answered - your agent is reading their reply.",
  "This shop said no. Nothing further is being asked here.",
  "Nothing available here right now - your agent asked when one is back.",
  "Shop said no",
  "None available now",
  "A duplicate of a message this shop already received was skipped.",
  "This shop already got your request in the last day, so a repeat was skipped.",
  "This shop hasn't answered earlier messages, so a repeat wasn't sent - this protects your WhatsApp number.",
  "A message was skipped by the safety guard.",

  // src/lib/wa-guard.ts senderSafety() + src/lib/wa/safety-signals.ts
  // classifySafety() - the WhatsApp-safety explainer, rendered as
  // t(safety.publicReason). The panel that explains why a traveller's PERSONAL
  // number is being paced, in English, to someone reading the app in Thai.
  "Sending is taking a short break and resumes automatically - your queued messages are safe.",
  "We can't check your messaging status right now. Nothing is lost - this refreshes on its own in a moment.",
  "Your agent is sending messages at a natural, human pace - each one goes out automatically.",
  "WhatsApp is disconnected, so shop replies cannot reach the app - reconnect in Profile to keep your conversations moving.",
  "Some messages needed attention in the last day - check the activity feed to see what happened to each one.",

  // src/lib/queue-reason.ts - queueReasonLabel(). queueReasonWhy() was
  // catalogued above and its sibling was missed, so the SHORT label on every
  // queued row - the line a traveller actually reads on the card and in the
  // Live Status queue - stayed English while the long explanation under it
  // was translated. Rendered as t(queueReasonLabel(...)).
  "Waiting for the shop to open - sends automatically",
  "Paused by you - resumes when you say so",
  "Your agent is timing this reply like a human",
  "In line - your agent messages shops one at a time, like a person",
  "Queued - sending resumes automatically in a few minutes",
  "You've reached your plan's batch of new shops - more open up shortly, automatically",
  "Today's introductions are done - this goes out tomorrow morning automatically",
  "Protecting your WhatsApp number - new-shop messages resume automatically in a few hours",
  "Queued briefly - sends are paced like a human",
  "Done for now - sending resumes automatically later today",
  "Queued - sends automatically",
  // ...and the two states the queue viewer composes itself.
  "Sending now",
  "Sending shortly",

  // src/app/api/activity/route.ts STAGE_TITLES - the SPTE moves' feed titles,
  // rendered as t(title). The other titles in that map double as literals
  // elsewhere; these six exist only in the computed map, and they were once
  // hand-added to the generated catalogue file - which a regeneration then
  // silently dropped. Declared here so the generator owns them like the rest.
  "Nudged the shop to keep things moving",
  "Double-checked a detail with the shop",
  "Made sure it's the exact vehicle you asked for",
  "Asked what separates the options",
  "Asked when it's back in stock",
  "Recapped the deal for the shop to confirm",
];
