// AUDIT F233 - the app-closed recovery sweep nests TWO rotations, and they
// must not share one clock.
//
// The cron picks which travellers to sweep this minute with
// rotateWindow(roster, minute, cap); syncInboundReplies then picks WHICH of
// that traveller's shop threads to pull with rotateWindow(numbers, minute, 5).
// Both keyed off the same wall-clock minute, so a traveller who is only
// selected on a sparse set of minutes only ever sees the inner window starts
// belonging to those minutes - and a fixed contiguous block of their shops is
// never pulled from Evolution at all. Their price replies sit in WhatsApp and
// the cards stay on "contacted" for the whole trip.
//
// This test EXECUTES syncInboundReplies over a simulated cron, exactly as
// api/wa/ping composes it, and asserts the COMPOSITION covers every thread.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

const SHOPS = Array.from({ length: 20 }, (_, i) => `6681000${String(i).padStart(4, "0")}`);
const swept: string[] = [];

vi.mock("../runtime-config", () => ({
  sbSelect: async (table: string, query: string) =>
    table === "whatsapp_messages" && query.includes("direction=eq.outbound")
      ? SHOPS.map((n) => ({ to_number: n, raw: { sender: "traveller@example.com" } }))
      : [],
  sbSelectStrict: async () => ({ rows: [] as unknown[] }),
  sbInsert: async () => true,
  sbUpdate: async () => true,
  sbDelete: async () => true,
  getConfig: async () => undefined,
}));

vi.mock("../evolution", () => ({
  resolveChatJid: async (_e: string, digits: string) => `${digits}@s.whatsapp.net`,
  fetchMessagesRaw: async (_e: string, jid: string) => {
    swept.push(String(jid).split("@")[0]);
    return [];
  },
  fetchMediaBase64: async () => null,
  sendFromUser: async () => ({ ok: true }),
}));
vi.mock("../agent-loop", () => ({ processVendorReply: async () => ({}) }));
vi.mock("../drill", () => ({ isVendorThread: async () => true }));

import { syncInboundReplies } from "../wa-sync";
import { rotateWindow, sweepCapForFleet, rosterPassTick } from "./sweep";

const BASE_MS = 1_800_000_000_000; // a fixed minute boundary

const fleetRoster = (n: number) =>
  Array.from({ length: n }, (_, i) => `u${String(i).padStart(3, "0")}@example.com`).sort();

/** Run the cron the way src/app/api/wa/ping/route.ts runs it. */
async function runCron(fleetSize: number, meIndex: number, minutes: number): Promise<Set<string>> {
  const roster = fleetRoster(fleetSize);
  const me = roster[meIndex];
  const cap = sweepCapForFleet(roster.length);
  swept.length = 0;
  for (let m = 0; m < minutes; m++) {
    vi.setSystemTime(new Date(BASE_MS + m * 60_000));
    if (!rotateWindow(roster, m, cap).includes(me)) continue;
    await syncInboundReplies(me, { rotationTick: rosterPassTick(m, roster.length, cap) });
  }
  return new Set(swept);
}

beforeEach(() => {
  vi.useFakeTimers();
  swept.length = 0;
  // The per-user 12s sync throttle lives on globalThis and would otherwise
  // carry a LATER simulated timestamp into the next case.
  (globalThis as { __wd_wa_sync__?: Map<string, number> }).__wd_wa_sync__ = new Map();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the two sweep rotations compose to full coverage", () => {
  // The finder's case (four linked travellers, 20 Ultra shops) plus the shapes
  // the refuter asked to see: a big fleet where the outer window is sparse,
  // and head / middle / tail positions in the roster.
  const cases: Array<[number, number]> = [
    [4, 0],
    [4, 3],
    [8, 0],
    [12, 0],
    [25, 0],
    [60, 0],
    [60, 30],
    [62, 0],
    [100, 99],
  ];
  for (const [fleet, meIndex] of cases) {
    it(`covers all 20 shop threads on a ${fleet}-user fleet (roster index ${meIndex})`, async () => {
      const seen = await runCron(fleet, meIndex, 900);
      expect(
        seen.size,
        `only ${seen.size}/20 of this traveller's shops were ever pulled from Evolution`
      ).toBe(SHOPS.length);
    });
  }

  it("still sweeps every thread when the roster size churns", async () => {
    // recentActiveSenders is derived from open sessions, so the roster grows
    // and shrinks under the sweep. The tick must not need a stable fleet.
    swept.length = 0;
    const me = "u000@example.com";
    for (let m = 0; m < 900; m++) {
      vi.setSystemTime(new Date(BASE_MS + m * 60_000));
      const size = 4 + (Math.floor(m / 7) % 9); // 4..12 linked travellers
      const roster = fleetRoster(size);
      const cap = sweepCapForFleet(roster.length);
      if (!rotateWindow(roster, m, cap).includes(me)) continue;
      await syncInboundReplies(me, { rotationTick: rosterPassTick(m, roster.length, cap) });
    }
    expect(new Set(swept).size).toBe(SHOPS.length);
  });
});
