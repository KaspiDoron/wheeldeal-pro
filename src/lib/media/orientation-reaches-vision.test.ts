import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { orientationNotes, UPRIGHT, type OrientationInfo } from "./orientation";
import { budgetFrames } from "./frame-budget";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// THE ROTATION WAS MEASURED AND THEN THROWN AWAY, ONE LINE BEFORE THE ONLY
// READER THAT COULD USE IT.
//
// Phones are held upright, so a photographed price board routinely arrives with
// a rotation in its EXIF and the pixels stored on their side.
// `fetchMediaBase64` measures it; `orientationNotes` was written to turn it into
// a sentence for the vision prompt and documented as "ready to prepend to the
// vision user text". It had ZERO callers, because the frame budget rebuilt each
// frame as {mime, base64} and the tag went with it.

const SIDEWAYS: OrientationInfo = {
  orientation: 6,
  rotateDeg: 90,
  mirrored: false,
  swapsAxes: true,
  source: "exif-jpeg",
};

describe("the frame budget carries the orientation it is given", () => {
  it("keeps orientation on every frame that fits", () => {
    const { kept } = budgetFrames([
      { mime: "image/jpeg", base64: "a".repeat(1000), orientation: SIDEWAYS },
      { mime: "image/jpeg", base64: "b".repeat(1000) },
    ]);
    expect(kept).toHaveLength(2);
    expect(kept[0].orientation).toBe(SIDEWAYS);
    // An unmeasured frame stays unmeasured - never silently "upright".
    expect(kept[1].orientation).toBeUndefined();
  });

  it("a dropped frame does not take another frame's orientation with it", () => {
    const huge = "x".repeat(5 * 1024 * 1024);
    const { kept, dropped } = budgetFrames([
      { mime: "image/jpeg", base64: huge },
      { mime: "image/jpeg", base64: "c".repeat(100), orientation: SIDEWAYS },
    ]);
    expect(dropped[0].reason).toBe("frame-too-large");
    expect(kept).toHaveLength(1);
    expect(kept[0].orientation).toBe(SIDEWAYS);
  });
});

describe("a sideways board reaches the model as sideways", () => {
  it("produces an instruction naming the rotation and the reading frame", () => {
    const note = orientationNotes([{ orientation: SIDEWAYS }]);
    expect(note).toMatch(/rotate it 90 degrees clockwise/);
    expect(note).toMatch(/Read all text in that upright frame/);
  });

  it("numbers the images when a burst carries several", () => {
    const note = orientationNotes([{ orientation: UPRIGHT }, { orientation: SIDEWAYS }]);
    // Only the one that needs it is mentioned, and it is named by position so
    // the model can tell WHICH frame to rotate.
    expect(note).toMatch(/Image 2/);
    expect(note).not.toMatch(/Image 1/);
  });

  it("an all-upright turn adds NOTHING - the prompt stays byte-identical", () => {
    expect(orientationNotes([{ orientation: UPRIGHT }, {}])).toBe("");
    expect(orientationNotes([])).toBe("");
    expect(orientationNotes(null)).toBe("");
  });
});

describe("the wiring, because a helper with no caller is what this was", () => {
  it("readImages prepends the note itself, so every vision rung gets it", () => {
    const ai = read("src/lib/ai.ts");
    expect(ai).toMatch(/const orientation = orientationNotes\(images\);/);
    expect(ai).toMatch(/userTextWithOrientation/);
    // All three rungs must receive the enriched text, not the raw one.
    const calls = ai.match(/VisionAttempt\([^)]*userTextWithOrientation/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it("ingest hands the whole frame over, not two fields off it", () => {
    // `budget.kept.map((f) => ({ mime: f.mime, base64: f.base64 }))` is exactly
    // how the tag was lost. Pushing the frame keeps it.
    const ingest = read("src/lib/wa/ingest.ts");
    expect(ingest).toMatch(/images\.push\(\.\.\.budget\.kept\);/);
    expect(ingest).not.toMatch(/base64: f\.base64 \}\)\)/);
  });
});
