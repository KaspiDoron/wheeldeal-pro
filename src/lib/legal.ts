// Single source of truth for WheelDeal's legal architecture. Pages AND modals
// render from here, so the Terms of Use, Privacy Policy and the mandatory
// signup checkboxes can never drift apart. Tone: aggressive protection of the
// developer (zero liability), plain-English MVP style.
//
// NOTE FOR THE OWNER: `OPERATOR_NAME` is the only place to insert a real legal
// entity (e.g. "WheelDeal Ltd."). Until then it reads as "the Operator".

// Bumped when the WhatsApp linking consent copy changed: the visible "short
// version" used to summarise away the one material term in the document it
// summarised (that WhatsApp can restrict or ban a number for using an
// unofficial connection). Existing linked users are re-prompted, because the
// thing they agreed to was not what the document said.
// Bumped 2026-08-30 (W9): privacy sections 3/6/8 rewritten - per-purpose legal
// bases with the two opt-in switches, the REAL retention windows the nightly
// prune now enforces, the DSAR endpoints, and the honest market-statistics
// carve-out replacing the blanket "not sold" line. The re-acceptance gate
// (needsReacceptance) puts every existing user through the new text once.
//
// Bumped 2026-08-31: section 2 now discloses the messaging layer's transient
// (max 7 days) copy of messages on the linked number - the reply-recovery
// store render.yaml has always actually configured. The policy said that
// store "does not exist"; the fix was to make the policy true, not the code
// blind (turning the store off silently kills missed-reply recovery).
export const TERMS_VERSION = "2026-08-31";
export const OPERATOR_NAME = "the Operator"; // TODO: replace with the legal entity name
export const GOVERNING_LAW = "the State of Israel";
export const JURISDICTION = "the competent courts of Tel Aviv, Israel";

// The three mandatory consents recorded at signup. Since 2026-07 they are
// collected through ONE clearly-labelled acceptance action (the label names
// the WhatsApp-connection and AI-assistant acknowledgements and links the
// full text; a plain-English summary sits right below it) - standard
// clickwrap. Each consent still stamps its own durable acceptance column on
// app_users, so consent stays provable per user, per version. The `label`
// strings below are the canonical legal wording of WHAT was accepted and are
// rendered inside the Terms (sections 2-3 cover the same ground).
export interface Consent {
  id: "terms" | "wa_risk" | "ai_responsibility" | "number_sharing";
  column:
    | "terms_accepted_at"
    | "wa_risk_accepted_at"
    | "ai_responsibility_accepted_at"
    | "number_sharing_accepted_at";
  label: string;
}

export const CONSENTS: Consent[] = [
  {
    id: "terms",
    column: "terms_accepted_at",
    label:
      "I have read and accept the Terms of Use and Privacy Policy, including the liability cap, the class-action waiver, and that all disputes are governed by the laws of the State of Israel and resolved exclusively in the competent courts of Tel Aviv, Israel.",
  },
  {
    id: "wa_risk",
    column: "wa_risk_accepted_at",
    label:
      "I understand WheelDeal connects to WhatsApp using an unofficial, reverse-engineered method that Meta/WhatsApp do not permit for automation. Meta may block, suspend or PERMANENTLY BAN my phone number, and I assume 100% of that risk with zero liability to the Operator. Using a spare number is recommended.",
  },
  {
    // SHARING THE TRAVELLER'S NUMBER WITH A THIRD PARTY.
    //
    // Under the business-number handoff (plan Part 12) WheelDeal's own official
    // WhatsApp number asks a rental agency to contact the traveller, which means
    // handing that agency their phone number and expecting an unsolicited
    // inbound message from a business they have never written to. That is new
    // personal-data disclosure and a genuinely surprising experience, so it gets
    // its own recorded acceptance rather than being folded into the general
    // terms - and the label says plainly what will happen, because a traveller
    // startled by a message from a rental shop is a support ticket and a trust
    // failure, not a UX detail.
    id: "number_sharing",
    column: "number_sharing_accepted_at",
    label:
      "I understand that when I ask WheelDeal to contact a rental shop, WheelDeal may send that shop a message from its own business number giving them my WhatsApp number, and that the shop will then message me directly. I can turn this off at any time.",
  },
  {
    id: "ai_responsibility",
    column: "ai_responsibility_accepted_at",
    label:
      "I understand the AI may make mistakes ('hallucinations'), send offensive content or false promises, and that I am SOLELY responsible for every message, contract and commitment it sends from my account. I confirm I have the legal right to process my contacts' messages, and I will not submit sensitive data (medical, payment-card, government-ID) or use the service for spam, harassment or any unlawful purpose.",
  },
];

export interface LegalSection {
  n: string;
  title: string;
  body: string;
}

// ---- Terms of Use --------------------------------------------------------------

// ---- The six named risks -------------------------------------------------------
//
// The general releases above are broad, and breadth is exactly the problem: a
// clause that covers "any and all claims" tells a traveller nothing about what
// can actually go wrong to THEM, and tells a court nothing about what they were
// told. These six are the failure modes this product really produces - each one
// has either happened in the field or is one bad afternoon away - and each is
// named so it can be pointed at.
//
// The ANCHORS are load-bearing. They are asserted by a test, so a future edit
// cannot quietly drop one while leaving the section looking complete; and they
// are what the first-touch modal renders, so the summary and the full terms
// cannot drift apart.
export interface IndemnityClause {
  /** Stable id. Never rename one - a test and the consent record both use it. */
  anchor: string;
  n: string;
  title: string;
  /** One line for the first-touch modal. */
  summary: string;
  body: string;
}

export const INDEMNITY_CLAUSES: IndemnityClause[] = [
  {
    anchor: "misdirected-messages",
    n: "11",
    title: "Messages sent to the wrong person, or that you did not write",
    summary: "Automated messages go out from your number - including, occasionally, to the wrong number.",
    body:
      `Messages are sent automatically FROM YOUR OWN WhatsApp number, in your name, without you seeing each one first. Phone numbers published by businesses are frequently wrong, reassigned, or belong to a private individual, and an automated message may therefore reach someone who never asked to hear from you. You accept sole responsibility for every message sent from your account, including misdirected messages, messages a recipient considers unsolicited, and messages you did not personally compose or approve. ${OPERATOR_NAME} has no liability for any claim, complaint, report, distress or dispute arising from any message sent from your number.`,
  },
  {
    anchor: "whatsapp-bans",
    n: "12",
    title: "WhatsApp flags, suspensions and permanent bans - yours AND the shop's",
    summary: "Your WhatsApp number can be limited or permanently banned. So can a shop's.",
    body:
      `Automated messaging can cause WhatsApp to rate-limit, flag, suspend or PERMANENTLY BAN a phone number, and this applies both to YOUR number and to the number of any business you message - a business may be flagged for receiving or replying to automated traffic. ${OPERATOR_NAME} applies human-pace limits and anti-pattern controls but gives NO guarantee whatsoever. You accept the total loss of your number, your message history, and any account tied to it, and you indemnify ${OPERATOR_NAME} against any claim by any business whose number is restricted in connection with your use of the service.`,
  },
  {
    anchor: "ai-errors",
    n: "13",
    title: "AI errors: wrong prices, false availability, promises we cannot keep",
    summary: "The AI can state a wrong price, a vehicle that is not available, or a promise nobody agreed to.",
    body:
      `The automated agents read messages and reply on your behalf, and they can be WRONG in ways that cost money: quoting or accepting a price that was never offered, reporting a vehicle as available when it is not, misreading a photo, a price board or a foreign-language reply, or making a statement a business later treats as a commitment. No message sent by the service is a verified fact or a binding agreement, and ${OPERATOR_NAME} does not warrant the accuracy of any price, availability, specification or term surfaced by the app. You must confirm every material detail directly with the business before you pay, sign, or collect a vehicle.`,
  },
  {
    anchor: "vehicle-and-road",
    n: "14",
    title: "The vehicle, the road, and the law where you are riding",
    summary: "Defects, accidents, insurance, helmets and traffic fines are between you, the shop and local law.",
    body:
      "The condition, roadworthiness, maintenance, brakes, tyres and safety of any vehicle are the responsibility of the business that rents it to you. You are solely responsible for holding a licence valid in that country for that vehicle class, for any international driving permit requirement, for wearing a helmet and complying with every local traffic law, and for any fine, penalty, impoundment or prosecution. Rental vehicles frequently carry NO insurance, or insurance that excludes an unlicensed rider. The Released Parties accept no responsibility whatsoever for any accident, injury, death, damage, theft, fine or legal consequence arising from any vehicle or any journey.",
  },
  {
    anchor: "deposits-and-documents",
    n: "15",
    title: "Deposits, passports held as security, and damage disputes",
    summary: "Cash deposits and held passports can be lost, withheld, or used to extract a payment.",
    body:
      `It is normal practice in many rental markets to demand a cash deposit or to hold a passport, identity document or driving licence for the duration of the rental. These arrangements carry real risk: a deposit may not be returned, a document may be withheld to force payment, and a business may allege pre-existing damage in order to keep money or a passport. ${OPERATOR_NAME} warns against surrendering original identity documents but has NO involvement in, control over, or liability for any deposit, any document you hand over, or any damage dispute. Any deposit you pay and any document you surrender is entirely at your own risk.`,
  },
  {
    anchor: "payments-and-currency",
    n: "16",
    title: "Payment failures and currency conversion",
    summary: "Payment providers can fail or double-charge, and conversion rates are estimates.",
    body:
      `Subscription payments are handled by third-party payment providers. ${OPERATOR_NAME} is not liable for any failure, delay, decline, duplicate charge, chargeback, fraud or outage at a payment provider, nor for any fee that provider or your bank applies. All prices shown in a currency other than the one you are billed or quoted in are ESTIMATES produced by third-party exchange-rate data; the amount actually charged by a payment provider or demanded by a rental business may differ, and that difference is yours.`,
  },
];

export const TERMS_SECTIONS: LegalSection[] = [
  {
    n: "1",
    title: "What WheelDeal is",
    body:
      "WheelDeal is a discovery and communication tool that helps travellers find local vehicle rental businesses and exchange messages with them, with the help of automated AI agents. WheelDeal is NOT a rental company, broker, insurer, payment processor for rentals, or a party to any rental agreement. Every rental is strictly between you and the independent rental business.",
  },
  {
    n: "2",
    title: "Unofficial WhatsApp method & account-ban liability",
    body:
      `You acknowledge that when you link your WhatsApp number, the service operates through unofficial, reverse-engineered WhatsApp Web protocols (e.g. open-source libraries such as whatsapp-web.js/Baileys), BYPASSING the official Meta/WhatsApp Business API, which Meta's terms do not permit for automation. ${OPERATOR_NAME} has ZERO liability if Meta or WhatsApp limits, blocks, suspends or PERMANENTLY BANS your phone number or account for any reason. You assume 100% of this risk. ${OPERATOR_NAME} may enforce human-pace sending limits and block bot-like behaviour, but gives NO guarantee of any kind. A spare number is strongly recommended.`,
  },
  {
    n: "3",
    title: "AI hallucinations & automation risks",
    body:
      `The service uses large language models to read messages and reply on your behalf. AI output can be wrong, offensive, misleading, or contain false promises ('hallucinations'). The AI has NO legal agency and cannot bind ${OPERATOR_NAME}. ${OPERATOR_NAME} is not responsible for any AI error, and YOU are entirely and solely responsible for any contract, commitment, price, booking, message or damage caused by automated replies sent from your account. You must review anything sent on your behalf.`,
  },
  {
    n: "4",
    title: 'Service "as is"; third-party dependencies; no SLA; no refunds',
    body:
      `The service is provided strictly "AS IS" and "AS AVAILABLE", without warranties of any kind, express or implied. It relies on third-party LLM providers (e.g. OpenAI/Anthropic/Google and others) and on Meta's web protocols. If Meta changes its code and breaks the open-source library, or an LLM provider revokes or throttles access, the service may degrade or STOP INSTANTLY. There is no uptime commitment or service-level agreement. No refunds are provided for downtime, broken infrastructure, or any interruption.`,
  },
  {
    n: "5",
    title: "Data, third-party consent & prohibition on sensitive data",
    body:
      `You explicitly grant ${OPERATOR_NAME} permission to read, process, store and transmit your WhatsApp messages (including messages from your contacts within those threads) to third-party AI servers for processing. You warrant that you have the legal right to process the messages of your contacts and to send automated replies to them. STRICT PROHIBITION: you must NOT use the bot to process highly sensitive data, including medical/health information (HIPAA), payment-card data (PCI), or government identification numbers. To the maximum extent permitted by law, ${OPERATOR_NAME} is not liable for any data breach, leak or loss. See the Privacy Policy for details.`,
  },
  {
    n: "6",
    title: "Spam, harassment & illegal activity",
    body:
      `You take SOLE responsibility for complying with all applicable anti-spam, telecommunication, consumer-protection and privacy laws in every jurisdiction that applies to you and your contacts. The bot must NOT be used for mass-marketing spam, phishing, harassment, deception, or any illegal activity. ${OPERATOR_NAME} reserves the right to immediately suspend or terminate your account without notice and without refund for any actual or suspected abuse.`,
  },
  {
    n: "7",
    title: "Assumption of risk, waiver & release",
    body:
      `You knowingly and voluntarily assume all risks of every kind arising from your use of the service, any rental, any vehicle, any message, and any interaction with any business or third party. To the maximum extent permitted by law you fully and irrevocably RELEASE, WAIVE and DISCHARGE ${OPERATOR_NAME}, its owner, founders, operators, employees, contractors, agents, affiliates, successors and assigns (the "Released Parties") from any and all claims, demands, causes of action, damages, losses, liabilities, costs and expenses of any kind, whether known or unknown, now existing or hereafter arising.`,
  },
  {
    n: "8",
    title: "Total indemnification (hold harmless)",
    body:
      `You agree to fully INDEMNIFY, DEFEND and HOLD HARMLESS the Released Parties from and against any and all claims, lawsuits, investigations, fines, penalties, liabilities, damages, losses, costs and expenses (including reasonable legal fees) arising out of or connected with your use of the service, your messages, your rentals, your breach of these terms, or your violation of any law or any third party's rights - including, without limitation, any claim by Meta/WhatsApp, and any claim by a third party for privacy violations, spam, or automated messaging.`,
  },
  {
    n: "9",
    title: "Liability cap & class-action waiver",
    body:
      `To the maximum extent permitted by law, the total aggregate liability of the Released Parties for any and all claims arising out of or relating to the service is strictly CAPPED at the total amount you actually paid ${OPERATOR_NAME} for the service in the ONE (1) MONTH immediately preceding the event giving rise to the claim. In no event will the Released Parties be liable for any indirect, incidental, special, consequential, exemplary or punitive damages. You WAIVE any right to bring or participate in any class, collective or representative action against the Released Parties; all claims must be brought individually.`,
  },
  {
    n: "10",
    title: "No responsibility for rentals",
    body:
      "All rental agreements, payments, deposits, pricing, availability, vehicle condition, insurance, licensing and legal compliance are strictly between you and the rental business. Prices, deposits, ratings, distances and other details are provided by third parties or estimated by automated assistants and may be incomplete, outdated or wrong. Always confirm every detail directly with the rental business before paying or signing anything. The Released Parties accept no responsibility or liability whatsoever for any loss, damage, injury, death, theft, fraud, dispute, fine or expense arising from any rental or vehicle use.",
  },
  // The six named risks, spliced in so the full terms and the first-touch
  // modal are rendered from ONE list rather than two that drift.
  ...INDEMNITY_CLAUSES.map(({ n, title, body }) => ({ n, title, body })),
  {
    n: "17",
    title: "Governing law & exclusive jurisdiction",
    body:
      `These terms, and any dispute or claim arising out of or in connection with them or the service (including non-contractual disputes), are governed exclusively by the laws of ${GOVERNING_LAW}, without regard to conflict-of-law rules. Any dispute shall be resolved EXCLUSIVELY in ${JURISDICTION}, and you irrevocably submit to their exclusive jurisdiction.`,
  },
  {
    n: "18",
    title: "Changes, severability & survival",
    body:
      "These terms may be updated at any time; material changes require you to re-accept the latest version on your next sign-in. If any provision is held unenforceable, the remainder stays in full force. The releases, waivers, disclaimers, limitations, indemnities, the liability cap, the class-action waiver, and the governing-law and jurisdiction provisions survive termination indefinitely. BY CREATING AN ACCOUNT YOU CONFIRM YOU HAVE READ, UNDERSTOOD AND AGREED TO ALL OF THE FOREGOING.",
  },
];

// ---- Privacy Policy ------------------------------------------------------------

export const PRIVACY_SECTIONS: LegalSection[] = [
  {
    n: "1",
    title: "Who we are",
    body:
      `This Privacy Policy explains how ${OPERATOR_NAME} ("we") handles data in the WheelDeal service. It forms part of, and is governed by the same terms as, the Terms of Use - including the governing law of ${GOVERNING_LAW} and exclusive jurisdiction in ${JURISDICTION}.`,
  },
  {
    n: "2",
    title: "Data we collect",
    body:
      "Account details (email, phone number), your searches, your device location when you allow it (including any location you choose to share with a rental shop for pickup), the content of WhatsApp messages in the rental-shop threads you open through the app - which may include messages written by your contacts (the shops) - any images or voice notes exchanged in those threads, bookings, feedback, and technical/usage logs. " +
      "In addition, the messaging infrastructure that keeps your WhatsApp link alive holds a TRANSIENT copy of messages arriving on your linked number - including personal chats outside rental threads - in a dedicated, isolated database, solely so that a rental-shop reply lost in transit can be recovered; these copies are automatically deleted after at most 7 days, are never read, analysed or used for any other purpose, and never enter the app's own data store unless they belong to a rental-shop thread you opened.",
  },
  {
    n: "3",
    title: "How and why we process it (purposes and their legal bases)",
    body:
      "Each purpose has its own basis, and the optional ones have their own switch. " +
      "(a) OPERATING THE SERVICE - finding shops near you, letting the AI agents read shop replies and negotiate on your behalf, transcribing voice notes and reading photos, processing bookings: performance of our contract with you. Message content, images and voice notes are sent to third-party AI providers (large-language-model and speech/vision providers) for this processing. " +
      "(b) SAFETY AND ABUSE PREVENTION - rate limits, anti-ban pacing, blocking misuse: our legitimate interest in keeping the service and your WhatsApp number safe. " +
      "(c) QUALITY ASSURANCE - negotiation conversations and the agents' decision logs may be reviewed internally by the operator to fix and improve the AI agents' behaviour; they are never shared with other users: legitimate interest. " +
      "(d) PRODUCT ANALYTICS - a structured record of your funnel steps (search, contact, reply, booking stages): ONLY with your consent, off by default, and switchable off at any time in Profile -> Your data. Turning it off stops new collection immediately. " +
      "(e) MARKET INSIGHTS - your closed deals feeding anonymous, aggregated market statistics: ONLY with your consent, off by default, switchable at any time. See section 8 for exactly what this data looks like. " +
      "Location you share for pickup is sent to the specific shop only after you explicitly consent on that shop's card.",
  },
  {
    n: "4",
    title: "Third-party AI providers & sub-processors",
    body:
      "The service relies on independent third-party providers, including LLM providers (for reading and drafting messages), speech-to-text providers (for voice notes), vision providers (for reading photos), mapping providers (for locations), messaging infrastructure, and cloud database hosting (Supabase). These providers process data under their own terms, which are outside our control.",
  },
  {
    n: "5",
    title: "Your responsibilities & third-party consent",
    body:
      "You warrant that you have the legal right to process the messages of your contacts and to have them read and replied to by automated agents and third-party AI providers. You are STRICTLY PROHIBITED from submitting highly sensitive data through the bot, including medical/health information, payment-card data, and government identification numbers.",
  },
  {
    n: "6",
    title: "Storage, retention & deletion",
    body:
      "Data is stored on cloud infrastructure (Supabase). Retention is time-bounded and enforced by an automatic nightly prune: operational records (message-handling events, processing traces, risk events) are kept about 90 days; conversation context (negotiation threads, shop replies, sign-in history) about 180 days; your own visible history (searches and offers, which power the Trips screen) about 12 months. WhatsApp messages that recorded a price are DE-IDENTIFIED after about 180 days - the message text and the personal identifiers are removed while the pricing record is kept. Your bookings and the record of your consents are kept for the life of your account. " +
      "You do not have to contact anyone to exercise your rights: Profile -> Your data lets you DOWNLOAD everything we hold about you as one file, and DELETE your account - the deletion walks every table that keys you (conversations, threads, offers, consents, risk records, all of it), tells you honestly if any part could not be removed, and can be retried. Some minimal records may be retained where the law requires it.",
  },
  {
    n: "7",
    title: "Security & breach disclaimer",
    body:
      `We take reasonable measures to protect data, but no method of transmission or storage is fully secure, and the service is provided "AS IS". To the maximum extent permitted by law, ${OPERATOR_NAME} is not liable for any unauthorised access, breach, leak or loss of data.`,
  },
  {
    n: "8",
    title: "Personal data is not sold; anonymous market statistics",
    body:
      "We do NOT sell your personal data - not your messages, your number, your location, your searches, or anything that identifies you. Separately, and only if you switch on 'Market insights' in Profile -> Your data (it is off by default), the outcome of your closed deals may feed ANONYMOUS market statistics: the region, the vehicle type, the price achieved and the negotiation approach - never your name, email, number, or the shop's identity - and only ever published in groups of at least 20 deals, so no individual outcome is recoverable. Deals closed while the switch is off never enter these statistics, and switching off stops new deals entering them. " +
      "This Privacy Policy may be updated; material changes require re-acceptance on your next sign-in.",
  },
];

// ---- The operator's real name --------------------------------------------------
//
// `OPERATOR_NAME` is a placeholder ("the Operator") with a TODO on it, and it is
// baked into every clause above by template interpolation - so registering an
// actual legal entity meant a code change and a redeploy, which is exactly the
// class of key the Key Vault exists to remove. It is the one value in this file
// that identifies WHO is protected by it, which makes it the one value that most
// needs to be right at the moment it matters.
//
// It resolves like every other owner-settable value: Key Vault first, then the
// placeholder. Substitution happens at RENDER time rather than by rebuilding the
// clause bodies, so there is still exactly one copy of the legal text.

/** Escape a literal for use inside a RegExp. */
function escapeRx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rewrite the placeholder to the configured legal entity.
 *
 * Returns the SAME array when there is nothing to change, so a page that has no
 * configured name pays nothing and renders the exact reviewed text.
 */
/**
 * The same substitution, for ONE already-resolved string.
 *
 * TRANSLATE FIRST, SUBSTITUTE SECOND - and the order is the whole reason this
 * exists. `withOperator` rewrites the array before render, which means a
 * deployment with a custom operator name produces clause text that is not the
 * canonical string, so it is not in the i18n catalogue, so `t()` refuses it and
 * the clause ships in English. Translating the CANONICAL text and substituting
 * into the result keeps the catalogue to one fixed set of strings whatever the
 * operator is called.
 *
 * A brand name is a proper noun and normally survives translation verbatim; if
 * a particular language does render it differently the substitution simply does
 * not match and the canonical name shows - which is exactly today's behaviour
 * for the default operator, so the failure direction is unchanged.
 */
export function withOperatorText(text: string, operator?: string | null): string {
  const name = String(operator ?? "").trim();
  if (!name || name === OPERATOR_NAME) return text;
  return text.replace(new RegExp(escapeRx(OPERATOR_NAME), "g"), name);
}

export function withOperator<T extends { title: string; body: string }>(
  sections: T[],
  operator?: string | null
): T[] {
  const name = String(operator ?? "").trim();
  if (!name || name === OPERATOR_NAME) return sections;
  const rx = new RegExp(escapeRx(OPERATOR_NAME), "g");
  return sections.map((s) => ({
    ...s,
    title: s.title.replace(rx, name),
    body: s.body.replace(rx, name),
    ...("summary" in s && typeof (s as { summary?: unknown }).summary === "string"
      ? { summary: (s as unknown as { summary: string }).summary.replace(rx, name) }
      : {}),
  }));
}
