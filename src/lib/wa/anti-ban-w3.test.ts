import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { clusterWarning, PROXYLESS_CLUSTER_THRESHOLD } from "./proxy";

vi.mock("server-only", () => ({}));

import { readReceiptDelayMs } from "../evolution";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// OWNER REPORT 4, WAVE 3.1 - the anti-ban deep pass. Read receipts were the
// largest missing behavioural tell; the rest close audit-named gaps or, per
// ANTI-BAN.md's own rule, document the residuals honestly.

describe("A1 read receipts - blue ticks on a human's clock", () => {
  const evo = readCode("src/lib/evolution.ts");
  const ingest = readCode("src/lib/wa/ingest.ts");

  it("markMessageAsRead posts the v2 readMessages shape", () => {
    expect(evo).toMatch(/export async function markMessageAsRead/);
    expect(evo).toMatch(/chat\/markMessageAsRead/);
    expect(evo).toMatch(/readMessages: \[\{ remoteJid: key\.remoteJid, fromMe/);
  });

  it("a failed receipt is COUNTED, never swallowed (the @lid silent-fail class)", () => {
    expect(evo).toMatch(/"wa-read-failed"/);
  });

  it("the humanized delay is bounded so the receipt leaves before CPU freezes", () => {
    // readReceiptDelayMs: floor 2s + exp tail, capped 7s - inside the webhook
    // after-work budget, never an instant machine ack.
    const lo = readReceiptDelayMs(() => 0);
    const hi = readReceiptDelayMs(() => 0.999_999);
    expect(lo).toBe(2_000);
    expect(hi).toBeLessThanOrEqual(7_000);
    expect(hi).toBeGreaterThan(lo);
  });

  it("ingest collects the batch and fires them CONCURRENTLY after the loop", () => {
    // Serial per-message delays would sit in front of the reply; parallel does
    // not. The collection lives outside the try so the post-loop block sees it.
    expect(ingest).toMatch(/readReceipts\.push\(/);
    expect(ingest).toMatch(/Promise\.all\(\s*\n?\s*readReceipts\.map/);
    expect(ingest).toMatch(/finishBeforeResponse\(\s*\n?\s*"read-receipts"/);
  });

  it("the socket-level readMessages stays FALSE - the two are different things", () => {
    // markMessageAsRead marks only the shop messages the agent handled; the
    // socket flag would auto-read every personal chat on connect (privacy + a
    // bot signature). Both must remain true to their separate purposes.
    expect(evo).toMatch(/readMessages: false/);
  });
});

describe("A6 presence failures are counted, not swallowed", () => {
  it("a sendPresence failure writes one throttled wa-presence-failed event", () => {
    const evo = readCode("src/lib/evolution.ts");
    expect(evo).toMatch(/"wa-presence-failed"/);
    expect(evo).toMatch(/if \(!r\.ok && !presenceFailed\)/);
  });
});

describe("A3 fingerprint - refreshed version, baked into the image", () => {
  it("the in-code version is current, platform/browser stay fleet-uniform", () => {
    const evo = readCode("src/lib/evolution.ts");
    expect(evo).toMatch(/\["Mac OS", "Chrome", "131\.0\.0"\]/);
  });

  it("the Evolution Dockerfile sets the server-env fingerprint (pairing path)", () => {
    const dockerfile = read("deploy/evolution/Dockerfile");
    expect(dockerfile).toMatch(/ENV CONFIG_SESSION_PHONE_CLIENT="Mac OS"/);
    expect(dockerfile).toMatch(/ENV CONFIG_SESSION_PHONE_NAME="Chrome"/);
  });
});

describe("A4 datacenter-IP cluster banner - pure and loud", () => {
  it("flags a host with >= threshold unproxied numbers, names the worst", () => {
    const hosts = ["h1", "h1", "h1", "h1", "h1", "h2"]; // 5 on h1
    expect(clusterWarning(hosts, false)).toEqual({ host: "h1", count: 5 });
  });

  it("stays silent below the threshold, and silent whenever a proxy is set", () => {
    expect(clusterWarning(["h1", "h1", "h1"], false)).toBeNull();
    const many = Array.from({ length: 20 }, () => "h1");
    expect(clusterWarning(many, true)).toBeNull(); // proxied => every number its own exit
    expect(PROXYLESS_CLUSTER_THRESHOLD).toBe(5);
  });

  it("picks the WORST host when several cross the line", () => {
    const hosts = [...Array(5).fill("a"), ...Array(8).fill("b")];
    expect(clusterWarning(hosts, false)).toEqual({ host: "b", count: 8 });
  });

  it("transportSummary surfaces the warning as a red state, not the calm baseline", () => {
    const proxy = readCode("src/lib/wa/proxy.ts");
    expect(proxy).toMatch(/clusterWarning\(hostRows\.map/);
    expect(proxy).toMatch(/cluster-ban risk/);
  });
});

describe("A8 webhook re-arm throttle is a SHARED clock, not per-process", () => {
  const evo = readCode("src/lib/evolution.ts");

  it("reads and stamps the wa_sessions row so N instances share one hourly window", () => {
    // The clock moved off the Key Vault (per-instance WH_REARM_* rows polluted
    // the owner's key list) onto the instance's own session row; the legacy
    // config row is still READ so existing throttles carry over a deploy.
    expect(evo).toMatch(/webhook_rearmed_at/);
    expect(evo).toMatch(/async function lastRearmAt/);
    expect(evo).toMatch(/async function stampRearmShared/);
    expect(evo).toMatch(/now - \(await lastRearmAt\(email, instance\)\) < REARM_THROTTLE_MS/);
    expect(evo).toMatch(/rearmConfigKey = \(instance: string\) => `WH_REARM_\$\{instance\}`/);
  });

  it("the shared clock advances ONLY on a verified outcome - a failed set must retry", () => {
    // It used to be stamped BEFORE the set, so a broken re-arm was throttled
    // into staying broken for the next hour, fleet-wide.
    expect(evo).toMatch(/if \(set\.ok\) await stampRearmShared\(email, now\)/);
    // The in-memory map stays as the same-process stampede guard.
    expect(evo).toMatch(/rearmStore\(\)\.set\(instance, now\)/);
  });

  it("the healthy-skip reconciles the EVENTS SET, not just the URL", () => {
    // An instance registered before a new event was added read as healthy on
    // the URL alone and never gained the event.
    expect(evo).toMatch(/const eventsMatch =/);
    expect(evo).toMatch(/sameWebhookTarget\(registeredUrl, origin, token\) && eventsMatch/);
  });
});

describe("A8/A5/A2 honesty - ANTI-BAN.md documents shipped AND residual", () => {
  const doc = read("ANTI-BAN.md");

  it("documents read receipts, cluster banner and the shared re-arm clock", () => {
    expect(doc).toMatch(/Read receipts/);
    expect(doc).toMatch(/cluster banner|cluster-ban trigger/);
    expect(doc).toMatch(/WH_REARM_/);
  });

  it("names the accepted residual risks instead of pretending they are gone", () => {
    expect(doc).toMatch(/Accepted residual risks/);
    expect(doc).toMatch(/Outbound media is 100% text/);
    expect(doc).toMatch(/Proxy support is built but OFF by default/);
  });

  it("keeps the fingerprint version in step with the code", () => {
    expect(doc).toMatch(/"Chrome", "131\.0\.0"/);
  });
});
