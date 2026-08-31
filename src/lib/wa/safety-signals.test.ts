import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  BENIGN_DROP_REASONS,
  isLoudDrop,
  classifySafety,
  dropFeedItem,
  type SafetySignals,
} from "./safety-signals";

// HEALTH THAT CAN BE RED. During the incident the banner said "Messaging: All
// good" while the connection was dropping every reply and the guard was
// terminally deleting queued sends - because "healthy" was computed from
// reputation + queue length, and the queue had just been CANCELLED empty.
// These tests pin the verdict layer that makes that lie impossible.

const NOW = Date.parse("2026-07-29T11:20:00Z");
const base: SafetySignals = {
  connection: "open",
  lastWebhookOkAt: null,
  lastInboundAt: null,
  lastOutboundAt: new Date(NOW - 3600_000).toISOString(), // live threads
  inboundDropped24h: 0,
  sendDropped24h: 0,
};

describe("classifySafety - positive evidence only", () => {
  it("a healthy connected sender with no drops is NOT flagged", () => {
    expect(classifySafety(base, NOW)).toBe(null);
  });

  it("a closed connection with LIVE threads is disconnected (the incident's blind spot)", () => {
    const flag = classifySafety({ ...base, connection: "close" }, NOW);
    expect(flag?.state).toBe("disconnected");
    expect(flag?.publicReason).toMatch(/reconnect/i);
  });

  it("a closed connection with NO live threads stays quiet (nothing is being lost)", () => {
    expect(
      classifySafety(
        { ...base, connection: "close", lastOutboundAt: new Date(NOW - 72 * 3600_000).toISOString() },
        NOW
      )
    ).toBe(null);
    expect(classifySafety({ ...base, connection: "close", lastOutboundAt: null }, NOW)).toBe(null);
  });

  it("pre-first-link ('connecting') and unknown (null) never paint red", () => {
    expect(classifySafety({ ...base, connection: "connecting" }, NOW)).toBe(null);
    expect(classifySafety({ ...base, connection: null }, NOW)).toBe(null);
  });

  it("real drop events in 24h demand attention even with an EMPTY queue", () => {
    const flag = classifySafety({ ...base, inboundDropped24h: 2 }, NOW);
    expect(flag?.state).toBe("attention");
    const flag2 = classifySafety({ ...base, sendDropped24h: 1 }, NOW);
    expect(flag2?.state).toBe("attention");
  });

  it("disconnected outranks attention (the bigger loss first)", () => {
    const flag = classifySafety({ ...base, connection: "close", sendDropped24h: 3 }, NOW);
    expect(flag?.state).toBe("disconnected");
  });
});

describe("the drop taxonomy - deliberate outcomes never alarm", () => {
  it("privacy gate, user pause/takeover, coalesced turns and dup claims are benign", () => {
    for (const r of [
      "vendor-gate",
      "takeover-hold",
      "pause-hold",
      "turn-in-flight",
      "store-claim-lost",
      "session-terminated",
      "batch-truncated",
    ]) {
      expect(isLoudDrop(r), r).toBe(false);
    }
  });

  it("real failures are loud - and an UNKNOWN reason is loud by default", () => {
    for (const r of [
      "no-rfq-thread",
      "unresolved-identity",
      "vendor-gate-unavailable",
      "store-failed",
      "sync-turn-failed",
      "sync-error",
      "empty-media",
      "derived-unattributed",
      "some-brand-new-reason",
    ]) {
      expect(isLoudDrop(r), r).toBe(true);
    }
  });

  it("the benign set is the exception list, not the rule", () => {
    // The bound exists so "benign" cannot quietly become the default. It was 10
    // against a set of 7; three outcomes that were always benign BY DESIGN (a
    // coalesced burst frame whose leader ran the turn, a group/status JID that
    // is never a shop, an expired hunt whose user-cleared twin was already
    // benign) joined it, so the ceiling moves once - each entry still has to
    // argue for itself.
    expect(BENIGN_DROP_REASONS.size).toBeLessThan(13);
  });

  it("the three by-design outcomes are benign, and the unreadable holds are LOUD", () => {
    for (const r of ["image-coalesced", "non-chat-jid", "session-expired"]) {
      expect(isLoudDrop(r), r).toBe(false);
    }
    // The mirror image, and the whole point of splitting the reason strings: a
    // hold taken because OUR OWN STORE was unreadable is a muted shop reply,
    // not a deliberate outcome. Before the split both wrote the benign spelling,
    // so a Supabase blip could mute the fleet with every surface reading green.
    for (const r of ["takeover-unreadable", "pause-unreadable"]) {
      expect(isLoudDrop(r), r).toBe(true);
    }
  });
});

describe("dropFeedItem - the feed's honest voice for surfaced drops", () => {
  it("a benign inbound drop produces NO feed item", () => {
    expect(dropFeedItem("inbound-dropped", JSON.stringify({ reason: "vendor-gate" }))).toBe(null);
    expect(dropFeedItem("inbound-dropped", JSON.stringify({ reason: "pause-hold" }))).toBe(null);
  });

  it("a loud inbound drop gets a specific, calm explanation", () => {
    const item = dropFeedItem("inbound-dropped", JSON.stringify({ reason: "unresolved-identity" }));
    expect(item?.title).toBe("A shop reply needs attention");
    expect(item?.detail).toMatch(/hidden WhatsApp identity/);
  });

  it("every send-dropped is surfaced - the user clicked send and it did not go", () => {
    const halt = dropFeedItem(
      "send-dropped",
      JSON.stringify({ reason: "engagement-halt: no reply or read receipt yet" })
    );
    expect(halt?.title).toBe("A message was not sent");
    expect(halt?.detail).toMatch(/hasn't answered earlier messages/);
    const dedup = dropFeedItem(
      "send-dropped",
      JSON.stringify({ reason: "rfq-dedup - this shop was already asked in the last 24h" })
    );
    expect(dedup?.detail).toMatch(/already got your request/);
  });

  it("malformed detail degrades to the generic line, never a crash", () => {
    expect(dropFeedItem("inbound-dropped", "not json")?.detail).toBe(
      "A reply couldn't be processed automatically."
    );
    expect(dropFeedItem("something-else", "{}")).toBe(null);
  });
});

const readCode = (p: string) =>
  readFileSync(p, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("the verdict is wired into every surface (source pins)", () => {
  it("senderSafety collects real signals and the flag outranks the queue check", () => {
    const guard = readCode("src/lib/wa-guard.ts");
    expect(guard).toMatch(/collectSafetySignals/);
    expect(guard).toMatch(/classifySafety\(signals, Date\.now\(\)\)/);
    // The flag branch comes BEFORE the queued>0 branch: an empty queue can no
    // longer imply health.
    const flagAt = guard.indexOf("classifySafety(signals");
    const queuedAt = guard.indexOf('state: "pacing"');
    expect(flagAt).toBeGreaterThan(-1);
    expect(flagAt).toBeLessThan(queuedAt);
  });

  it("the activity feed reads drop events, filtered through dropFeedItem", () => {
    const activity = readCode("src/app/api/activity/route.ts");
    // The three DROP kinds must stay in the filter - the list itself is open
    // (owner report 4 added "contact-suggested", a lead rather than a drop),
    // so this pins the membership that matters, not the exact closed set.
    for (const kind of ["inbound-risk", "inbound-dropped", "send-dropped"]) {
      expect(activity).toMatch(new RegExp(`kind=in\\.\\([^)]*"${kind}"`));
    }
    expect(activity).toMatch(/dropFeedItem\(e\.kind, e\.detail\)/);
  });

  it("the WA doctor matches drops structurally - an @lid drop is findable", () => {
    const doctor = readCode("src/app/api/admin/wa-doctor/route.ts");
    expect(doctor).not.toMatch(/detail \?\? ""\)\.includes\(number\)/);
    expect(doctor).toMatch(/sameNumber\(det\.digits, number\)/);
    expect(doctor).toMatch(/det\.lid === shopLid/);
  });

  it("the badge renders the new states honestly", () => {
    const badge = readCode("src/components/WaSafetyBadge.tsx");
    expect(badge).toMatch(/"disconnected"/);
    expect(badge).toMatch(/"attention"/);
    expect(badge).toMatch(/WhatsApp disconnected/);
  });
});
