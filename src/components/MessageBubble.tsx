"use client";

// ONE bubble, used by every transcript surface (ThreadDashboard's "Full
// conversation" and the TranscriptSheet). It used to be copy-pasted in both,
// which is why photos, voice notes and dropped pins rendered as the literal
// string "[photo]" in one place and were invisible in the other.
//
// A shop's price board IS the offer. A dropped pin IS the address. Showing the
// traveller a placeholder where the shop sent real information is the app
// lying about its own conversation - so every message type gets a real render
// here, and anything unrecognised still falls back to its text.

import { useState } from "react";
import { AgenticSummary } from "./AgenticSummary";
import { useI18n } from "@/lib/i18n";
import { WaText } from "./WaText";
import { orientationAttrValue } from "@/lib/media/orientation";

export interface ThreadMsg {
  id: string;
  dir: "in" | "out";
  text: string;
  english?: string;
  kind?: string;
  at: string;
  /**
   * Present when the shop sent a photo / voice note / document.
   *
   * `orientation` is the EXIF tag the ingest measured (lib/media/orientation).
   * Optional because the transcript API does not carry it yet - a missing value
   * means "not measured", and the CSS floor in globals.css still corrects the
   * common case. Wiring it through /api/thread is the remaining migration.
   */
  media?: {
    id: string;
    kind: string;
    fileName?: string | null;
    orientation?: import("@/lib/media/orientation").OrientationInfo;
  };
  /** What the agents read out of that media - the proof panel's data. */
  reading?: import("@/lib/media/reading").MediaReading;
  /** A dropped WhatsApp pin. */
  location?: { lat: number; lng: number; name?: string | null };
  /** A shared contact card. */
  contact?: { name?: string | null; digits?: string | null };
  /** A WhatsApp Business catalog card - render the card, never an empty bubble. */
  product?: {
    title: string;
    description?: string | null;
    currency?: string | null;
    price?: number | null;
  };
  /** What this message replied to ("^ This one is 125 cc" needs its referent). */
  quoted?: string;
  /**
   * The spoken words of a voice note.
   *
   * Stamped at ingest and selected by nobody: the traveller only ever saw it
   * because the BODY had been rewritten to "(voice note) <spoken>", so there
   * was no way to show what was HEARD as a distinct thing from what was typed.
   */
  transcript?: string;
  /**
   * THE SHOP FORWARDED THIS. A competitor's price board passed on is not this
   * shop quoting us, and the traveller is owed that distinction before they
   * read the number as this shop's own.
   */
  forwarded?: boolean;
  /**
   * WHAT THE AGENT UNDERSTOOD IN A TEXT-ONLY REPLY.
   *
   * `vendor_replies` has stored found / price_per_day / matches_spec /
   * confidence per reply since the schema shipped, and nothing joined it back
   * to a transcript row - so a photo got an understanding panel and the
   * sentence "300 baht per day, 3 days minimum" got nothing, even though the
   * app had read it, priced it and acted on it.
   */
  replyRead?: {
    found?: boolean;
    pricePerDay?: number;
    currency?: string;
    matchesSpec?: boolean;
    confidence?: string;
  };
}

/**
 * WHAT THE AGENT UNDERSTOOD IN A MESSAGE WITH NO PHOTO.
 *
 * A photo has had an "Agentic summary" panel under it since owner report 5.
 * The sentence "300 baht per day, 3 days minimum" - which the app read, priced
 * and acted on - had NOTHING, because the annotation gate required `m.media`.
 * Same evidence-not-assertion discipline as the photo panel: it prints the
 * stored facts and nothing else, and it renders at all only when facts exist.
 */
function TextRead({ read }: { read: NonNullable<ThreadMsg["replyRead"]> }) {
  const { t } = useI18n();
  const price =
    typeof read.pricePerDay === "number" && read.pricePerDay > 0
      ? `${read.currency ? `${read.currency} ` : ""}${read.pricePerDay}`
      : null;
  // Nothing to show is not a panel. A box saying "we understood nothing" over a
  // reply we simply never priced would be a claim we cannot support.
  if (!price && read.found !== true && read.matchesSpec == null) return null;
  return (
    <div className="mt-1 rounded-xl bg-black/10 px-2 py-1.5">
      <div className="text-[9px] font-extrabold uppercase tracking-wide opacity-70">
        🧠 {t("What your agent read here")}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-bold">
        {price && (
          <span className="break-words">
            {t("Price")}: {price}/{t("day")}
          </span>
        )}
        {read.matchesSpec === false && (
          <span className="opacity-90">{t("Not the vehicle you asked for")}</span>
        )}
        {read.matchesSpec === true && <span className="opacity-90">{t("Matches your spec")}</span>}
        {!price && read.found === true && (
          <span className="opacity-90">{t("They have one - no price yet")}</span>
        )}
      </div>
    </div>
  );
}

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Bytes are redeemed on demand and never cached publicly - see /api/wa/media. */
const mediaSrc = (id: string) => `/api/wa/media?id=${encodeURIComponent(id)}`;

function MediaPart({ media }: { media: NonNullable<ThreadMsg["media"]> }) {
  const { t } = useI18n();
  const [broken, setBroken] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const src = mediaSrc(media.id);

  if (media.kind === "audio") {
    return (
      <audio controls preload="none" src={src} className="mt-1 h-9 w-full max-w-[220px]">
        {t("Voice message")}
      </audio>
    );
  }
  if (media.kind === "document") {
    return (
      <a
        href={src}
        target="_blank"
        rel="noreferrer"
        className="mt-1 flex items-center gap-1.5 rounded-xl bg-black/10 px-2 py-1.5 text-[11px] font-extrabold underline"
      >
        📄 {media.fileName || t("Open document")}
      </a>
    );
  }
  // A video is watched, not <img>-decoded: the old fallthrough handed video
  // bytes to the image renderer, which fired onError and told the traveller
  // "Photo no longer available on WhatsApp" about a video that was fine.
  if (media.kind === "video") {
    return (
      <video
        controls
        preload="metadata"
        src={src}
        className="mt-1 max-h-72 w-full rounded-xl bg-black/5"
      />
    );
  }
  // An image that will not load is not worth an empty grey box - say so.
  if (broken) {
    return (
      <div className="mt-1 rounded-xl bg-black/10 px-2 py-1.5 text-[11px] font-bold opacity-80">
        🖼️ {t("Photo no longer available on WhatsApp")}
      </div>
    );
  }
  // A price board is the offer. Two things used to hide half of it:
  //   - object-cover CENTER-CROPS a portrait board against a max height, so the
  //     top and bottom rows of the exact price list the traveller is asked to
  //     trust were cut off. object-contain on a neutral box shows all of it.
  //   - orientation was left entirely to the browser's unpinned default. The
  //     property is pinned here and floored in globals.css, and the parsed EXIF
  //     value drives the @supports fallback for engines that ignore it.
  // RESERVED SPACE + SKELETON. The bare <img> was width-full x ZERO pixels
  // until bytes arrived, so a slow redemption looked like nothing at all and
  // then the photo popped in ~10s later with no warning. A 4:3 plate holds the
  // layout, the shared neutral `.skeleton` shimmer says "loading" in the
  // Loading-v4 chrome (no brand hue), and the image fades over it on load.
  return (
    <a href={src} target="_blank" rel="noreferrer" className="mt-1 block">
      <span
        className="relative block overflow-hidden rounded-xl"
        style={loaded ? undefined : { aspectRatio: "4 / 3" }}
      >
        {!loaded && <span aria-hidden className="skeleton absolute inset-0 rounded-xl" />}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={t("Photo from the shop")}
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setBroken(true)}
          data-exif-orientation={orientationAttrValue(media.orientation)}
          style={{ imageOrientation: "from-image" }}
          className={`max-h-72 w-full rounded-xl bg-black/5 object-contain transition-opacity duration-300 ${
            loaded ? "opacity-100" : "absolute inset-0 h-full opacity-0"
          }`}
        />
      </span>
    </a>
  );
}

export function MessageBubble({ m }: { m: ThreadMsg }) {
  const { t } = useI18n();
  const out = m.dir === "out";
  // A pin is only useful if you can open it - link out to the map, do not
  // print coordinates the traveller has to copy by hand.
  const mapHref = m.location
    ? `https://www.google.com/maps/search/?api=1&query=${m.location.lat},${m.location.lng}`
    : null;
  // "[photo]" is a placeholder the ingest writes when there is no caption; once
  // the photo itself is on screen the placeholder is noise.
  const placeholder = /^\[(photo|video|voice note|document[^\]]*)\]$/i.test(m.text.trim());
  // The product card's structural transcription is the CARD's data - once the
  // card itself renders, repeating "[product card] ..." as text is noise.
  const productText = Boolean(m.product) && /^\[product card\]/i.test(m.text.trim());
  // The quote block renders the referent itself - the inline "(quoting: ...)"
  // marker ingest appends for the engine would show it twice.
  const displayText = m.quoted ? m.text.replace(/\n?\(quoting: [\s\S]*$/, "").trim() : m.text;
  const showText = displayText && !(m.media && placeholder) && !productText;

  return (
    <div className={`flex ${out ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-3 py-2 text-[12px] font-semibold leading-snug ${
          // LOGICAL CORNERS, NOT PHYSICAL ONES. The tail marks the side the
          // message came FROM, and the row that positions it is already
          // logical (`justify-end` flips under `dir="rtl"`). A physical
          // `rounded-br`/`rounded-bl` does not, so in Arabic and Hebrew every
          // bubble grew its tail on the wrong side - pointing away from the
          // speaker in the two languages where it matters most.
          out
            ? m.kind === "human-manual"
              ? "rounded-ee-md bg-savings text-white"
              : "rounded-ee-md bg-brandblue text-white"
            : "rounded-es-md bg-card text-strong"
        }`}
      >
        {m.kind === "human-manual" && (
          <div className="mb-0.5 text-[9px] font-extrabold uppercase tracking-wide opacity-80">
            {t("You (from WhatsApp)")}
          </div>
        )}
        {m.media && <MediaPart media={m.media} />}
        {/* THE RECEIPT. Collapsed by default so it never competes with the
            conversation; one tap proves what was understood in this exact
            image, and what it changed.

            IT RENDERS WHENEVER THERE IS AN IMAGE ROW, not only when a reading
            landed. The gate here used to be `m.media && m.reading`, one line
            below a picture that draws unconditionally - so every stamp failure
            degraded to a photo with complete silence underneath it, and the
            traveller could not tell "still working" from "we are blind" from
            "the panel is broken". AgenticSummary takes the placeholder from
            here and repaints itself when the reading arrives.

            Only image rows: a voice note or a PDF is never sent to the reader,
            so promising it a reading would be a new false claim, and those keep
            the old gate - a panel only if something really was read. */}
        {m.media && (m.reading || m.media.kind === "image") && (
          <AgenticSummary reading={m.reading} mediaAt={m.at} />
        )}
        {mapHref && (
          <a
            href={mapHref}
            target="_blank"
            rel="noreferrer"
            className="mt-1 flex items-center gap-1.5 rounded-xl bg-black/10 px-2 py-1.5 text-[11px] font-extrabold underline"
          >
            📍 {m.location?.name || t("Open the shop's pin in Maps")}
          </a>
        )}
        {m.contact && (m.contact.name || m.contact.digits) && (
          <div className="mt-1 rounded-xl bg-black/10 px-2 py-1.5 text-[11px] font-bold break-words">
            👤 {m.contact.name || t("Contact")}
            {m.contact.digits ? ` · +${m.contact.digits}` : ""}
          </div>
        )}
        {m.product && (
          <div className="mt-1 rounded-xl bg-black/10 px-2 py-1.5">
            <div className="text-[9px] font-extrabold uppercase tracking-wide opacity-70">
              🛍️ {t("From the shop's catalog")}
            </div>
            <div className="text-[12px] font-extrabold break-words">{m.product.title}</div>
            {m.product.price != null && (
              <div className="text-[11px] font-bold opacity-90">
                {m.product.currency ? `${m.product.currency} ` : ""}
                {m.product.price}
              </div>
            )}
            {m.product.description && (
              <div className="text-[10px] font-normal opacity-80 break-words">
                {m.product.description}
              </div>
            )}
          </div>
        )}
        {m.quoted && (
          <div className="mt-1 rounded-lg border-l-2 border-white/40 bg-black/10 px-2 py-1 text-[10px] font-normal opacity-85 break-words">
            {m.quoted}
          </div>
        )}
        {/* WHAT WE HEARD, as its own thing. The transcript is stamped at ingest
            and was selected by nobody: the traveller only ever saw it because
            the body had been rewritten to "(voice note) <spoken>". */}
        {m.transcript && (
          <div className="mt-1 rounded-xl bg-black/10 px-2 py-1.5">
            <div className="text-[9px] font-extrabold uppercase tracking-wide opacity-70">
              🎧 {t("What your agent heard")}
            </div>
            <p className="whitespace-pre-wrap break-words text-[11px] font-normal opacity-90">
              {m.transcript}
            </p>
          </div>
        )}
        {/* THIS IS NOT THIS SHOP'S PRICE. A forwarded competitor board read as
            an own quote is the same class of error as an ungrounded price, and
            the traveller is owed the distinction before they act on the number. */}
        {m.forwarded && (
          <div className="mt-1 rounded-xl bg-black/10 px-2 py-1 text-[10px] font-bold opacity-85">
            ↪️ {t("Forwarded - this may be another shop's price, not theirs")}
          </div>
        )}
        {m.replyRead && <TextRead read={m.replyRead} />}
        {showText ? (
          <div className={`whitespace-pre-wrap break-words ${m.media ? "mt-1" : ""}`}>
            <WaText text={displayText} />
          </div>
        ) : null}
        {m.english && m.english !== m.text && (
          <div className="mt-1 whitespace-pre-wrap break-words border-t border-white/25 pt-1 text-[10px] font-normal opacity-85">
            <WaText text={m.english} />
          </div>
        )}
        <div className={`mt-0.5 text-[9px] font-bold ${out ? "text-white/70" : "text-faint"}`}>
          {clock(m.at)}
        </div>
      </div>
    </div>
  );
}
