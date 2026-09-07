// Voice-note transcription - the locals have very heavy accents, so this is
// primed hard for accuracy on prices and rental vocabulary.
//
//   Groq whisper-large-v3 (NOT -turbo: strongest on accents) via multipart,
//   temperature 0, verbose_json (detected language), an accent-primer prompt,
//   and a language hint ONLY when the thread is local-language (shops code-
//   switch - auto-detect otherwise).
//     -> Gemini audio (inline_data through chatVision) fallback
//       -> null (the engine then sends a polite "could you type it?" clarify)

import "server-only";
import { getConfig } from "../runtime-config";
import { chatVision } from "../ai";
import { recordApi } from "../usage";

export interface Transcription {
  text: string;
  language?: string;
  source: "groq" | "gemini";
}

// Region -> local language name + ISO-639-1 code. Reuses the country-string
// style of locale.ts / REGION_CURRENCY (kept local to avoid coupling).
const REGION_LANG: [RegExp, { name: string; iso: string }][] = [
  [/\bthai|\bthailand/i, { name: "Thai", iso: "th" }],
  [/\bindonesia|\bbali|\bjakarta|\blombok/i, { name: "Indonesian", iso: "id" }],
  [/\bvietnam|\bhanoi|\bsaigon|\bda ?nang/i, { name: "Vietnamese", iso: "vi" }],
  [/\bcambodia|\bphnom|\bsiem reap/i, { name: "Khmer", iso: "km" }],
  [/\bphilippin|\bmanila|\bcebu/i, { name: "Filipino", iso: "tl" }],
  [/\bmalaysia|\bkuala|\blangkawi/i, { name: "Malay", iso: "ms" }],
  [/\bindia\b|\bgoa\b/i, { name: "Hindi", iso: "hi" }],
  [/\bsri lanka|\bcolombo/i, { name: "Sinhala", iso: "si" }],
  [/\bnepal|\bkathmandu/i, { name: "Nepali", iso: "ne" }],
  [/\bmexico|\bspain|\bcolombia|\bperu|\bargentin|\bchile/i, { name: "Spanish", iso: "es" }],
  [/\bbrazil|\bbrasil|\bportugal/i, { name: "Portuguese", iso: "pt" }],
  [/\bmorocco|\begypt|\bdubai|\bemirates|\bsaudi/i, { name: "Arabic", iso: "ar" }],
  [/\bturkey|\btürkiye/i, { name: "Turkish", iso: "tr" }],
];

function langFor(region?: string): { name: string; iso: string } | null {
  if (!region) return null;
  for (const [rx, v] of REGION_LANG) if (rx.test(region)) return v;
  return null;
}

/** <= 224-token domain primer - the single biggest accuracy lever for accents. */
export function accentPrimerFor(region?: string): string {
  const lang = langFor(region);
  const place = region ? region.split(",").slice(-2).join(",").trim() : "Southeast Asia";
  const accent = lang ? `${lang.name}-accented English, may mix ${lang.name} words` : "heavily accented English";
  return (
    `WhatsApp voice note from a vehicle rental shop in ${place}. ${accent}, casual and fast. ` +
    `Vocabulary: scooter, motorbike, cc, per day, baht, rupiah, dong, peso, deposit, passport, ` +
    `helmet, delivery, pickup, insurance, mileage, kilometre. Numbers and prices matter most - ` +
    `transcribe every digit exactly.`
  );
}

export const TRANSCRIBE_SYSTEM =
  "Transcribe this vehicle-rental voice note from a shop owner EXACTLY, word for word. " +
  "The speaker has a heavy local accent and speaks fast, casual English possibly mixed with " +
  "local words. Prices and numbers are the most important - get every digit right. " +
  "Output ONLY the transcription text, nothing else.";

/**
 * GROQ IS TWO BILLED PRODUCTS BEHIND ONE KEY, AND ONLY ONE OF THEM WAS EVER
 * TESTED (Wave 7).
 *
 * `GROQ_TOKEN` buys chat completions AND audio transcription. Admin -> Keys
 * pressed "Test API" on the token and exercised `chat/completions` only, so a
 * working chat key and a dead voice-note path reported the same green chip -
 * and voice notes are how a lot of shops answer.
 *
 * The model id gets the same escape hatch every text model already had. A
 * provider retiring an audio id is the identical failure the vision ladder was
 * given `*_VISION_MODEL` for, and until now it needed a redeploy.
 */
export const DEFAULT_WHISPER_MODEL = "whisper-large-v3"; // NOT -turbo: strongest on accents

export async function whisperModel(): Promise<string> {
  return ((await getConfig("GROQ_WHISPER_MODEL")) ?? "").trim() || DEFAULT_WHISPER_MODEL;
}

/**
 * THE 20s WHISPER BUDGET SPANS HEADERS **AND** BODY (audit M20).
 *
 * `clearTimeout` used to run the moment `await fetch(...)` resolved, which is
 * the header boundary - and the caller then does `await res.json()` on the same
 * controller. A transcription endpoint that flushed 200 headers and then went
 * quiet therefore ran on undici's ~300s default bodyTimeout instead of this
 * budget, holding the inbound turn (and the reply-tick invocation behind it)
 * open until the platform killed it. Same rule, same shape, same words as
 * runtime-config's `timedFetch`; `unref()` so a pending timer never keeps the
 * runtime alive, and once the body is read the abort is a no-op.
 */
async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  (t as { unref?: () => void }).unref?.();
  return fetch(url, { ...init, signal: controller.signal });
}

export async function transcribeAudio(opts: {
  mime: string;
  base64: string;
  region?: string;
  localLang?: boolean;
}): Promise<Transcription | null> {
  const token = await getConfig("GROQ_TOKEN");
  // WHISPER DAILY-CAP METERING (owner report 4, scale #5). Groq Whisper's free
  // tier is a GLOBAL ~2k requests/day shared across the whole fleet; past 80%
  // we skip Groq entirely and let Gemini audio carry the transcription, so the
  // scarce rung is not burned out by mid-afternoon. A meter read that fails is
  // treated as "under cap" - never let a metering blip disable transcription.
  const { whisperOverSoftCap } = await import("../usage");
  const groqBudgetLeft = !(await whisperOverSoftCap().catch(() => false));
  if (token && groqBudgetLeft) {
    // ONE CLASSIFIED RETRY BEFORE FALLING TO GEMINI (owner report 4). Whisper
    // large-v3 is the strongest model on heavy accents - the whole reason it
    // is first - and any failure used to fall straight through to Gemini
    // audio, which is measurably weaker on exactly the notes this pipeline is
    // primed for. A 429 or a timeout is a statement about this minute, not
    // about the audio (RETRYABLE_VISION is the same policy the image ladder
    // uses); a rejected key or a bad request cannot succeed twice and goes to
    // Gemini immediately.
    const attemptGroq = async (): Promise<Transcription | "retryable" | null> => {
      try {
        const bytes = Buffer.from(opts.base64, "base64");
        const fd = new FormData();
        const ext = opts.mime.includes("ogg")
          ? "ogg"
          : opts.mime.includes("mp4") || opts.mime.includes("m4a")
          ? "m4a"
          : opts.mime.includes("mpeg") || opts.mime.includes("mp3")
          ? "mp3"
          : opts.mime.includes("wav")
          ? "wav"
          : "ogg";
        fd.append(
          "file",
          new Blob([bytes], { type: opts.mime || "audio/ogg" }),
          `note.${ext}`
        );
        fd.append("model", await whisperModel());
        fd.append("temperature", "0");
        fd.append("response_format", "verbose_json");
        const lang = opts.localLang ? langFor(opts.region) : null;
        if (lang) fd.append("language", lang.iso); // hint only when confident
        fd.append("prompt", accentPrimerFor(opts.region));
        const res = await fetchWithTimeout(
          "https://api.groq.com/openai/v1/audio/transcriptions",
          { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd },
          20_000
        );
        await recordApi("groq_whisper").catch(() => {});
        if (res.ok) {
          const data = (await res.json()) as { text?: string; language?: string };
          const text = (data.text ?? "").trim();
          if (text) return { text, language: data.language, source: "groq" };
          return null; // a clean empty transcription is an answer, not an outage
        }
        const { visionFailureFromStatus, RETRYABLE_VISION } = await import("../vision-read");
        return RETRYABLE_VISION.has(visionFailureFromStatus(res.status)) ? "retryable" : null;
      } catch (e) {
        const { visionFailureFromThrown, RETRYABLE_VISION } = await import("../vision-read");
        return RETRYABLE_VISION.has(visionFailureFromThrown(e)) ? "retryable" : null;
      }
    };
    const first = await attemptGroq();
    if (first && first !== "retryable") return first;
    if (first === "retryable") {
      await new Promise((r) => setTimeout(r, 1_500));
      const second = await attemptGroq();
      if (second && second !== "retryable") return second;
    }
  }

  // Gemini audio through the existing inline_data path (chatVision accepts any
  // mime; audio mimes are valid inline_data for Gemini).
  try {
    const out = await chatVision(
      TRANSCRIBE_SYSTEM + " " + accentPrimerFor(opts.region),
      "Transcribe this voice note exactly.",
      [{ mime: opts.mime || "audio/ogg", base64: opts.base64 }]
    );
    const text = (out ?? "").trim();
    if (text) return { text, source: "gemini" };
  } catch {
    /* no transcription available */
  }
  return null;
}
