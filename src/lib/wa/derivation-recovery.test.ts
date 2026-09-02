import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { identityKey } from "./phone-key";
import { digitsOnly } from "../phone";

// STORED MUST MEAN ANSWERED. Qui Motorbike Rental's three price messages
// existed in WhatsApp, and even a copy stored in whatsapp_messages would have
// stayed invisible: the recovery sweep skipped anything with a ROW (row
// existence was the whole predicate, so a stored-then-failed turn was
// unrecoverable), only the newest five threads were ever swept, a turn that
// straddled the 60s lock boundary leaked its claims and made the NEXT messages
// lose their turns, and a derived row with vendor_id "" was persisted but
// unreadable by every card. This suite pins the recovery chain end to end:
// the ANSWERED predicate, the rotating sweep, an app-closed runner that
// actually exists in production, exact-slot lock release, and card state that
// follows the wire (a stored reply can never coexist with "Awaiting reply").

const readCode = (p: string) =>
  readFileSync(p, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("the sweep's skip predicate is ANSWERED, not STORED", () => {
  const sync = readCode("src/lib/wa-sync.ts");

  it("reads the wa_processed lease (the durable record of a delivered turn)", () => {
    expect(sync).toMatch(/sbSelectStrict<\{[\s\S]{0,200}?wa_message_id: string;[\s\S]{0,200}?\}>\(\s*"wa_processed"/);
  });

  it("skips on answeredIds - a stored row whose turn died is retried", () => {
    expect(sync).toMatch(/if \(answeredIds\.has\(m\.id\)\) continue;/);
    // The old predicate must be gone: seenIds only guards the INSERT mirror.
    expect(sync).not.toMatch(/if \(seenIds\.has\(m\.id\)\) continue;/);
    // seenIds still guards the mirror - now ANDed with the atomic claim, so a
    // row the webhook stored mid-sweep (after this snapshot was read) cannot
    // be double-written. Both halves must survive.
    expect(sync).toMatch(/if \(!seenIds\.has\(m\.id\) && \(await claimInboundStore\(m\.id, email\)\)\) \{/);
  });

  it("pre-migration (wa_processed missing) degrades to stored-means-done", () => {
    // H4 made the claim receiver-scoped, so the ternary spans lines now: the
    // invariant is unchanged - a strict-read miss falls back to seenIds.
    expect(sync).toMatch(/"rows" in answeredRes[\s\S]{0,600}?: seenIds;/);
    // ...and the sweep honors BOTH claim spellings (scoped + legacy bare id).
    expect(sync).toMatch(/claimKey\(email, i\)/);
  });

  it("counts `recovered` only AFTER the turn ran, and traces a failed turn", () => {
    const turnAt = sync.indexOf("await processVendorReply({");
    const countAt = sync.indexOf("recovered += 1;");
    expect(turnAt).toBeGreaterThan(-1);
    expect(countAt).toBeGreaterThan(turnAt);
    expect(sync).toMatch(/sync-turn-failed/);
  });

  it("rotates the thread window so a 40-shop batch is fully covered", () => {
    expect(sync).toMatch(/rotateWindow\(allNumbers, Math\.floor\(Date\.now\(\) \/ 60_000\), MAX_THREADS\)/);
  });
});

describe("an app-closed recovery runner that exists in production", () => {
  it("the ping cron (the ONE live scheduler) runs a bounded inbound sweep", () => {
    const ping = readCode("src/app/api/wa/ping/route.ts");
    expect(ping).toMatch(/recentActiveSenders/);
    // The sweep cap is now PROPORTIONAL to the fleet with a full-window
    // rotation (owner report 4, scale #9) - a fixed 3 that advanced one sender
    // per tick left a 300-user fleet ~100 min between recovery sweeps.
    expect(ping).toMatch(/rotateWindow\(roster, minute, sweepCapForFleet\(roster\.length\)\)/);
    expect(ping).toMatch(/syncInboundReplies\(email\)/);
    // The response reports it, so the cron logs show recovery working.
    expect(ping).toMatch(/synced/);
  });
});

describe("the thread lock releases EXACTLY what it claimed", () => {
  const lock = readCode("src/lib/wa/turn-lock.ts");

  it("release deletes BOTH claimed buckets, computed from the CLAIM time", () => {
    // DELIBERATE REWRITE: release moved into the shared releaseWindowSlot so
    // the user-move window inherits it - same both-buckets invariant, spelt
    // through the generic slot function.
    expect(lock).toMatch(/slotFor\(toDigits, bucket\), slotFor\(toDigits, bucket - 1\)/);
    expect(lock).toMatch(/slot_key=in\.\(/);
  });

  it("the losing straddle path hands back ONLY its own slot (never the sibling's)", () => {
    const prevLost = lock.slice(lock.indexOf('if (prev === "lost")'));
    expect(prevLost).toMatch(/slot_key=eq\./);
    expect(prevLost.indexOf("slot_key=eq.")).toBeLessThan(
      prevLost.indexOf("export async function releaseThreadTurn")
    );
  });

  it("the agent loop passes ONE timestamp to claim and release alike", () => {
    const loop = readCode("src/lib/agent-loop.ts");
    expect(loop).toMatch(/const turnClaimedAtMs = Date\.now\(\);/);
    expect(loop).toMatch(/claimThreadTurn\(senderKeyForTurn, from, turnClaimedAtMs\)/);
    expect(loop).toMatch(/releaseThreadTurn\(senderKeyForTurn, from, turnClaimedAtMs\)/);
  });
});

describe("a derived row is never written unreadably", () => {
  it("the identity row's vendorId backfills an anchor that lost its own", () => {
    const loop = readCode("src/lib/agent-loop.ts");
    expect(loop).toMatch(/if \(ctx && !ctx\.vendorId && resolved\.vendorId\) ctx\.vendorId = resolved\.vendorId;/);
    expect(loop).toMatch(/derived-unattributed/);
  });
});

describe("card state follows the WIRE, not the derivation", () => {
  const activity = readCode("src/app/api/activity/route.ts");

  it("the activity rollup reads stored inbound rows directly", () => {
    expect(activity).toMatch(/direction=eq\.inbound&raw->>receiver=eq\./);
  });

  it("...and joins them to vendors via our own outbound anchors", () => {
    expect(activity).toMatch(/vendorByDigits/);
    expect(activity).toMatch(
      /for \(const m of inboundRows\) bumpState\(vendorByDigits\[identityKey\(m\.from_number\)\], "active"\);/
    );
  });

  it("the join key SURVIVES the spelling gap between outbound and inbound", () => {
    // THE BUG THIS REPLACES A GREP FOR. The map is built from OUTBOUND
    // to_number - the spelling Google Places gave us, often national
    // (081236954642) - and read with INBOUND from_number, which the WhatsApp
    // JID always renders international (6281236954642). Keyed on raw digits
    // those never meet, so a shop that genuinely replied produced no
    // lastInboundAt and no "active" state: six cards stuck on "Awaiting reply"
    // while the replies sat in whatsapp_messages. Executed, not grepped -
    // the previous version of this test pinned the broken line.
    const outboundSpelling = "081236954642"; // what we stored when we messaged
    const inboundSpelling = "6281236954642"; // what the reply's JID carries
    expect(digitsOnly(outboundSpelling)).not.toBe(digitsOnly(inboundSpelling));
    expect(identityKey(outboundSpelling)).toBe(identityKey(inboundSpelling));

    // ...and the map round-trips, which is the property the route depends on.
    const vendorByDigits: Record<string, string> = {};
    vendorByDigits[identityKey(outboundSpelling)] = "vendor-arka";
    expect(vendorByDigits[identityKey(inboundSpelling)]).toBe("vendor-arka");
  });

  it("a leading-zero national form and its +62 twin are ONE shop", () => {
    // The three Indonesian spellings a Bali shop's number appears in.
    const forms = ["6281236954642", "081236954642", "81236954642"];
    const keys = new Set(forms.map((f) => identityKey(f)));
    expect(keys.size).toBe(1);
  });

  it("the last-message panel shows the stored reply even before the turn runs", () => {
    expect(activity).toMatch(/for \(const m of inboundRows\) \{/);
    expect(activity).toMatch(/slot\.lastInboundAt = m\.received_at;/);
  });
});

describe("every since= filter runs on the SERVER clock", () => {
  const page = readFileSync("src/app/page.tsx", "utf8");

  it("the replies poll and the client epoch filter use the corrected epoch", () => {
    expect(page).toMatch(/const epochOnServerClock = \(\) =>/);
    expect(page).toMatch(/since: String\(epochOnServerClock\(\)\)/);
    expect(page).toMatch(/Date\.parse\(r\.createdAt\) < epochOnServerClock\(\)/);
  });

  it("the thread surfaces receive the corrected epoch too", () => {
    expect(page).toMatch(/searchEpoch=\{epochOnServerClock\(\)\}/);
    expect(page).toMatch(/searchEpoch=\{epochOnServerClock\(\) \|\| undefined\}/);
    expect(page).toMatch(/since=\{epochOnServerClock\(\) \|\| undefined\}/);
  });
});
