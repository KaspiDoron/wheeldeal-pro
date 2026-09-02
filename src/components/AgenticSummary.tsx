"use client";

// THE PROOF, UNDER THE PICTURE.
//
// A shop sends a price board; the app shows a number. Between those two things
// sits a vision model, and until now the traveller had to take it on faith. This
// is the receipt: everything the agents read out of that specific image, in the
// shop's own terms, collapsed by default so it never competes with the
// conversation and one tap away when somebody wants to check.
//
// It is deliberately not a paragraph written to sound clever. It is the stored
// reading (lib/media/reading) - the same object the negotiation acted on. When
// the reading is empty it says so, because "we could not read this one" is a
// true and useful thing to tell somebody who can see the photo perfectly well.

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import {
  missingReadingHeadline,
  missingReadingLine,
  readingEmptyLine,
  readingHeadline,
  readingIsEmpty,
  readingIsFailure,
  readingIsPending,
  READING_GRACE_MS,
  type MediaReading,
} from "@/lib/media/reading";

const TONE: Record<MediaReading["confidence"], string> = {
  high: "text-savings",
  medium: "text-brandblue",
  low: "text-brandyellow",
};

/**
 * AN IMAGE ROW ALWAYS EXPLAINS ITSELF.
 *
 * `mediaAt` is when the photo landed, and it is what separates the two honest
 * things we can say about a photo we hold no reading for: the turn is still
 * running, or it finished without ever storing one. Before this, the bubble
 * simply rendered nothing under the picture - and the traveller could not tell
 * "still working" from "we are blind" from "the panel is broken".
 */
export function AgenticSummary({
  reading,
  mediaAt,
}: {
  reading?: MediaReading | null;
  mediaAt?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  // Starts optimistic and flips itself once, so a photo left unexplained stops
  // claiming to be in progress WITHOUT waiting for the next poll to repaint it
  // (the transcript deliberately keeps its array identity when nothing moved).
  const [graceOver, setGraceOver] = useState(false);
  const waiting = !reading;
  useEffect(() => {
    if (!waiting) return;
    const left = readingIsPending(mediaAt, Date.now())
      ? Math.max(0, READING_GRACE_MS - (Date.now() - Date.parse(String(mediaAt ?? ""))))
      : 0;
    if (!Number.isFinite(left)) return; // no usable timestamp - never accuse
    const id = setTimeout(() => setGraceOver(true), left);
    return () => clearTimeout(id);
  }, [waiting, mediaAt]);

  if (!reading) {
    const pending = !graceOver && readingIsPending(mediaAt, Date.now());
    return (
      <Shell
        open={open}
        onToggle={() => setOpen((o) => !o)}
        headline={t(missingReadingHeadline(pending))}
      >
        <p className="text-[11px] text-soft">{t(missingReadingLine(pending))}</p>
      </Shell>
    );
  }

  const empty = readingIsEmpty(reading);
  // DID WE FAIL, OR DID THE PHOTO? Everything below hangs off this one
  // question. A reader that broke, a generation cut off at our token ceiling
  // and a price our own plausibility net rejected are all failures of OURS -
  // they get their own sentence, they never borrow "nothing readable in this
  // one", and they never carry a confidence, because "CONFIDENCE: LOW" on a
  // failed read is not a statement about the picture (owner report 5, #1/#8).
  const failed = readingIsFailure(reading);

  return (
    <Shell
      open={open}
      onToggle={() => setOpen((o) => !o)}
      headline={t(readingHeadline(reading))}
    >
      <>
          {/* WHAT THE TURN RECORDED, NOT WHAT THE PANEL HOPES.
              This used to be one hardcoded sentence promising the agent was
              "asking the shop to type it instead" - a dispatch nothing had
              performed and nothing had observed. readingEmptyLine reads the
              OUTCOME and the follow-up the turn actually stamped, and says
              nothing at all when there is nothing recorded to say. A failure
              outcome prints its line ABOVE whatever was still read, so a
              sanity-rejected price shows the rows AND why we will not quote. */}
          {(failed || empty) && (
            <p className="text-[11px] text-soft">{t(readingEmptyLine(reading))}</p>
          )}
          {!empty && (
            <>
              {reading.prices.length > 0 && (
                <Block label={t("Prices read")}>
                  <ul className="space-y-1">
                    {reading.prices.map((p, i) => (
                      <li key={i} className="flex items-baseline gap-1.5 text-[11.5px]">
                        <span
                          className={`font-extrabold text-strong ${
                            p.available === false ? "line-through opacity-60" : ""
                          }`}
                        >
                          {p.pricePerDay} {p.currency ?? ""}
                        </span>
                        <span className="text-faint">/{t("day")}</span>
                        {p.vehicle && <span className="truncate text-soft">- {p.vehicle}</span>}
                        {p.tierLabel && (
                          <span className="shrink-0 rounded-full bg-card2 px-1.5 text-[9px] font-extrabold text-faint">
                            {p.tierLabel}
                          </span>
                        )}
                        {/* A ROW THE BOARD CROSSED OUT is still on the board, so
                            it stays in the reading - but it is not on offer, and
                            the traveller must see which of the two it is. */}
                        {p.available === false && (
                          <span className="shrink-0 rounded-full bg-card2 px-1.5 text-[9px] font-extrabold text-brandyellow">
                            {t("crossed out")}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </Block>
              )}

              {reading.vehicles.length > 0 && (
                <Block label={t("Vehicles named")}>
                  <p className="text-[11.5px] text-strong">{reading.vehicles.join(", ")}</p>
                </Block>
              )}

              {reading.deposit && (
                <Block label={t("Deposit terms")}>
                  <p className="text-[11.5px] text-strong">{reading.deposit}</p>
                </Block>
              )}

              {reading.conditions.length > 0 && (
                <Block label={t("Conditions")}>
                  <ul className="list-inside list-disc space-y-0.5 text-[11.5px] text-strong">
                    {reading.conditions.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                </Block>
              )}

              {reading.text && (
                <Block label={t("Text lifted from the image")}>
                  {/* THE LONGEST UNBROKEN STRING IN THE APP. This is the raw
                      reading of a price board - a URL, a run of digits, a
                      Thai line with no spaces - and with no `break-words` it
                      pushed the whole panel sideways on a 320px phone. */}
                  <p className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-[11px] leading-snug text-soft">
                    {reading.text}
                  </p>
                </Block>
              )}
            </>
          )}

          {/* WHAT IT CHANGED. A reading nobody acted on is trivia; this is the
              line that connects the picture to the price on the card. */}
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-2">
            {/* NO CONFIDENCE ON A FAILURE. "CONFIDENCE: LOW" under an empty
                panel was never a judgement about the photo - it is the constant
                the failure branches hardcode (and the extractor's own default),
                so it read as "we looked hard and your picture is poor" about
                photos we had either not read or not parsed. */}
            {!failed && (
              <span className={`text-[10px] font-extrabold uppercase ${TONE[reading.confidence]}`}>
                {t("Confidence")}: {t(reading.confidence)}
              </span>
            )}
            {reading.fromBurstLeader && (
              <span className="text-[10px] font-bold text-faint">
                {t("Read together with the other photos in this batch")}
              </span>
            )}
            {/* THE PHOTO WAS NOT WHAT WE READ. A vision pass that failed and a
                caption that carried the price used to render as a failed read
                WITH the prices under it - "re-reading this one" above a row and
                a "used 250/day". Saying where the number came from is the only
                version of that card that is not self-contradictory. */}
            {reading.recoveredFrom && (
              <span className="text-[10px] font-bold text-faint">
                {t("Our reader could not use the photo itself - this came from the message with it")}
              </span>
            )}
            {reading.usedPricePerDay ? (
              <span className="text-[10.5px] font-bold text-soft">
                → {t("used")} {reading.usedPricePerDay}/{t("day")} {t("for your offer")}
              </span>
            ) : (
              <span className="text-[10.5px] font-bold text-soft">
                {reading.notUsedReason ?? t("Nothing from this image changed your offer.")}
              </span>
            )}
          </div>
      </>
    </Shell>
  );
}

/**
 * The collapsed row and the panel it opens - shared by the reading and by the
 * placeholder, so an image row can NEVER render as a bare photo with nothing
 * under it. That gap was the whole of the field report: the picture drew
 * unconditionally, the panel only when a reading existed.
 */
function Shell({
  open,
  onToggle,
  headline,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  headline: string;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="mt-1.5">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="btn btn-sm fluid-press flex w-full items-center gap-1.5 rounded-xl bg-card2/70 px-2.5 py-1.5 text-left text-[10.5px] font-extrabold text-soft"
      >
        <span aria-hidden>🧠</span>
        <span className="min-w-0 flex-1 truncate">
          {t("Agentic summary")} - {headline}
        </span>
        {/* THE CHEVRON MUST POINT THE WAY THE TEXT RUNS. "›" and a fixed
            rotate-90 both assume left-to-right, so in Arabic and Hebrew the
            collapsed arrow pointed back at the text it was supposed to open.
            `rtl:-scale-x-100` mirrors it with the document direction; the
            rotation for the OPEN state is direction-neutral (down either way)
            only after the mirror, so it is applied on top. */}
        <span
          className={`shrink-0 transition-transform rtl:-scale-x-100 ${open ? "rotate-90" : ""}`}
          aria-hidden
        >
          ›
        </span>
      </button>
      {open && (
        <div className="glass glass-rim fluid-swap mt-1.5 space-y-2 rounded-2xl p-2.5">
          {children}
        </div>
      )}
    </div>
  );
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-0.5 text-[9px] font-extrabold uppercase tracking-wide text-faint">{label}</p>
      {children}
    </div>
  );
}
