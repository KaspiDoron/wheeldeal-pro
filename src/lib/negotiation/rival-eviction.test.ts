import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A SHOP THAT SAID NO IS NOT LEVERAGE.
//
// The hot rival ZSET had an eviction (`dropSessionOffer`) that could never fire
// on the turn that needs it. Two independent reasons, both proven below:
//
//   1. It sat inside `if (usablePrice && matchesSpec !== false)`, and a decline
//      is by definition the turn with NO price. "Sorry, we have nothing today"
//      never reached it.
//   2. On the rare priced decline that DID reach it, the very next statement
//      was an UNCONDITIONAL `recordSessionOffer` with the same searchId, the
//      same vendorId, the same vehicleKey, the same currency and the same
//      score. `zrem` then `zadd`. Net effect: nothing was ever evicted.
//
// The hot path SHORT-CIRCUITS the Postgres query whose dead-phase filter would
// have excluded the shop, so for the rest of the 18h TTL the agent could tell
// one shop to beat a price from a shop that had already refused to rent it.

// ---- in-memory ioredis fake (same shape as budget-cache.test.ts) -----------
class FakeRedis {
  str = new Map<string, string>();
  z = new Map<string, Map<string, number>>();
  h = new Map<string, Map<string, string>>();
  on() {}
  async ping() {
    return "PONG";
  }
  async set(key: string, val: string) {
    this.str.set(key, val);
    return "OK";
  }
  async exists(key: string) {
    return this.str.has(key) || this.z.has(key) || this.h.has(key) ? 1 : 0;
  }
  async del(...keys: string[]) {
    let n = 0;
    for (const k of keys) if (this.str.delete(k) || this.z.delete(k) || this.h.delete(k)) n++;
    return n;
  }
  async incr(key: string) {
    const v = Number(this.str.get(key) ?? "0") + 1;
    this.str.set(key, String(v));
    return v;
  }
  async decr(key: string) {
    const v = Number(this.str.get(key) ?? "0") - 1;
    this.str.set(key, String(v));
    return v;
  }
  async zadd(key: string, score: string, member: string) {
    let m = this.z.get(key);
    if (!m) this.z.set(key, (m = new Map()));
    m.set(member, Number(score));
    return 1;
  }
  async zrange(key: string, start: number, stop: number, withScores?: "WITHSCORES") {
    const m = this.z.get(key);
    if (!m) return [];
    const sorted = [...m].sort((a, b) => a[1] - b[1]);
    const end = stop < 0 ? sorted.length + stop + 1 : stop + 1;
    const page = sorted.slice(start, end);
    return withScores ? page.flatMap(([mem, sc]) => [mem, String(sc)]) : page.map(([mem]) => mem);
  }
  async zrem(key: string, ...members: string[]) {
    const m = this.z.get(key);
    if (!m) return 0;
    let n = 0;
    for (const mem of members) if (m.delete(mem)) n++;
    return n;
  }
  async zremrangebyrank() {
    return 0;
  }
  async zremrangebyscore() {
    return 0;
  }
  async zcard(key: string) {
    return this.z.get(key)?.size ?? 0;
  }
  async hset(key: string, ...fv: (string | number)[]) {
    let m = this.h.get(key);
    if (!m) this.h.set(key, (m = new Map()));
    for (let i = 0; i < fv.length; i += 2) m.set(String(fv[i]), String(fv[i + 1]));
    return 1;
  }
  async hincrby(key: string, field: string, n: number) {
    let m = this.h.get(key);
    if (!m) this.h.set(key, (m = new Map()));
    const v = Number(m.get(field) ?? "0") + n;
    m.set(field, String(v));
    return v;
  }
  async hgetall(key: string) {
    const m = this.h.get(key);
    return m ? Object.fromEntries(m) : {};
  }
  async expire() {
    return 1;
  }
  async publish() {
    return 0;
  }
}

let fake: FakeRedis;
vi.mock("ioredis", () => ({
  default: class {
    constructor() {
      return fake;
    }
  },
}));

beforeEach(() => {
  vi.stubEnv("REDIS_URL", "redis://fake");
  fake = new FakeRedis();
  vi.resetModules();
});

const SEARCH = 4242;
const VEHICLE = "scooter-125";

async function seedTwoShops(mod: typeof import("../rival-cache")) {
  // Shop A quotes 200, shop B quotes 300 - the owner's own example.
  await mod.recordSessionOffer({
    searchId: SEARCH,
    vendorId: "shop-a",
    vehicleKey: VEHICLE,
    currency: "THB",
    pricePerDay: 200,
    listPricePerDay: 200,
    durationDays: 5,
  });
  await mod.recordSessionOffer({
    searchId: SEARCH,
    vendorId: "shop-b",
    vehicleKey: VEHICLE,
    currency: "THB",
    pricePerDay: 300,
    listPricePerDay: 300,
    durationDays: 5,
  });
}

describe("EXECUTED: the cheaper shop is leverage until it says no", () => {
  it("shop A at 200 is citable at shop B while A is still renting", async () => {
    const mod = await import("../rival-cache");
    await seedTwoShops(mod);
    expect(
      await mod.cheapestCachedRival({
        searchId: SEARCH,
        vehicleKey: VEHICLE,
        currency: "THB",
        excludeVendorId: "shop-b",
        belowPrice: 300,
      })
    ).toBe(200);
  });

  it("once A declines it stops being citable - the whole point of the eviction", async () => {
    const mod = await import("../rival-cache");
    await seedTwoShops(mod);
    await mod.dropSessionOfferAnyCurrency({
      searchId: SEARCH,
      vendorId: "shop-a",
      vehicleKey: VEHICLE,
      fallbackCurrency: "THB",
    });
    expect(
      await mod.cheapestCachedRival({
        searchId: SEARCH,
        vehicleKey: VEHICLE,
        currency: "THB",
        excludeVendorId: "shop-b",
        belowPrice: 300,
      })
    ).toBeNull();
  });

  it("B's own row survives A's eviction - only the shop that said no is dropped", async () => {
    const mod = await import("../rival-cache");
    await seedTwoShops(mod);
    await mod.dropSessionOfferAnyCurrency({
      searchId: SEARCH,
      vendorId: "shop-a",
      vehicleKey: VEHICLE,
      fallbackCurrency: "THB",
    });
    const rows = await fake.zrange(mod.offersKey(SEARCH, VEHICLE, "THB"), 0, -1, "WITHSCORES");
    expect(rows).toEqual(["shop-b", "300"]);
  });
});

describe("EXECUTED: eviction reaches a currency the decline turn never saw", () => {
  // The decline turn's currency is reconciled from the shop's region/phone
  // prefix. A shop that quoted explicitly in USD earlier and then declines
  // would keep its USD row for the rest of the TTL if the eviction only swept
  // the currency in hand. The currency hash written on every offer closes it.
  it("a USD quote is evicted by a decline whose reconciled currency is THB", async () => {
    const mod = await import("../rival-cache");
    await mod.recordSessionOffer({
      searchId: SEARCH,
      vendorId: "shop-a",
      vehicleKey: VEHICLE,
      currency: "USD",
      pricePerDay: 6,
      listPricePerDay: 6,
      durationDays: 5,
    });
    expect(await fake.zcard(mod.offersKey(SEARCH, VEHICLE, "USD"))).toBe(1);

    await mod.dropSessionOfferAnyCurrency({
      searchId: SEARCH,
      vendorId: "shop-a",
      vehicleKey: VEHICLE,
      fallbackCurrency: "THB", // NOT the space the offer is in
    });
    expect(await fake.zcard(mod.offersKey(SEARCH, VEHICLE, "USD"))).toBe(0);
  });

  it("the fallback still works for a session written before the currency hash", async () => {
    const mod = await import("../rival-cache");
    // Simulate a legacy session: an offers ZSET with no currency hash beside it.
    await fake.zadd(mod.offersKey(SEARCH, VEHICLE, "IDR"), "100000", "shop-a");
    expect(await fake.hgetall(mod.currenciesKey(SEARCH, VEHICLE))).toEqual({});

    await mod.dropSessionOfferAnyCurrency({
      searchId: SEARCH,
      vendorId: "shop-a",
      vehicleKey: VEHICLE,
      fallbackCurrency: "IDR",
    });
    expect(await fake.zcard(mod.offersKey(SEARCH, VEHICLE, "IDR"))).toBe(0);
  });

  it("never throws when the currency hash is unreadable", async () => {
    const mod = await import("../rival-cache");
    await fake.zadd(mod.offersKey(SEARCH, VEHICLE, "PHP"), "500", "shop-a");
    fake.hgetall = async () => {
      throw new Error("redis down");
    };
    await expect(
      mod.dropSessionOfferAnyCurrency({
        searchId: SEARCH,
        vendorId: "shop-a",
        vehicleKey: VEHICLE,
        fallbackCurrency: "PHP",
      })
    ).resolves.toBeUndefined();
    // The fallback space is still swept - an unreadable hash is not a reason to
    // leave a declined shop citable.
    expect(await fake.zcard(mod.offersKey(SEARCH, VEHICLE, "PHP"))).toBe(0);
  });
});

describe("EXECUTED: every offer write stamps the currency space it lives in", () => {
  it("records THB and USD as the spaces this session/vehicle has used", async () => {
    const mod = await import("../rival-cache");
    await seedTwoShops(mod);
    await mod.recordSessionOffer({
      searchId: SEARCH,
      vendorId: "shop-c",
      vehicleKey: VEHICLE,
      currency: "USD",
      pricePerDay: 6,
      listPricePerDay: 6,
      durationDays: 5,
    });
    expect(await fake.hgetall(mod.currenciesKey(SEARCH, VEHICLE))).toEqual({
      THB: "1",
      USD: "1",
    });
  });
});

// ---- the two reasons the eviction could never fire, pinned at the source ---
// These are structural because the subject is a 2500-line reply handler whose
// execution needs Supabase, an LLM ladder and a WhatsApp transport. The
// BEHAVIOUR of the cache layer is executed above; what these pin is that the
// caller actually reaches it.
const declComments = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("the caller reaches the eviction on a decline that carries no price", () => {
  const loop = declComments("src/lib/agent-loop.ts");

  it("the decline stage-advance evicts, outside the priced block", () => {
    // Reason 1: the only eviction lived inside `if (usablePrice && ...)`.
    expect(loop).toMatch(/dropSessionOfferAnyCurrency\(\{/);
    // It is reached from the funnel-ledger block, where shopDeclined is decided
    // - which runs on every reply, priced or not.
    const ledgerIdx = loop.indexOf('advanceThreadStage(stageArgs, "price_received"');
    const evictIdx = loop.indexOf("dropSessionOfferAnyCurrency");
    const pricedBlockIdx = loop.indexOf(
      "if (usablePrice && extraction.matchesSpec !== false && !forwardedOnly)"
    );
    expect(ledgerIdx).toBeGreaterThan(-1);
    expect(evictIdx).toBeGreaterThan(ledgerIdx);
    expect(evictIdx).toBeLessThan(pricedBlockIdx);
  });

  it("the re-add is guarded, so the eviction is not undone one line later", () => {
    // Reason 2: `recordSessionOffer` was unconditional on `searchId != null`.
    expect(loop).toMatch(/const shopSaidNo\s*=/);
    expect(loop).toMatch(/if \(searchId != null && !shopSaidNo\) \{/);
    // and the bare unconditional form is gone.
    expect(loop).not.toMatch(/if \(searchId != null\) \{\s*const \{ recordSessionOffer \}/);
  });

  it("the search id is resolved ONCE, so the decline path costs no extra read", () => {
    expect(loop).toMatch(/const resolveSearchId = async \(\): Promise<number \| null> => \{/);
    // Memoised: a second call must not re-query.
    expect(loop).toMatch(/if \(_searchId !== undefined\) return _searchId;/);
  });
});
