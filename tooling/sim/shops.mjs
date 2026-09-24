// THE SIMULATED RENTAL SHOPS - dev only, never imported by the app.
//
// A persona is a real little business: it has an opening price it hopes for, a
// floor it will not cross, a language, a currency, a way of writing numbers and
// a temper. The ECONOMICS are deterministic (so a test can assert "shop 7 will
// never go below 65,000") while the WORDING is generated - by a local LLM when
// one is reachable, otherwise from templates. That split is deliberate: the app
// under test must face messy, human, multilingual text, but the numbers behind
// it have to be knowable or nothing can be verified.
//
// Nothing here talks to WhatsApp. evolution-sim.mjs owns the wire.

import { createHash } from "node:crypto";

/** Per-market truth, from the business plan's published rate-card research. */
const MARKETS = {
  bali: {
    currency: "IDR",
    dayRate: 70000, // 125cc scooter, per day
    carDayRate: 330000,
    languages: ["id", "id", "id", "en"],
    prefix: "62",
    styles: ["bare", "k", "grouped", "words"],
  },
  thailand: {
    currency: "THB",
    dayRate: 150,
    carDayRate: 950,
    languages: ["th", "th", "en"],
    prefix: "66",
    styles: ["bare", "words", "grouped"],
  },
  philippines: {
    currency: "PHP",
    dayRate: 400,
    carDayRate: 1500,
    languages: ["tl", "en", "en"],
    prefix: "63",
    styles: ["bare", "words"],
  },
  vietnam: {
    currency: "VND",
    dayRate: 130000,
    carDayRate: 700000,
    languages: ["vi", "vi", "en"],
    prefix: "84",
    styles: ["k", "grouped", "bare"],
  },
  goa: {
    currency: "INR",
    dayRate: 300,
    carDayRate: 1200,
    languages: ["en", "en", "hi"],
    prefix: "91",
    styles: ["bare", "words"],
  },
};

const SHOP_NAMES = [
  "Wayan Rental", "Bali Moto Bro", "Kadek Scooter", "Ubud Wheels", "Canggu Ride Co",
  "Made Transport", "Sunset Motorbike", "Putu Rent", "Island Wheels", "Green Scooter",
  "Komang Rental", "Batu Bolong Bikes", "Ketut Motors", "Deluxe Ride Bali", "Nyoman Hire",
  "Echo Beach Rent", "Berawa Wheels", "Pererenan Moto", "Seminyak Scoot", "Uluwatu Rides",
  "Gusti Rental", "Denpasar Motor", "Legian Bikes", "Kuta Quick Rent", "Sanur Cycle",
  "Tibubeneng Moto", "Pecatu Wheels", "Jimbaran Rent", "Nusa Dua Motors", "Amed Scooters",
  "Lovina Rental", "Munduk Moto", "Sidemen Wheels", "Tegallalang Ride", "Payangan Motors",
  "Kerobokan Rent", "Umalas Wheels", "Babakan Moto", "Cemagi Rental", "Seseh Scooters",
];

/** A stable 0..1 from a string - the whole persona is derived from it. */
function hashUnit(seed, salt = "") {
  const h = createHash("sha256").update(`${salt}:${seed}`).digest();
  return ((h[0] << 16) | (h[1] << 8) | h[2]) / 0xffffff;
}

function pickFrom(list, seed, salt) {
  return list[Math.floor(hashUnit(seed, salt) * list.length) % list.length];
}

/**
 * Round a price the way a shop would say it: never 68,431 - always 70,000 or
 * 65,000. The step scales with the currency's magnitude.
 */
function roundPrice(value, currency) {
  const step = currency === "IDR" || currency === "VND" ? 5000 : currency === "PHP" ? 25 : 10;
  return Math.max(step, Math.round(value / step) * step);
}

/**
 * Every persona derives from its phone number, so the same shop behaves the
 * same way across restarts and a failing case can be reproduced by number.
 */
export function personaFor(digits, opts = {}) {
  const market = MARKETS[opts.market] ?? MARKETS.bali;
  const seed = String(digits);
  const idx = Math.floor(hashUnit(seed, "name") * SHOP_NAMES.length);

  // One shop in eight quotes in USD instead of the local money - the currency
  // guard has to face that, or it is never tested.
  const foreignCurrency = hashUnit(seed, "fx") < 0.12;
  const currency = foreignCurrency ? "USD" : market.currency;
  const baseDay = foreignCurrency
    ? Math.max(4, Math.round((market.dayRate / usdRate(market.currency)) * 10) / 10)
    : market.dayRate;

  // The tourist markup the plan documents: 20-90% above the local band.
  const markup = 1.2 + hashUnit(seed, "markup") * 0.7;
  // The floor a shop genuinely will not cross: 0.85-1.05 of the local band.
  const floorMult = 0.85 + hashUnit(seed, "floor") * 0.2;

  const opening = roundPrice(baseDay * markup, currency);
  const floor = roundPrice(baseDay * floorMult, currency);

  const temperament = hashUnit(seed, "temper");
  return {
    id: `shop-${String(digits).slice(-4)}`,
    digits: String(digits),
    name: SHOP_NAMES[idx],
    market: opts.market ?? "bali",
    language: pickFrom(market.languages, seed, "lang"),
    currency,
    /** What it asks for first. */
    opening,
    /** What it will never go below, whatever we say. */
    floor: Math.min(floor, opening),
    /** How it writes numbers: 70000 / 70k / 70.000 / "seventy thousand rupiah". */
    numberStyle: pickFrom(market.styles, seed, "style"),
    /** 0 = folds immediately, 1 = barely moves. */
    stubbornness: temperament,
    /** Seconds before it answers. Some shops are instant, some are slow. */
    replyDelayMs: Math.round(1500 + hashUnit(seed, "delay") * 12000),
    /** Answers in a burst of separate messages, like real shops do. */
    burst: hashUnit(seed, "burst") < 0.35,
    /** Sends a photo of the price board instead of typing the price. */
    sendsBoard: hashUnit(seed, "board") < 0.15,
    /** Sends a voice note. */
    sendsVoice: hashUnit(seed, "voice") < 0.1,
    /** Never answers at all - every fleet has them. */
    silent: hashUnit(seed, "silent") < 0.12,
    /** Quotes a weekly package rather than a daily rate. */
    quotesWeekly: hashUnit(seed, "weekly") < 0.18,
    /** Claims the vehicle is gone. */
    outOfStock: hashUnit(seed, "stock") < 0.08,
    /** Asks a question before quoting anything. */
    asksFirst: hashUnit(seed, "asks") < 0.25,
  };
}

function usdRate(currency) {
  return { IDR: 16500, THB: 34, PHP: 57, VND: 26000, INR: 87 }[currency] ?? 1;
}

/** How this shop writes a number in a message. */
export function writeAmount(persona, amount) {
  const { currency, numberStyle } = persona;
  const big = currency === "IDR" || currency === "VND";
  if (currency === "USD") return `$${amount}`;
  switch (numberStyle) {
    case "k":
      return big ? `${Math.round(amount / 1000)}k` : `${amount}`;
    case "grouped":
      return big
        ? amount.toLocaleString("de-DE") // 70.000 - the dot grouping shops use
        : amount.toLocaleString("en-US");
    case "words":
      return `${currency} ${amount.toLocaleString("en-US")}`;
    default:
      return String(amount);
  }
}

/**
 * THE SHOP'S DECISION - deterministic, and the reason this simulator can be
 * used as a test oracle.
 *
 * `thread.rounds` counts how many times we have pushed. A shop concedes a
 * shrinking slice of the gap between its current ask and its floor, and never
 * crosses the floor. A cheaper competitor's price mentioned in our message
 * (`rivalPrice`) makes a flexible shop jump most of the way, a stubborn one
 * refuse - which is exactly the behaviour the leverage feature is meant to earn.
 */
export function decide(persona, thread, incoming = {}) {
  const rounds = thread.rounds ?? 0;
  const current = thread.lastQuote ?? persona.opening;

  if (rounds === 0) {
    if (persona.outOfStock) return { action: "unavailable" };
    if (persona.asksFirst && !thread.answeredQuestion)
      return { action: "question" };
    return {
      action: "quote",
      price: persona.opening,
      weekly: persona.quotesWeekly ? persona.opening * 6 : undefined,
    };
  }

  const rival = Number(incoming.rivalPrice) || 0;
  const gap = current - persona.floor;
  if (gap <= 0) return { action: "hold", price: persona.floor };

  // A named, credible competitor price is worth far more than another polite ask.
  if (rival > 0) {
    if (rival >= persona.floor) {
      // It can be beaten, and a flexible shop beats it rather than matching.
      const beat = roundPrice(Math.max(persona.floor, rival * 0.97), persona.currency);
      if (persona.stubbornness < 0.75) return { action: "beat", price: beat };
    }
    // Below the floor: refuse honestly, but often shave something off.
    if (persona.stubbornness < 0.5)
      return { action: "counter", price: roundPrice(persona.floor, persona.currency) };
    return { action: "hold", price: current, reason: "rival-below-floor" };
  }

  // No rival: concede a shrinking slice - 35% of the remaining gap, damped by
  // stubbornness, and stop moving after four rounds.
  if (rounds >= 4) return { action: "hold", price: current };
  const concession = gap * 0.35 * (1 - persona.stubbornness * 0.6);
  const next = roundPrice(Math.max(persona.floor, current - concession), persona.currency);
  if (next >= current) return { action: "hold", price: current };
  return { action: "counter", price: next };
}

/** Did our outbound cite a competitor's number? The shop reads it like a human. */
export function readRivalPrice(text) {
  const numbers = String(text ?? "")
    .replace(/[.,](?=\d{3}\b)/g, "")
    .match(/\d[\d]{1,8}/g);
  if (!numbers) return 0;
  const mentionsRival = /another shop|other shop|competitor|down the road|nearby shop|quoted|offered/i.test(
    String(text ?? "")
  );
  if (!mentionsRival) return 0;
  return Math.max(...numbers.map(Number).filter((n) => n > 10));
}

// ---------------------------------------------------------------------------
// WORDING
// ---------------------------------------------------------------------------

const TEMPLATES = {
  en: {
    question: ["Hello! For how many days? And automatic or manual?", "Hi, which dates you need?"],
    quote: ["Hello! Yes available. {price} per day.", "Hi! We have it. Price is {price}/day."],
    weekly: ["Hello, we do {weekly} for the week, {price} per day if short."],
    counter: ["Ok friend, I can do {price} per day. Last price.", "For you {price}/day ok?"],
    beat: ["Ok ok, I give you {price} per day. Better than them. Deal?"],
    hold: ["Sorry, {price} is already my best price.", "Cannot go lower, {price} final."],
    unavailable: ["Sorry, all scooters rented this week.", "Not available now, sorry."],
  },
  id: {
    question: ["Halo kak, untuk berapa hari ya? Matic atau manual?", "Hai, tanggal berapa kak?"],
    quote: ["Halo kak, ada. Harganya {price} per hari ya.", "Siap kak, {price} sehari."],
    weekly: ["Kalau seminggu {weekly} kak, harian {price}."],
    counter: ["Bisa kak {price} per hari, sudah paling murah.", "Ok {price} aja ya kak."],
    beat: ["Oke kak, saya kasih {price} per hari. Lebih murah dari sana. Deal ya?"],
    hold: ["Maaf kak, {price} sudah harga terbaik.", "Tidak bisa turun lagi kak, {price} final."],
    unavailable: ["Maaf kak, motor sudah habis disewa minggu ini."],
  },
  th: {
    question: ["สวัสดีค่ะ กี่วันคะ?", "สวัสดีครับ ต้องการวันไหนครับ"],
    quote: ["สวัสดีค่ะ มีค่ะ วันละ {price} ค่ะ", "มีครับ ราคา {price} ต่อวันครับ"],
    weekly: ["อาทิตย์ละ {weekly} ค่ะ รายวัน {price} ค่ะ"],
    counter: ["ลดให้เป็น {price} ต่อวันนะคะ", "{price} ได้ค่ะ ราคาสุดท้าย"],
    beat: ["โอเคค่ะ {price} ต่อวัน ถูกกว่าร้านนั้นค่ะ"],
    hold: ["ขอโทษค่ะ {price} ถูกที่สุดแล้วค่ะ"],
    unavailable: ["ขอโทษค่ะ รถเต็มหมดแล้วค่ะ"],
  },
  vi: {
    question: ["Chào bạn, thuê mấy ngày ạ?", "Bạn cần ngày nào ạ?"],
    quote: ["Chào bạn, còn xe. Giá {price} một ngày nhé.", "Có xe bạn ơi, {price}/ngày."],
    weekly: ["Thuê tuần {weekly} nhé, ngày {price}."],
    counter: ["Mình bớt còn {price} một ngày nhé.", "{price} nhé bạn, giá cuối."],
    beat: ["Ok bạn, {price} một ngày, rẻ hơn bên kia."],
    hold: ["Xin lỗi, {price} là giá tốt nhất rồi ạ."],
    unavailable: ["Xin lỗi, hết xe rồi ạ."],
  },
  tl: {
    question: ["Hello po, ilang araw po?", "Kailan po kailangan?"],
    quote: ["Hello po, available. {price} per day po.", "Meron po, {price} kada araw."],
    weekly: ["{weekly} po per week, {price} kung daily."],
    counter: ["Sige po, {price} na lang per day.", "Pwede {price} po, last price na."],
    beat: ["Sige po, {price} per day. Mas mura pa sa kanila."],
    hold: ["Pasensya po, {price} na po talaga ang best price."],
    unavailable: ["Pasensya po, wala na pong available."],
  },
  hi: {
    question: ["Namaste, kitne din ke liye chahiye?", "Kaunsi date chahiye aapko?"],
    quote: ["Namaste, available hai. {price} per day.", "Ji haan, {price} roz ka."],
    weekly: ["Week ka {weekly}, daily {price}."],
    counter: ["Theek hai, {price} per day kar dete hain.", "{price} final hai ji."],
    beat: ["Ok sir, {price} per day. Unse sasta."],
    hold: ["Sorry ji, {price} hi best price hai."],
    unavailable: ["Sorry, abhi koi gaadi available nahi hai."],
  },
};

function template(persona, action, vars) {
  const pack = TEMPLATES[persona.language] ?? TEMPLATES.en;
  const key = action === "weekly" ? "weekly" : action;
  const list = pack[key] ?? pack.quote ?? TEMPLATES.en.quote;
  const pick = list[Math.floor(hashUnit(persona.digits + (vars.price ?? 0), action) * list.length) % list.length];
  return pick
    .replace("{price}", vars.price ?? "")
    .replace("{weekly}", vars.weekly ?? "");
}

/**
 * Ask the local model to say the same thing in this shop's own voice. Falls
 * back to the template on any failure - the simulator must never be the reason
 * a dev session stalls.
 */
async function llmPhrase(persona, action, vars, opts) {
  const url = opts.ollamaUrl;
  if (!url) return null;
  const langName = {
    en: "English", id: "Indonesian", th: "Thai", vi: "Vietnamese", tl: "Tagalog", hi: "Hinglish",
  }[persona.language] ?? "English";
  const priceText = vars.price != null ? writeAmount(persona, vars.price) : "";
  const intent = {
    question: "ask which dates and whether automatic or manual, do not give a price yet",
    quote: `say the vehicle is available and quote ${priceText} per day`,
    weekly: `quote ${vars.weekly ? writeAmount(persona, vars.weekly) : ""} for a week and ${priceText} per day`,
    counter: `offer a lower price of ${priceText} per day and say it is nearly your last price`,
    beat: `agree to beat the competitor and offer ${priceText} per day`,
    hold: `politely refuse to go lower and repeat ${priceText} as the final price`,
    unavailable: "say the vehicle is not available right now",
  }[action];

  const body = {
    model: opts.model,
    stream: false,
    think: false,
    options: { temperature: 0.9, num_predict: 90 },
    messages: [
      {
        role: "system",
        content:
          `You are ${persona.name}, a small scooter and car rental shop. You reply to customers on WhatsApp in ${langName}. ` +
          `Write ONE short message (under 20 words), casual, lowercase where natural, typos allowed, no markdown, no quotes around it. ` +
          `Never mention that you are an AI. Prices are in ${persona.currency}. Write the number exactly as: ${priceText || "n/a"}.`,
      },
      { role: "user", content: `Write your next WhatsApp message. Intent: ${intent}.` },
    ],
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20000);
  try {
    const res = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    const text = String(json?.message?.content ?? "").trim().replace(/^["']|["']$/g, "");
    if (!text || text.length > 300) return null;
    // The model sometimes loses the exact number; the number is the one thing
    // that must survive, so reject a phrasing that dropped it.
    if (priceText && !text.includes(String(vars.price)) && !text.includes(priceText)) return null;
    return text;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The messages this shop sends for a decision (one, or a burst of several). */
export async function compose(persona, decision, opts = {}) {
  const priceText = decision.price != null ? writeAmount(persona, decision.price) : "";
  const weeklyText = decision.weekly != null ? writeAmount(persona, decision.weekly) : "";
  const action = decision.weekly ? "weekly" : decision.action;

  let text =
    (opts.useLlm ? await llmPhrase(persona, action, { price: decision.price, weekly: decision.weekly }, opts) : null) ??
    template(persona, action, { price: priceText, weekly: weeklyText });

  const out = [];
  if (persona.burst && decision.action === "quote") {
    // A real shop's first answer often arrives as three separate messages.
    out.push({ text: greeting(persona) });
    out.push({ text: availability(persona) });
    out.push({ text });
  } else {
    out.push({ text });
  }
  if (persona.sendsBoard && decision.action === "quote") {
    out.push({ media: "image", caption: "", text: "" });
  }
  if (persona.sendsVoice && decision.action === "counter") {
    out.push({ media: "audio", text: "" });
  }
  return out;
}

function greeting(persona) {
  return { en: "Hello!", id: "Halo kak 🙏", th: "สวัสดีค่ะ", vi: "Chào bạn", tl: "Hello po!", hi: "Namaste ji" }[
    persona.language
  ] ?? "Hello!";
}

function availability(persona) {
  return {
    en: "Yes we have automatic scooter available",
    id: "Ada kak motor matic siap pakai",
    th: "มีรถออโต้ว่างค่ะ",
    vi: "Bên mình còn xe tay ga",
    tl: "Meron po kaming automatic",
    hi: "Automatic scooty available hai",
  }[persona.language] ?? "Yes we have automatic scooter available";
}

export const MARKET_NAMES = Object.keys(MARKETS);
