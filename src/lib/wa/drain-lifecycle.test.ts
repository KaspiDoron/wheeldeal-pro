import { describe, it, expect } from "vitest";
import {
  isTransientSendFailure,
  isRecipientSendFailure,
  transientRetryDecision,
  recipientRetryDecision,
  TRANSIENT_MAX_ATTEMPTS,
  RECIPIENT_MAX_ATTEMPTS,
} from "./send-classify";

// OWNER REPORT 11, T2 - THE PATH EVERY QUEUED MESSAGE CROSSES, WALKED.
//
// drainOutbox itself is not unit-runnable (it calls the in-module guardOutbound,
// whose reputation/rate/hours read surface cannot be stubbed from outside the
// module - see w8-drain-truth). But the DECISIONS it makes on a failed send are
// pure and extracted, and the per-helper units cover each in isolation. What
// none of them do is walk one message through the WHOLE lifecycle the drain
// sequences: classify -> decide -> re-queue -> ...until the terminal state. A
// message that loops forever bans a number (invisible re-probing of a dead
// host); a message dropped too early is a shop the traveller never reached. So
// this executes the exact composition the drain runs, to a terminal state.

describe("a transient (dead-host) failure re-queues, then eventually gives up", () => {
  it("EXECUTED: fast re-queue while young, DROP past the lifetime/attempt cap", () => {
    const firstQueuedAt = 1_700_000_000_000;
    const err = "Evolution API 0"; // a timeout - the classic dead/slow host
    expect(isTransientSendFailure(err)).toBe(true);
    expect(isRecipientSendFailure(err)).toBe(false);

    // Walk it: each drain tick classifies transient and re-queues in the 45-120s
    // band, bounded by attempts. The loop MUST terminate in a drop.
    let attempts = 0;
    let dropped = false;
    for (let tick = 0; tick < TRANSIENT_MAX_ATTEMPTS + 5; tick++) {
      const d = transientRetryDecision(firstQueuedAt, attempts, firstQueuedAt + tick * 1000, 0.5);
      if (d.drop) {
        dropped = true;
        break;
      }
      // The re-queue delay never collapses to zero (no hot spin on a dead host).
      expect(d.delayMs).toBeGreaterThanOrEqual(45_000);
      expect(d.delayMs).toBeLessThanOrEqual(120_000);
      attempts = d.attempts;
    }
    expect(dropped, "a dead-host message must reach a terminal drop, not loop forever").toBe(true);
    expect(attempts).toBeGreaterThan(0);
  });
});

describe("a recipient failure gives up on its own, tighter clock", () => {
  it("EXECUTED: an invalid number is terminal after the recipient cap, not retried forever", () => {
    const err = "number is not on WhatsApp";
    expect(isRecipientSendFailure(err)).toBe(true);
    expect(isTransientSendFailure(err)).toBe(false);

    let attempts = 0;
    let dropped = false;
    for (let tick = 0; tick < RECIPIENT_MAX_ATTEMPTS + 3; tick++) {
      const d = recipientRetryDecision(attempts);
      if (d.drop) {
        dropped = true;
        break;
      }
      // Recipient backoff creeps but is capped so it never invents huge latency.
      expect(d.delayMs).toBeGreaterThan(0);
      expect(d.delayMs).toBeLessThanOrEqual(20 * 60_000);
      attempts = d.attempts;
    }
    expect(dropped).toBe(true);
    expect(attempts).toBe(RECIPIENT_MAX_ATTEMPTS);
  });
});
