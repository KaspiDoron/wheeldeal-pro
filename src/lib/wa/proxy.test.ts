import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

let config: Record<string, string | null> = {};
// A queue of select results, consumed in order, so a mint-then-reread can
// return empty first and the winner second within one call.
let selectQueue: Record<string, unknown>[][] = [];
let selectThrows = false;
let updates: { filter: string; values: Record<string, unknown> }[] = [];
let updateThrows = false;
let selectCalls = 0;

vi.mock("../runtime-config", () => ({
  getConfig: async (k: string) => config[k] ?? null,
  sbSelect: async () => {
    if (selectThrows) throw new Error("db down");
    const i = Math.min(selectCalls, selectQueue.length - 1);
    selectCalls++;
    return selectQueue[i] ?? [];
  },
  sbUpdate: async (_t: string, filter: string, values: Record<string, unknown>) => {
    if (updateThrows) throw new Error("db down");
    updates.push({ filter, values });
    return true;
  },
}));

import {
  countryFor,
  renderProxyTemplate,
  mintProxySessionId,
  stickyProxySession,
  templateProxyUrl,
  recordProxyVerification,
  transportSummary,
} from "./proxy";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

beforeEach(() => {
  config = {};
  selectQueue = [[]];
  selectThrows = false;
  updateThrows = false;
  updates = [];
  selectCalls = 0;
});

// THE MOD-HASH POOL WAS A FLEET-WIDE IP CHANGE WAITING TO HAPPEN.
//
// sha256(email) % lines.length remaps roughly (n-1)/n of users the instant the
// pool resizes - every one of them lands on a different exit at once, which is
// exactly the simultaneous fingerprint change proxying exists to avoid. The
// replacement is one gateway plus a token that lives in our table, so there is
// no pool to resize and the exit survives /instance/delete.

describe("countryFor", () => {
  it("takes the request when it is allowlisted", () => {
    expect(countryFor("th", "th,id,vn", "id")).toBe("th");
  });

  it("falls back to default when the request is absent or not allowed", () => {
    expect(countryFor(null, "th,id", "id")).toBe("id");
    expect(countryFor("us", "th,id", "id")).toBe("id"); // not allowed -> default
  });

  it("an empty allowlist permits any well-formed request", () => {
    expect(countryFor("br", "", "th")).toBe("br");
  });

  it("MALFORMED COUNTRY FALLS BACK, never errors", () => {
    // The country pin is ranked third behind simply not being a datacenter ASN.
    // Refusing to proxy over a bad code would sacrifice the first property for
    // the third.
    expect(countryFor("THAILAND", "th", "th")).toBe("th");
    expect(countryFor("t", "th", "id")).toBe("id");
    expect(countryFor("!!", "", "")).toBeNull();
  });
});

describe("renderProxyTemplate", () => {
  it("substitutes session and country", () => {
    const out = renderProxyTemplate(
      "socks5://u:p_country-{country}_session-{session}@gw:1080",
      { session: "abc", country: "th" }
    );
    expect(out).toBe("socks5://u:p_country-th_session-abc@gw:1080");
  });

  it("A TEMPLATE WITHOUT {session} IS REFUSED", () => {
    // It would put every user on one rotating exit - co-tenancy with extra
    // steps and money. Null makes the misconfiguration visible at link time.
    expect(renderProxyTemplate("socks5://u:p@gw:1080", { session: "abc", country: "th" })).toBeNull();
  });

  it("drops the country SEGMENT whole when none resolves - never a bare placeholder", () => {
    const out = renderProxyTemplate(
      "socks5://u:p_country-{country}_session-{session}@gw:1080",
      { session: "abc", country: null }
    );
    expect(out).toBe("socks5://u:p_session-abc@gw:1080");
    expect(out).not.toContain("{country}");
    expect(out).not.toContain("country-");
  });

  it("an empty template is null", () => {
    expect(renderProxyTemplate("", { session: "abc", country: "th" })).toBeNull();
  });
});

describe("the session token", () => {
  it("is alphanumeric only - it rides inside a proxy USERNAME", () => {
    // @ : / in the token would corrupt the credentials string on providers
    // that parse it naively.
    for (let i = 0; i < 20; i++) {
      expect(mintProxySessionId()).toMatch(/^[a-f0-9]+$/);
    }
  });

  it("returns the STORED token when one already exists - minted once, reused forever", async () => {
    selectQueue = [[{ proxy_session_id: "existing123" }]];
    expect(await stickyProxySession("A@B.com")).toBe("existing123");
    // No write when one already exists.
    expect(updates).toHaveLength(0);
  });

  it("mints write-once, then RE-READS rather than trusting the write", async () => {
    // A PATCH that matched zero rows (session row not created yet) still answers
    // 2xx, so the write's own return cannot distinguish stored from no-row. The
    // re-read is authoritative: empty first, the winner second.
    selectQueue = [[], [{ proxy_session_id: "winner" }]];
    expect(await stickyProxySession("x@y.com")).toBe("winner");
    // It did attempt the write-once patch in between.
    expect(updates).toHaveLength(1);
    expect(updates[0].filter).toMatch(/proxy_session_id=is\.null/);
  });

  it("FAILS SOFT to a deterministic per-email token when storage is unreadable", async () => {
    // Unreadable storage must not block linking - proxying is containment, not
    // a gate - and a deterministic fallback keeps the exit stable across
    // retries instead of minting a new one each attempt.
    selectThrows = true;
    const a = await stickyProxySession("stable@x.com");
    const b = await stickyProxySession("stable@x.com");
    expect(a).toBe(b); // deterministic across the outage
    expect(a).toMatch(/^[a-f0-9]{24}$/);
  });
});

describe("templateProxyUrl", () => {
  it("returns null when no template is configured - caller falls back to legacy", async () => {
    config = {};
    expect(await templateProxyUrl("a@b.com")).toBeNull();
  });

  it("renders the gateway with the sticky session and configured country", async () => {
    config = {
      EVOLUTION_PROXY_TEMPLATE: "socks5://u:p_country-{country}_session-{session}@gw:1080",
      EVOLUTION_PROXY_COUNTRY_DEFAULT: "th",
      EVOLUTION_PROXY_COUNTRY_ALLOW: "th,id",
    };
    selectQueue = [[{ proxy_session_id: "tok9" }]];
    expect(await templateProxyUrl("a@b.com")).toBe("socks5://u:p_country-th_session-tok9@gw:1080");
  });
});

describe("recordProxyVerification never breaks a link", () => {
  it("stamps proxy_verified_at on success, clears it on failure", async () => {
    await recordProxyVerification("a@b.com", true);
    expect(updates[0].values.proxy_verified_at).toBeTypeOf("string");
    updates = [];
    await recordProxyVerification("a@b.com", false);
    expect(updates[0].values.proxy_verified_at).toBeNull();
  });

  it("swallows a storage error", async () => {
    vi.doMock("../runtime-config", () => ({
      getConfig: async () => null,
      sbSelect: async () => [],
      sbUpdate: async () => { throw new Error("down"); },
    }));
    const mod = await import("./proxy");
    await expect(mod.recordProxyVerification("a@b.com", true)).resolves.toBeUndefined();
  });
});

describe("transportSummary - the tile that never cries wolf", () => {
  it("NOT CONFIGURED is a neutral first-class state, not a failure", () => {
    // With the paid proxy cut, an unconfigured exit is the expected baseline.
    // A red dot here would fire on every dashboard load.
    return transportSummary().then((t) => {
      expect(t.configured).toBe(false);
      expect(t.sessions).toBeNull();
      expect(t.note).toMatch(/baseline/i);
    });
  });

  it("counts confirmed exits against linked sessions when configured", async () => {
    config = { EVOLUTION_PROXY_TEMPLATE: "socks5://u:p_session-{session}@gw:1080" };
    selectQueue = [[{ proxy_verified_at: "2026-08-09T00:00:00Z" }, { proxy_verified_at: null }]];
    const t = await transportSummary();
    expect(t.configured).toBe(true);
    expect(t.sessions).toBe(2);
    expect(t.verified).toBe(1);
    expect(t.note).toMatch(/asserted but unverified/);
  });

  it("a configured-but-UNVERIFIED fleet still raises the cluster alarm", async () => {
    // The alarm's whole point is numbers egressing from one datacenter IP. A
    // pasted template asserts an exit; proxy_verified_at is the only evidence
    // one is carrying traffic. Five unverified numbers on one host are exactly
    // as exposed as five unconfigured ones, so the tile must say so - it used
    // to go quiet the moment the template existed.
    config = { EVOLUTION_PROXY_TEMPLATE: "socks5://u:p_session-{session}@gw:1080" };
    selectQueue = [
      Array.from({ length: 5 }, () => ({ host_url: "https://h1", proxy_verified_at: null })),
    ];
    const t = await transportSummary();
    expect(t.configured).toBe(true);
    expect(t.verified).toBe(0);
    expect(t.clusterWarning).toEqual({ host: "https://h1", count: 5 });
    expect(t.note).toMatch(/cluster-ban risk/);
  });

  it("a fleet whose exits are all CONFIRMED stays calm at the same size", async () => {
    config = { EVOLUTION_PROXY_TEMPLATE: "socks5://u:p_session-{session}@gw:1080" };
    selectQueue = [
      Array.from({ length: 8 }, () => ({
        host_url: "https://h1",
        proxy_verified_at: "2026-08-09T00:00:00Z",
      })),
    ];
    const t = await transportSummary();
    expect(t.clusterWarning).toBeUndefined();
    expect(t.note).toMatch(/confirmed residential exit/i);
  });

  it("an unreadable session table reports UNKNOWN, never a confident zero", async () => {
    config = { EVOLUTION_PROXY: "socks5://u:p@gw:1080" };
    selectThrows = true;
    const t = await transportSummary();
    expect(t.sessions).toBeNull();
    expect(t.verified).toBeNull();
    expect(t.note).toMatch(/could not be read/i);
  });
});

describe("evolution.ts is rewired, and the mod-hash pool is gone", () => {
  const evo = readCode("src/lib/evolution.ts");

  it("parseProxy uses the template scheme first", () => {
    expect(evo).toMatch(/templateProxyUrl\(email\)/);
  });

  it("THE MOD-HASH POOL PIN IS RETIRED", () => {
    // The specific defect: sha256(email) % lines.length. It must not survive in
    // parseProxy.
    const parseProxyBlock = evo.slice(
      evo.indexOf("async function parseProxy"),
      evo.indexOf("async function parseProxy") + 900
    );
    expect(parseProxyBlock).not.toMatch(/EVOLUTION_PROXY_POOL/);
    expect(parseProxyBlock).not.toMatch(/% lines\.length/);
  });

  it("records the /proxy/set verification result", () => {
    expect(evo).toMatch(/recordProxyVerification\(email, Boolean\(proxySet\?\.ok\)\)/);
  });

  it("the schema carries both new columns, additively", () => {
    const schema = readCode("supabase/schema.sql");
    expect(schema).toMatch(/add column if not exists proxy_session_id text/);
    expect(schema).toMatch(/add column if not exists proxy_verified_at timestamptz/);
  });
});

describe("the transport tile is wired into the risk panel", () => {
  it("the route ships the transport summary alongside fleet and report", () => {
    const route = readCode("src/app/api/admin/ban-risk/route.ts");
    expect(route).toMatch(/transportSummary\(\)/);
    expect(route).toMatch(/\btransport,/);
  });

  it("the panel renders NOT CONFIGURED as neutral copy, not a dark badge", () => {
    const panel = readCode("src/components/admin/BanRiskPanel.tsx");
    expect(panel).toMatch(/!data\.transport\.configured/);
    // Only the UNREADABLE branch is a DarkBadge; the not-configured branch is plain copy.
    expect(panel).toMatch(/Confirmed exits/);
  });
});
