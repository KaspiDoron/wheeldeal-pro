import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { quotedInList, claimKey } from "./inbound-claim";

// OWNER REPORT 11, C2.3 - A '+'-ADDRESS BROKE THE CLAIM RELEASE.
//
// The reply claim key is `email:messageId`. The INSERT stores it literally (a
// JSON body), but every read/delete built it into a PostgREST querystring filter
// with the raw value. In a querystring `+` decodes to a space, so a Gmail-style
// `you+tag@x.co` claim was stored as "you+tag@x.co:MSG" and looked up as
// "you tag@x.co:MSG" - the release, the dedup and the stand-down reads all
// MISSED it. The claim lingered, the recovery sweep re-answered an
// already-answered shop, and a concurrent frame could double-reply.

/** How PostgREST's URL layer parses a filter value out of the querystring. */
const asServerParses = (filter: string): string =>
  new URL("https://x.supabase.co/rest/v1/wa_processed?" + filter).searchParams.get(
    "wa_message_id"
  )!;

describe("the claim key survives the querystring round-trip", () => {
  it("REPRODUCTION: a raw '+'-address filter is corrupted to a space", () => {
    const stored = claimKey("doron+test@gmail.com", "3EB0C1");
    const rawFilter = `wa_message_id=in.("${stored}")`;
    // This is the bug: what the insert stored is not what the read asks for.
    expect(asServerParses(rawFilter)).not.toContain(stored);
    expect(asServerParses(rawFilter)).toContain("doron test@gmail.com"); // + -> space
  });

  it("quotedInList encodes the value so the round-trip is exact", () => {
    const stored = claimKey("doron+test@gmail.com", "3EB0C1");
    const filter = `wa_message_id=in.(${quotedInList([stored])})`;
    expect(asServerParses(filter)).toContain(stored);
  });

  it("handles every reserved character an email can carry", () => {
    for (const email of [
      "doron+test@gmail.com",
      "a.b+c@x.co",
      "user name@x.co", // a literal space
      "quote\"inject@x.co", // a double quote must not break the in-list
      "plain@x.co",
    ]) {
      const key = claimKey(email, "MSGID-1");
      const filter = `wa_message_id=in.(${quotedInList([key])})`;
      expect(asServerParses(filter), email).toContain(key);
    }
  });

  it("keeps the in-list structure for multiple keys", () => {
    const a = claimKey("a+1@x.co", "M1");
    const b = "M1"; // a legacy bare-id spelling
    const list = quotedInList([a, b]);
    expect(list).toBe(`"${encodeURIComponent(a)}","${encodeURIComponent(b)}"`);
    expect(list.split(",")).toHaveLength(2);
  });
});

describe("every email-scoped claim filter routes through quotedInList", () => {
  it("inbound-claim release/select use it, not a raw map", () => {
    const s = readFileSync("src/lib/wa/inbound-claim.ts", "utf8");
    expect(s).toMatch(/wa_message_id=in\.\(\$\{quotedInList\(keys\)\}\)/);
    // the raw, un-encoded shape must be gone
    expect(s).not.toMatch(/keys\.map\(\(k\) => `"\$\{k\}"`\)/);
  });

  it("agent-loop's stand-down read uses it", () => {
    const s = readFileSync("src/lib/agent-loop.ts", "utf8");
    expect(s).toMatch(/wa_message_id=in\.\(\$\{quotedInList\(keys\)\}\)/);
  });

  it("wa-sync's answered-claim read uses it", () => {
    const s = readFileSync("src/lib/wa-sync.ts", "utf8");
    expect(s).toMatch(/in\.\(\$\{quotedInList\(claimSpellings\)\}\)/);
  });
});
