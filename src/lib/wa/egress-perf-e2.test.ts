import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// OWNER REPORT 11, WAVE E2 - the egress/perf completion of OR8-A7.

describe("E2.1 - the two hot polls project raw fields, never the whole jsonb", () => {
  it("replies: the vendorId join reads raw->>vendorId, not the whole raw blob", () => {
    const s = code("src/app/api/replies/route.ts");
    expect(s).toMatch(/select=to_number,vendorId:raw->>vendorId&direction=eq\.outbound/);
    expect(s).not.toMatch(/select=to_number,raw&direction=eq\.outbound/);
  });
  it("activity: the 150-row feed read projects four raw fields, not the whole raw", () => {
    const s = code("src/app/api/activity/route.ts");
    expect(s).toMatch(/vendorId:raw->>vendorId,vendorName:raw->>vendorName,englishGloss:raw->>englishGloss,kind:raw->>kind/);
    expect(s).not.toMatch(/select=id,to_number,body,raw,received_at&direction=eq\.outbound/);
  });
});

describe("E2.3 - independent activity stages run concurrently", () => {
  const s = code("src/app/api/activity/route.ts");
  it("senderSafety and newContactBudget are awaited together, not one-then-the-other", () => {
    expect(s).toMatch(/Promise\.all\(\[\s*senderSafety\(email\)/);
  });
  it("the ETA stage fetches policies and the last-send timestamp concurrently", () => {
    expect(s).toMatch(/Promise\.all\(\[\s*getPolicies\(\)/);
  });
});

describe("E2.4 - the two Places caches no longer collide on one key", () => {
  const s = code("src/lib/google.ts");
  it("resolvePlaceLocation and placeDetails use DISTINCT namespaces", () => {
    expect(s).toMatch(/`ploc:\$\{placeId\}`/);
    expect(s).toMatch(/`pdet:\$\{placeId\}`/);
    // The shared key that let a {label,lat,lng} and a {phone,rating,...} poison
    // each other is gone.
    expect(s).not.toMatch(/`pd:\$\{placeId\}`/);
  });
});
