// Currency catalogue. Pricing is anchored in ILS (matches the PayPal billing
// plans exactly); everything else is a display conversion. USD is the
// professional default. A hidden 0.2% is applied to non-ILS conversions.

export interface Currency {
  code: string;
  symbol: string;
  flag: string;
  perIls: number; // 1 ILS = perIls units of this currency (approximate)
}

export const CURRENCIES: Currency[] = [
  { code: "USD", symbol: "$", flag: "🇺🇸", perIls: 0.27 },
  { code: "ILS", symbol: "₪", flag: "🇮🇱", perIls: 1 },
  { code: "EUR", symbol: "€", flag: "🇪🇺", perIls: 0.25 },
  { code: "GBP", symbol: "£", flag: "🇬🇧", perIls: 0.21 },
  { code: "AUD", symbol: "A$", flag: "🇦🇺", perIls: 0.41 },
  { code: "CAD", symbol: "C$", flag: "🇨🇦", perIls: 0.37 },
  { code: "CHF", symbol: "CHF", flag: "🇨🇭", perIls: 0.24 },
  { code: "JPY", symbol: "¥", flag: "🇯🇵", perIls: 42 },
  { code: "CNY", symbol: "¥", flag: "🇨🇳", perIls: 1.95 },
  { code: "INR", symbol: "₹", flag: "🇮🇳", perIls: 23 },
  { code: "THB", symbol: "฿", flag: "🇹🇭", perIls: 9.7 },
  { code: "IDR", symbol: "Rp", flag: "🇮🇩", perIls: 4400 },
  { code: "VND", symbol: "₫", flag: "🇻🇳", perIls: 6900 },
  { code: "SGD", symbol: "S$", flag: "🇸🇬", perIls: 0.36 },
  { code: "AED", symbol: "د.إ", flag: "🇦🇪", perIls: 0.99 },
  { code: "TRY", symbol: "₺", flag: "🇹🇷", perIls: 9.2 },
  { code: "MXN", symbol: "$", flag: "🇲🇽", perIls: 5.1 },
  { code: "BRL", symbol: "R$", flag: "🇧🇷", perIls: 1.5 },
  { code: "ZAR", symbol: "R", flag: "🇿🇦", perIls: 5.0 },
  { code: "RUB", symbol: "₽", flag: "🇷🇺", perIls: 25 },
  { code: "PLN", symbol: "zł", flag: "🇵🇱", perIls: 1.08 },
  { code: "PHP", symbol: "₱", flag: "🇵🇭", perIls: 15.5 },
  { code: "MYR", symbol: "RM", flag: "🇲🇾", perIls: 1.24 },
  { code: "NZD", symbol: "NZ$", flag: "🇳🇿", perIls: 0.45 },
  { code: "HKD", symbol: "HK$", flag: "🇭🇰", perIls: 2.1 },
  { code: "TWD", symbol: "NT$", flag: "🇹🇼", perIls: 8.7 },
  { code: "KRW", symbol: "₩", flag: "🇰🇷", perIls: 370 },
  { code: "SAR", symbol: "﷼", flag: "🇸🇦", perIls: 1.01 },
  { code: "MAD", symbol: "DH", flag: "🇲🇦", perIls: 2.7 },
  { code: "EGP", symbol: "E£", flag: "🇪🇬", perIls: 13.3 },
  { code: "LKR", symbol: "Rs", flag: "🇱🇰", perIls: 82 },
  { code: "NPR", symbol: "Rs", flag: "🇳🇵", perIls: 37 },
  { code: "CZK", symbol: "Kč", flag: "🇨🇿", perIls: 6.2 },
  { code: "HUF", symbol: "Ft", flag: "🇭🇺", perIls: 98 },
  { code: "SEK", symbol: "kr", flag: "🇸🇪", perIls: 2.9 },
  { code: "NOK", symbol: "kr", flag: "🇳🇴", perIls: 3.0 },
  { code: "DKK", symbol: "kr", flag: "🇩🇰", perIls: 1.9 },
];

export function currency(code: string): Currency {
  return CURRENCIES.find((c) => c.code === code) ?? CURRENCIES[0];
}

// Deterministic thousands grouping, DECOUPLED from the device locale. The old
// `Math.round(n).toLocaleString()` (no locale arg) followed the phone's
// settings, so the same shop price rendered "1,234" on a US phone and "1.234"
// on a German one - a global-consistency bug. A fixed grouping is identical
// everywhere and universally readable.
function groupInt(n: number): string {
  try {
    return new Intl.NumberFormat("en-US").format(n);
  } catch {
    return String(n);
  }
}

/** Convert an ILS amount to a display string in the given currency. */
export function fromIls(ils: number, code: string): string {
  const c = currency(code);
  const adj = code === "ILS" ? 1 : 1.002; // silent 0.2% FX handling fee
  const n = ils * c.perIls * adj;
  const rounded =
    n >= 1000 ? groupInt(Math.round(n)) : n.toFixed(2).replace(/\.00$/, "");
  return c.symbol.length > 1 ? `${c.symbol} ${rounded}` : `${c.symbol}${rounded}`;
}

/**
 * Format an amount that is ALREADY in the shop's local currency (offers come
 * from vendor replies in their own money - never convert, never force "$").
 */
/** Just the symbol for a currency code ("THB" -> "฿", unknown -> "$"). */
export function currencySymbol(code?: string): string {
  return moneyLocal(0, code).replace(/[\d.,\s]/g, "") || "$";
}

export function moneyLocal(amount: number, code?: string): string {
  const c = CURRENCIES.find((x) => x.code === (code ?? "").toUpperCase());
  const n =
    amount >= 1000
      ? groupInt(Math.round(amount))
      : `${Math.round(amount * 100) / 100}`;
  if (!c) return code ? `${n} ${code.toUpperCase()}` : `$${n}`;
  return c.symbol.length > 1 ? `${c.symbol} ${n}` : `${c.symbol}${n}`;
}

// ---- Geo currency detection (item #6) --------------------------------------
// Country (ISO 3166-1 alpha-2) -> catalogue currency, for zero-permission
// detection from the device locale. Only codes present in CURRENCIES appear.
const COUNTRY_CURRENCY: Record<string, string> = {
  US: "USD", IL: "ILS", GB: "GBP", AU: "AUD", CA: "CAD", CH: "CHF", JP: "JPY",
  CN: "CNY", IN: "INR", TH: "THB", ID: "IDR", VN: "VND", SG: "SGD", AE: "AED",
  TR: "TRY", MX: "MXN", BR: "BRL", ZA: "ZAR", RU: "RUB", PL: "PLN", PH: "PHP",
  MY: "MYR", NZ: "NZD", HK: "HKD", TW: "TWD", KR: "KRW", SA: "SAR", MA: "MAD",
  EG: "EGP", LK: "LKR", NP: "NPR", CZ: "CZK", HU: "HUF", SE: "SEK", NO: "NOK",
  DK: "DKK",
  // Eurozone
  AT: "EUR", BE: "EUR", CY: "EUR", DE: "EUR", EE: "EUR", ES: "EUR", FI: "EUR",
  FR: "EUR", GR: "EUR", HR: "EUR", IE: "EUR", IT: "EUR", LT: "EUR", LU: "EUR",
  LV: "EUR", MT: "EUR", NL: "EUR", PT: "EUR", SI: "EUR", SK: "EUR",
};

// Timezone -> currency, for devices whose locale has no region ("en"). Small
// on purpose - the locale path covers most phones; this catches the rest.
const TZ_CURRENCY: Record<string, string> = {
  "Asia/Bangkok": "THB", "Asia/Jerusalem": "ILS", "Asia/Tel_Aviv": "ILS",
  "Asia/Jakarta": "IDR", "Asia/Makassar": "IDR", "Asia/Ho_Chi_Minh": "VND",
  "Asia/Saigon": "VND", "Asia/Manila": "PHP", "Asia/Kuala_Lumpur": "MYR",
  "Asia/Singapore": "SGD", "Asia/Tokyo": "JPY", "Asia/Seoul": "KRW",
  "Asia/Taipei": "TWD", "Asia/Hong_Kong": "HKD", "Asia/Kolkata": "INR",
  "Asia/Calcutta": "INR", "Asia/Colombo": "LKR", "Asia/Kathmandu": "NPR",
  "Asia/Dubai": "AED", "Asia/Riyadh": "SAR", "Asia/Shanghai": "CNY",
  "Europe/London": "GBP", "Europe/Istanbul": "TRY", "Europe/Moscow": "RUB",
  "Europe/Warsaw": "PLN", "Europe/Prague": "CZK", "Europe/Budapest": "HUF",
  "Europe/Stockholm": "SEK", "Europe/Oslo": "NOK", "Europe/Copenhagen": "DKK",
  "Europe/Zurich": "CHF", "Europe/Paris": "EUR", "Europe/Berlin": "EUR",
  "Europe/Madrid": "EUR", "Europe/Rome": "EUR", "Europe/Amsterdam": "EUR",
  "Europe/Brussels": "EUR", "Europe/Vienna": "EUR", "Europe/Lisbon": "EUR",
  "Europe/Dublin": "EUR", "Europe/Athens": "EUR", "Europe/Helsinki": "EUR",
  "Africa/Casablanca": "MAD", "Africa/Cairo": "EGP",
  "Africa/Johannesburg": "ZAR", "America/Mexico_City": "MXN",
  "America/Sao_Paulo": "BRL", "Pacific/Auckland": "NZD",
};

/**
 * Best-effort detection of the traveller's home currency from the device -
 * locale region first (e.g. "he-IL" -> ILS), then timezone. Never throws,
 * never asks for permissions; falls back to USD.
 */
export function detectCurrency(): string {
  try {
    if (typeof navigator !== "undefined") {
      const locales = [...(navigator.languages ?? []), navigator.language].filter(Boolean);
      for (const l of locales) {
        // Region subtag: 2 letters after a separator ("en-US", "zh-Hant-TW").
        const m = /[-_]([A-Za-z]{2})(?:[-_]|$)/.exec(l);
        const region = m?.[1]?.toUpperCase();
        if (region && COUNTRY_CURRENCY[region]) return COUNTRY_CURRENCY[region];
      }
    }
  } catch {}
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
    if (TZ_CURRENCY[tz]) return TZ_CURRENCY[tz];
    if (tz.startsWith("Australia/")) return "AUD";
  } catch {}
  return "USD";
}

/**
 * Rough conversion between two catalogue currencies (via the ILS anchor).
 * Display-only ("≈ ..."): null when either code is unknown or they match.
 */
export function convertApprox(amount: number, from?: string, to?: string): number | null {
  const f = CURRENCIES.find((c) => c.code === (from ?? "").toUpperCase());
  const t = CURRENCIES.find((c) => c.code === (to ?? "").toUpperCase());
  if (!f || !t || f.code === t.code) return null;
  return (amount / f.perIls) * t.perIls;
}

export function savedCurrency(): string {
  try {
    return localStorage.getItem("wd_currency") || detectCurrency();
  } catch {
    return "USD";
  }
}

export function setSavedCurrency(code: string) {
  try {
    localStorage.setItem("wd_currency", code);
  } catch {}
}
