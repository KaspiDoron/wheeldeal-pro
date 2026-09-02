// HOW MUCH PICTURE FITS IN ONE VISION CALL.
//
// The inline media path used to pass whatever it downloaded straight into
// readImages: one 12MB photo (or a burst of them) either blew the provider's
// request ceiling - reported back as an opaque 4xx that read as "the model is
// broken" - or ate the whole time budget uploading. The caps here are drawn
// from the providers' real limits (Gemini inline_data requests top out at
// ~20MB total) with headroom for the prompt, and they are enforced BEFORE the
// call so an oversized frame becomes an honest, actionable event instead of a
// mystery failure.
//
// Pure, so the arithmetic is testable without a provider in the loop.

import type { OrientationInfo } from "./orientation";

/** Per-frame ceiling, in BASE64 characters (~3MB of actual bytes). */
export const MAX_FRAME_B64_CHARS = 4 * 1024 * 1024;
/** Whole-request ceiling across frames (~13.5MB of bytes, inside Gemini's ~20MB). */
export const MAX_REQUEST_B64_CHARS = 18 * 1024 * 1024;
/** Frames per vision call - matches the worker coalescer's maxFrames. */
export const MAX_FRAMES_PER_CALL = 8;

export interface BudgetedFrame {
  mime: string;
  base64: string;
  /**
   * What EXIF said about how these pixels are stored. Carried through the
   * budget untouched so the vision call can TELL the model the board is
   * sideways - measured at fetch time and, until this field existed, thrown
   * away one line before the only call that could use it.
   */
  orientation?: OrientationInfo;
}

export interface FrameBudget {
  /** The frames that fit, original order preserved. */
  kept: BudgetedFrame[];
  /** Every frame that did NOT fit, with the reason - never a silent drop. */
  dropped: Array<{
    index: number;
    reason: "frame-too-large" | "request-budget" | "over-frame-cap";
    chars: number;
  }>;
}

/**
 * Fit frames to the vision request budget, in arrival order.
 *
 * Order is preserved (a burst reads as the shop sent it); an oversized frame
 * is dropped alone rather than sinking the request; once the running total or
 * the frame cap is hit, the remainder is dropped with its own reason so the
 * caller can say "read 8 of 11" instead of pretending it read them all.
 */
export function budgetFrames(frames: BudgetedFrame[]): FrameBudget {
  const kept: BudgetedFrame[] = [];
  const dropped: FrameBudget["dropped"] = [];
  let total = 0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const chars = f.base64.length;
    if (chars > MAX_FRAME_B64_CHARS) {
      dropped.push({ index: i, reason: "frame-too-large", chars });
      continue;
    }
    if (kept.length >= MAX_FRAMES_PER_CALL) {
      dropped.push({ index: i, reason: "over-frame-cap", chars });
      continue;
    }
    if (total + chars > MAX_REQUEST_B64_CHARS) {
      dropped.push({ index: i, reason: "request-budget", chars });
      continue;
    }
    kept.push(f);
    total += chars;
  }
  return { kept, dropped };
}
