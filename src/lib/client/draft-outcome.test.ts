// AUDIT F053 - the Bargain composer must never answer a refusal with a blank
// box.
//
// compose() read neither `res.ok` nor any error body: it branched on
// data.message and data.upgrade only, so the 401 after an aged-out session, the
// 400, and both 500s the route's own rails return (the safety screen and the
// price-integrity check, which fires on any ungrounded numeral) set no state at
// all. The modal then rendered its empty textarea, "0 chars" and a Send button
// disabled by !text.trim(), with no reason and no hint anywhere - and a non-JSON
// 500 threw out of a try that had only a finally, rejecting unhandled.
//
// draftOutcome is that decision, pure and executed here.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Outcome =
  | { kind: "draft"; message: string }
  | { kind: "upgrade" }
  | { kind: "error"; error: string };

async function draftOutcomeFn(): Promise<(ok: boolean, body: unknown) => Outcome> {
  const mod = await import("./draft-outcome");
  return mod.draftOutcome as (ok: boolean, body: unknown) => Outcome;
}

describe("F053 - every answer from /api/bargain-draft becomes a state", () => {
  it("a composed draft is a draft", async () => {
    const draftOutcome = await draftOutcomeFn();
    const out = draftOutcome(true, { message: "Could you do 200 a day?", tacticLabel: "anchor" });
    expect(out.kind).toBe("draft");
    if (out.kind === "draft") expect(out.message).toBe("Could you do 200 a day?");
  });

  it("the 403 upgrade answer is an upgrade, not an error", async () => {
    const draftOutcome = await draftOutcomeFn();
    const out = draftOutcome(false, {
      error: "Bargaining in the shop's local language is an Ultra feature.",
      upgrade: true,
    });
    expect(out.kind).toBe("upgrade");
  });

  it("the price-integrity 500 carries the server's own words", async () => {
    const draftOutcome = await draftOutcomeFn();
    const out = draftOutcome(false, { error: "Draft failed the price-integrity check - try again." });
    expect(out.kind).toBe("error");
    if (out.kind === "error") {
      expect(out.error).toBe("Draft failed the price-integrity check - try again.");
    }
  });

  it("the safety-screen 500 is an error too", async () => {
    const draftOutcome = await draftOutcomeFn();
    const out = draftOutcome(false, { error: "Draft failed the safety screen - try again." });
    expect(out.kind).toBe("error");
  });

  it("a 401 is an error the modal can show", async () => {
    const draftOutcome = await draftOutcomeFn();
    const out = draftOutcome(false, { error: "Sign in first." });
    expect(out.kind).toBe("error");
    if (out.kind === "error") expect(out.error).toBe("Sign in first.");
  });

  it("a non-JSON 500 or a dead connection is an error with no server prose", async () => {
    const draftOutcome = await draftOutcomeFn();
    const out = draftOutcome(false, undefined);
    expect(out.kind).toBe("error");
    if (out.kind === "error") expect(out.error).toBe("");
  });

  it("a 200 whose body carries no message is an error, never a blank box", async () => {
    const draftOutcome = await draftOutcomeFn();
    const out = draftOutcome(true, { languageUsed: "english" });
    expect(out.kind).toBe("error");
  });

  it("an empty message string is not a draft", async () => {
    const draftOutcome = await draftOutcomeFn();
    const out = draftOutcome(true, { message: "   " });
    expect(out.kind).toBe("error");
  });
});

describe("F053 - the modal cannot go back to swallowing the body", () => {
  const modal = readFileSync(join(process.cwd(), "src/components/BargainDraftModal.tsx"), "utf8");

  it("routes the answer through draftOutcome", () => {
    expect(modal).toMatch(/draftOutcome\(/);
  });

  it("renders a failure line", () => {
    expect(modal).toMatch(/draftError/);
  });

  it("no longer branches straight off data.message with no ok check", () => {
    expect(modal).not.toMatch(/const data = await res\.json\(\);/);
    expect(modal).not.toMatch(/if \(data\.message\) \{/);
  });
});
