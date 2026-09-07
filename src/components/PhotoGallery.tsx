"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { lockBodyScroll } from "@/lib/scroll-lock";
import { useI18n } from "@/lib/i18n";
import { scrollToSlide, slideIndexFromScroll, trackDirection, isRtlDirection } from "@/lib/client/carousel-rtl";

// Full-screen swipeable photo carousel (Google Maps place photos). Snap
// scrolling + arrows + a live counter, and it silently drops any photo that
// fails to load so the user never gets stuck on a broken first image.
export function PhotoGallery({
  name,
  photos,
  onClose,
}: {
  name: string;
  photos: string[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [ok, setOk] = useState<boolean[]>(() => photos.map(() => true));
  // A FULL-SCREEN BLACK RECTANGLE IS NOT A LOADING STATE.
  //
  // Place photos are large and arrive over hotel wifi, so opening the gallery
  // showed nothing at all - no plate, no motion - until the bytes landed. The
  // reader could not tell "loading" from "broken", which is the exact
  // ambiguity the loading doctrine exists to remove.
  const [loaded, setLoaded] = useState<boolean[]>(() => photos.map(() => false));
  const [idx, setIdx] = useState(0);
  const trackRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const unlock = lockBodyScroll();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      unlock();
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = photos.filter((_, i) => ok[i]);

  // `dir` here is +1 / -1 in READING order, so the arrows keep meaning "the
  // next photo" in Hebrew and Arabic too. The sign of the scroll offset is the
  // track's business, not the caller's (audit F121).
  function go(dir: number) {
    const track = trackRef.current;
    if (!track) return;
    const next = Math.max(0, Math.min(visible.length - 1, idx + dir));
    setIdx(next);
    scrollToSlide(track, next, isRtlDirection(trackDirection(track)));
  }

  if (!mounted) return null;

  return createPortal(
    <div className="layer-lightbox fixed inset-0 flex flex-col bg-black/90 backdrop-blur-sm pop-in">
      <div className="flex items-center justify-between px-4 pt-safe">
        <span className="truncate py-3 text-[13px] font-extrabold text-white">
          <bdi>{name}</bdi> · {t("{n} photos").replace("{n}", String(visible.length))}
        </span>
        <button
          onClick={onClose}
          aria-label={t("Close")}
          className="btn btn-sm rounded-xl bg-white/15 px-3 text-white"
        >
          ✕
        </button>
      </div>

      {/* EVERY photo failed. Google Place Photos is its own billed SKU and can
          stop serving while search keeps working, and a black void with no
          words reads as a broken app rather than a missing decoration. */}
      {visible.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
          <span className="text-3xl opacity-50">🖼</span>
          <p className="text-[13px] font-extrabold text-white/90">
            {t("Photos are not loading right now")}
          </p>
          <p className="max-w-[16rem] text-[11px] text-white/60">
            {t("This is only the pictures - the shop, its rating and your negotiation are all unaffected.")}
          </p>
        </div>
      ) : (
      <div className="relative flex flex-1 items-center">
        <div
          ref={trackRef}
          onScroll={(e) => {
            // An RTL scroll port reports the same distance with the opposite
            // sign, which used to drive idx to -1, -2 and light no dot at all.
            setIdx(
              slideIndexFromScroll(
                e.currentTarget.scrollLeft,
                e.currentTarget.clientWidth,
                visible.length
              )
            );
          }}
          className="no-scrollbar flex h-full w-full snap-x snap-mandatory overflow-x-auto"
        >
          {photos.map((u, i) =>
            ok[i] ? (
              <div key={i} className="flex h-full w-full shrink-0 snap-center items-center justify-center p-3">
                <div className="relative flex h-full w-full items-center justify-center">
                  {!loaded[i] && (
                    // Reserved space, neutral chrome, honest shimmer - the same
                    // plate every other surface uses while bytes are in flight.
                    <div className="skeleton absolute inset-3 rounded-2xl" aria-hidden />
                  )}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={u}
                    alt=""
                    loading={i === 0 ? "eager" : "lazy"}
                    decoding="async"
                    className={`max-h-full max-w-full rounded-2xl object-contain transition-opacity duration-300 ${
                      loaded[i] ? "opacity-100" : "opacity-0"
                    }`}
                    onLoad={() => setLoaded((prev) => prev.map((v, j) => (j === i ? true : v)))}
                    onError={() => setOk((prev) => prev.map((v, j) => (j === i ? false : v)))}
                  />
                </div>
              </div>
            ) : null
          )}
        </div>

        {visible.length > 1 && (
          <>
            {/* Logical offsets and a mirrored glyph: `start`/`end` follow the
                reading direction, and `.rtl-flip` (globals.css) turns the
                chevrons round the way RequestBuilder's wizard arrows do. */}
            <button
              onClick={() => go(-1)}
              aria-label={t("Previous")}
              className="btn absolute start-2 top-1/2 -translate-y-1/2 rounded-full bg-white/20 px-3 py-2 text-lg font-extrabold text-white"
            >
              <span className="rtl-flip inline-block" aria-hidden>‹</span>
            </button>
            <button
              onClick={() => go(1)}
              aria-label={t("Next")}
              className="btn absolute end-2 top-1/2 -translate-y-1/2 rounded-full bg-white/20 px-3 py-2 text-lg font-extrabold text-white"
            >
              <span className="rtl-flip inline-block" aria-hidden>›</span>
            </button>
          </>
        )}
      </div>
      )}

      {visible.length > 1 && (
        <div className="flex items-center justify-center gap-1.5 pb-safe pt-2">
          {visible.map((_, i) => (
            <span
              key={i}
              className={`h-1.5 rounded-full transition-all ${
                i === idx ? "w-5 bg-white" : "w-1.5 bg-white/40"
              }`}
            />
          ))}
        </div>
      )}
    </div>,
    document.body
  );
}
