import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { isAmbiguousSendFailure } from "./send-classify";

// OWNER REPORT 11, H2.2 - AN AMBIGUOUS SEND-TIMEOUT CONVICTED OUR OWN MESSAGE
// AS A HUMAN TAKEOVER.
//
// On a status-0 send (evoFetch's abort/timeout), the message MAY have reached
// WhatsApp. The drain released the message's idempotency claim regardless. If it
// HAD landed, its fromMe echo arrived with:
//   - no whatsapp_messages outbound row (the row is stored only on ok:true), and
//   - no wa_send_claims row (just released),
// so all three echo checks in ingest missed it, and OUR OWN message was
// convicted as a human takeover: agents stood down, every pending wa_outbox row
// for the shop purged, "You've got the wheel" pushed - for a message we sent.
//
// The fix: sendFromUser surfaces `ambiguous` (status 0), and the drain keeps the
// claim on an ambiguous failure - so echo-check-2 recognises the echo AND the
// retry hits the duplicate-hold path instead of re-POSTing a possible double.

const readCode = (p: string) =>
  readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("EXECUTED: which send failures are ambiguous (may have landed)", () => {
  it("status 0 (abort/timeout) is ambiguous - the send may have reached WhatsApp", () => {
    expect(isAmbiguousSendFailure(0)).toBe(true);
  });
  it("every definitive status is NOT ambiguous - Evolution answered, so it did not land", () => {
    for (const s of [200, 400, 401, 403, 404, 429, 500, 502]) {
      expect(isAmbiguousSendFailure(s), `status ${s}`).toBe(false);
    }
  });
});

// drainOutbox is not unit-runnable (it calls the in-module guardOutbound, whose
// read surface - reputation, rate limits, business hours, warmup, cancellation,
// takeover - cannot be stubbed from outside the module; w8-drain-truth.test.ts
// documents why the drain's internals are pinned at the source instead of run).
// So the WIRING of the executed classifier is asserted structurally here.
describe("the wiring: sendFromUser surfaces it, the drain acts on it", () => {
  const evo = readCode("src/lib/evolution.ts");
  const guard = readCode("src/lib/wa-guard.ts");

  it("sendFromUser stamps ambiguous from the classifier, on the failure return", () => {
    expect(evo).toMatch(/ambiguous: isAmbiguousSendFailure\(res\.status\)/);
  });

  it("the drain releases the idempotency claim ONLY on a definitive failure", () => {
    // The release is now guarded: an ambiguous failure keeps the claim.
    expect(guard).toMatch(/if \(!r\.ambiguous\) \{\s*await releaseMessageClaim\(/);
    // The regression was an UNCONDITIONAL release right after the else - gone.
    expect(guard).not.toMatch(/\} else \{\s*await releaseMessageClaim\(/);
  });

  it("ambiguous rides the drain's send-function contract so the flag reaches the branch", () => {
    // Both the injected `send` param type and the local `r` carry the flag,
    // else the guard above could never see it.
    expect((guard.match(/ambiguous\?: boolean;/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
