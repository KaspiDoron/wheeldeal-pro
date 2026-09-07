// AUDIT F017 - the takeover switch must not treat a failed durable write as
// success.
//
// Both takeover switches (ThreadDashboard and activity/TranscriptSheet) flipped
// on `d.ok !== undefined`, which is TRUE for the honest failure body
// `{ ok: false, takeover: true }` the route answers when the marker insert did
// not land (session-flags.ts returns sbInsert's own res.ok, and the route
// answers HTTP 200 with it). The panel then rendered "You have the wheel - Will
// stays silent on this chat" over a thread with no marker row, and once the 30s
// in-process cache expired - or immediately on a second instance - the agent
// answered the shop the traveller believed was hers.
//
// writeAck is that decision, pure and executed here. The second half pins the
// two call sites, because there is no React harness in this repo: the guarantee
// (both files route the answer through writeAck) AND the absence of the
// unguarded `d.ok !== undefined` shape.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

async function writeAckFn(): Promise<(ok: boolean, body: unknown) => boolean> {
  const mod = await import("./write-ack");
  return mod.writeAck as (ok: boolean, body: unknown) => boolean;
}

describe("F017 - only a confirmed write is an acknowledgement", () => {
  it("a persisted takeover is acknowledged", async () => {
    const writeAck = await writeAckFn();
    expect(writeAck(true, { ok: true, takeover: true })).toBe(true);
  });

  it("THE BUG: the honest ok:false body is NOT an acknowledgement", async () => {
    const writeAck = await writeAckFn();
    // setThreadTakeover returned false (the whatsapp_messages insert 5xx'd, hit
    // the 8s timeout, or 400'd pre-migration) and the route answered 200 with
    // it. `d.ok !== undefined` used to pass this.
    expect(writeAck(true, { ok: false, takeover: true })).toBe(false);
  });

  it("a body with no ok key at all is not an acknowledgement", async () => {
    const writeAck = await writeAckFn();
    expect(writeAck(true, { takeover: true })).toBe(false);
    expect(writeAck(true, {})).toBe(false);
    expect(writeAck(true, null)).toBe(false);
  });

  it("a non-2xx answer is never an acknowledgement, whatever the body says", async () => {
    const writeAck = await writeAckFn();
    // 401 after an aged-out session, 404 for a shop with no thread yet.
    expect(writeAck(false, { error: "Sign in first." })).toBe(false);
    expect(writeAck(false, { error: "no thread with this shop yet" })).toBe(false);
    // Even a lying body cannot promote a refusal.
    expect(writeAck(false, { ok: true })).toBe(false);
  });

  it("a truthy non-boolean ok is not a confirmation", async () => {
    const writeAck = await writeAckFn();
    expect(writeAck(true, { ok: "yes" })).toBe(false);
    expect(writeAck(true, { ok: 1 })).toBe(false);
  });
});

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

describe("F017 - both takeover switches use it", () => {
  const files = [
    "src/components/ThreadDashboard.tsx",
    "src/components/activity/TranscriptSheet.tsx",
  ];

  for (const f of files) {
    it(`${f} routes the answer through writeAck`, () => {
      const src = read(f);
      expect(src).toContain("writeAck(");
    });

    it(`${f} no longer flips on the mere presence of an ok key`, () => {
      const src = read(f);
      expect(src).not.toContain("d.ok !== undefined");
    });

    it(`${f} tells the traveller when the switch did not save`, () => {
      const src = read(f);
      expect(src).toContain('t("Could not save your choice - try again.")');
    });
  }
});
