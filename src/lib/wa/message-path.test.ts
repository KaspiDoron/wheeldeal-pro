import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// MESSAGE-PATH OBSERVABILITY (owner report 3, items 4+8).
//
// The question the owner could not answer: "where is each message stuck, and
// why is it not landing?" Hold reasons lived only on the mutable outbox row,
// attempts left no trace at all, and a voice note's transcript existed for
// one engine turn. These tests pin the durable trail end to end.

vi.mock("server-only", () => ({}));

const queries: string[] = [];
let responder: (table: string, q: string) => unknown[] = () => [];
const inserts: Array<{ table: string; rows: Record<string, unknown>[] }> = [];
let insertOk = true;

vi.mock("../runtime-config", () => ({
  sbSelect: async (table: string, q: string) => {
    queries.push(`${table}?${q}`);
    return responder(table, q);
  },
  sbInsert: async (table: string, rows: Record<string, unknown>[]) => {
    inserts.push({ table, rows });
    return insertOk;
  },
}));

import { messagePath } from "./message-path";
import { recordHoldEvent, resetHoldThrottle, HOLD_EVENT_THROTTLE_MS } from "./hold-events";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

beforeEach(() => {
  queries.length = 0;
  inserts.length = 0;
  insertOk = true;
  responder = () => [];
  resetHoldThrottle();
});

describe("messagePath assembles one chronological trail", () => {
  it("merges messages, queue state, events and wakeups, sorted by time", async () => {
    responder = (table, q) => {
      if (table === "whatsapp_messages" && q.includes("direction=eq.inbound"))
        return [
          {
            body: "[voice note]",
            type: "audio",
            raw: { transcript: { text: "300 baht per day", source: "groq" } },
            received_at: "2026-08-13T10:05:00Z",
          },
        ];
      if (table === "whatsapp_messages" && q.includes("direction=eq.outbound"))
        return [{ body: "Best price for 4 days?", type: "text", raw: { confirmed: true }, received_at: "2026-08-13T10:00:00Z" }];
      if (table === "wa_outbox")
        return [{ id: 7, body: "Any chance of 280?", not_before: "2026-08-13T10:20:00Z", meta: { reason: "pacing" }, created_at: "2026-08-13T10:06:00Z" }];
      if (table === "agent_events")
        return [{ kind: "wa-hold", detail: JSON.stringify({ reason: "shop is closed now", until: "2026-08-14T01:00:00Z" }), created_at: "2026-08-13T10:07:00Z" }];
      if (table === "graph_wakeups")
        return [{ kind: "tick", not_before: "2026-08-13T11:00:00Z", created_at: "2026-08-13T10:08:00Z" }];
      return [];
    };
    const path = await messagePath({ senderKey: "user@x.com", toDigits: "66123456789" });
    expect(path.degraded).toBe(false);
    expect(path.steps.map((s) => s.stage)).toEqual(["outbound", "inbound", "queued", "hold", "wakeup"]);
    // The voice note carries its TRANSCRIPT in the trail - no more bare
    // "[voice note]" as the only record of what the shop said.
    expect(path.steps[1].detail).toContain("300 baht per day");
    expect(path.steps[3].detail).toBe("shop is closed now");
  });

  it("a failed read marks the trail DEGRADED instead of presenting a partial trail as whole", async () => {
    responder = (table) => {
      if (table === "agent_events") throw new Error("db down");
      return [];
    };
    const path = await messagePath({ senderKey: "user@x.com", toDigits: "66123456789" });
    expect(path.degraded).toBe(true);
  });

  it("a funnel-stage transition renders as a sentence, and its kind is fetched", async () => {
    responder = (table) => {
      if (table === "agent_events")
        return [
          {
            kind: "funnel-stage",
            detail: JSON.stringify({
              from: "understood",
              to: "price_received",
              evidence: "shop quoted a grounded price",
            }),
            created_at: "2026-08-13T10:07:00Z",
          },
        ];
      return [];
    };
    const path = await messagePath({ senderKey: "user@x.com", toDigits: "66123456789" });
    const step = path.steps.find((s) => s.stage === "funnel");
    expect(step?.detail).toBe("understood -> price_received (shop quoted a grounded price)");
    // The fetch filter includes the ledger + the newly-joinable kinds - the
    // trail can only render what it asks for.
    const ev = queries.find((q) => q.startsWith("agent_events"));
    expect(ev).toContain("funnel-stage");
    expect(ev).toContain("send-failed");
    expect(ev).toContain("human-takeover");
  });

  it("scopes every read to the traveller - the privacy keystone", async () => {
    await messagePath({ senderKey: "user@x.com", toDigits: "66123456789" });
    const wa = queries.filter((q) => q.startsWith("whatsapp_messages"));
    expect(wa.some((q) => q.includes("raw->>receiver=eq.user%40x.com"))).toBe(true);
    expect(wa.some((q) => q.includes("raw->>sender=eq.user%40x.com"))).toBe(true);
    expect(queries.find((q) => q.startsWith("wa_outbox"))).toContain("sender_key=eq.user%40x.com");
    expect(queries.find((q) => q.startsWith("agent_events"))).toContain("user_email=eq.user%40x.com");
  });
});

describe("recordHoldEvent - the append-only hold trail", () => {
  it("writes the new columns first, and degrades WITHOUT them on failure", async () => {
    insertOk = false;
    await recordHoldEvent({ senderKey: "u@x.com", toNumber: "66123", reason: "pacing", decisionId: "d1" });
    expect(inserts.length).toBe(2);
    expect(inserts[0].rows[0]).toMatchObject({ kind: "wa-hold", to_number: "66123", decision_id: "d1" });
    // The degraded retry keeps the event, loses only the join columns.
    expect(inserts[1].rows[0].to_number).toBeUndefined();
    expect(inserts[1].rows[0].kind).toBe("wa-hold");
  });

  it("throttles identical (sender, shop, reason) but lets a CHANGED reason through", async () => {
    await recordHoldEvent({ senderKey: "u@x.com", toNumber: "66123", reason: "pacing" });
    await recordHoldEvent({ senderKey: "u@x.com", toNumber: "66123", reason: "pacing" });
    expect(inserts.length).toBe(1);
    await recordHoldEvent({ senderKey: "u@x.com", toNumber: "66123", reason: "shop is closed now" });
    expect(inserts.length).toBe(2);
    expect(HOLD_EVENT_THROTTLE_MS).toBeGreaterThanOrEqual(60_000);
  });
});

describe("the wiring is in place (source pins)", () => {
  it("every guard queue() verdict appends a wa-hold event", () => {
    const guard = readCode("src/lib/wa-guard.ts");
    expect(guard).toMatch(/const queue = async[\s\S]{0,900}?recordHoldEvent\(\{/);
  });

  it("every failed send attempt leaves a trace - not only drops and unconfirmed", () => {
    const guard = readCode("src/lib/wa-guard.ts");
    expect(guard).toMatch(/send-attempt-failed: \$\{String\(r\.error \?\? "unknown"\)/);
  });

  it("park.ts dedups with the shared NULL-safe kind filter (the W-14 class)", () => {
    const park = readCode("src/lib/wa/park.ts");
    expect(park).toMatch(/import \{ REPLY_KIND_FILTER, humanizeForOutbound \} from "\.\.\/wa-guard"/);
    expect(park).toMatch(/\$\{REPLY_KIND_FILTER\}/);
    // W4.7: a parked row is a mid-thread REPLY by construction (the dedup scope
    // IS the auto-kind filter), so it declares its thread position statically -
    // the drain re-guards with `alreadyHumanized` and never looks again.
    expect(park).toMatch(/firstOutbound: false/);
    // The NULL-blind local predicate is gone.
    expect(park).not.toMatch(/meta->>kind=not\.in\./);
  });

  it("the voice transcript is stamped onto the STORED inbound row", () => {
    const ingest = readCode("src/lib/wa/ingest.ts");
    expect(ingest).toMatch(/raw: \{ \.\.\.\(rows\[0\]\.raw \?\? \{\}\), transcript \}/);
  });

  it("the schema carries the join columns, and the writers can survive without them", () => {
    const schema = read("supabase/schema.sql");
    expect(schema).toMatch(/alter table public\.agent_events add column if not exists decision_id text;/);
    expect(schema).toMatch(/alter table public\.agent_events add column if not exists to_number text;/);
    expect(schema).toMatch(/agent_events_to_number_idx/);
  });

  it("the owner-facing route is owner-gated and never caches", () => {
    const route = readCode("src/app/api/admin/ops/message-path/route.ts");
    expect(route).toMatch(/requireOwner\(\)/);
    expect(route).toMatch(/no-store/);
    expect(route).toMatch(/messagePath\(\{/);
  });
});
