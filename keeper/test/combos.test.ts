import { describe, expect, it, vi } from "vitest";
import {
  ComboRegistry,
  isComboSymbol,
  selectCombos,
  validateCombo,
  type ComboDef,
} from "../src/combos.js";
import { closeFill, openFill, SkipFill, tradeFor } from "../src/executor.js";
import type { OrderRequest, OrderResponse } from "../src/gemini/trade.js";
import { isEligible } from "../src/markets.js";
import { ONE, comboQuote, legSideTop, marketIdOf, type ComboLegQuote } from "../src/math.js";
import { booksPerCycle, maxDistinctBooks, pickBooksToRefresh } from "../src/oracle.js";

const yes = (bid: bigint | null, ask: bigint | null): ComboLegQuote => ({ outcome: "yes", bid, ask });
const no = (bid: bigint | null, ask: bigint | null): ComboLegQuote => ({ outcome: "no", bid, ask });

describe("comboQuote (leg product rule)", () => {
  it("multiplies side bids (rounded down) and side asks (rounded up)", () => {
    // 0.60 * 0.50 = 0.30 ; 0.62 * 0.52 = 0.3224
    expect(comboQuote([yes(600_000n, 620_000n), yes(500_000n, 520_000n)])).toEqual({ bid: 300_000n, ask: 322_400n });
    // 0.333333 * 0.333333 = 0.111110888889 -> bid 0.111110 ; ask leg 0.333334^2 = 0.111111555556 -> 0.111112
    expect(comboQuote([yes(333_333n, 333_334n), yes(333_333n, 333_334n)])).toEqual({ bid: 111_110n, ask: 111_112n });
  });
  it("converts No legs: side bid = 1 - YES ask, side ask = 1 - YES bid", () => {
    expect(legSideTop(no(600_000n, 620_000n))).toEqual({ bid: 380_000n, ask: 400_000n });
    // yes leg 0.50/0.52, no leg 0.38/0.40 -> 0.19 / 0.208
    expect(comboQuote([yes(500_000n, 520_000n), no(600_000n, 620_000n)])).toEqual({ bid: 190_000n, ask: 208_000n });
  });
  it("a leg with no side bid makes the combo bid zero", () => {
    expect(comboQuote([yes(null, 620_000n), yes(500_000n, 520_000n)])).toEqual({ bid: 0n, ask: 322_400n });
    // No leg: missing YES ask means no NO bid
    expect(comboQuote([no(600_000n, null), yes(500_000n, 520_000n)])).toEqual({ bid: 0n, ask: 208_000n });
    expect(comboQuote([yes(0n, 620_000n), yes(500_000n, 520_000n)])!.bid).toBe(0n);
  });
  it("a leg with no side ask means no quote at all", () => {
    expect(comboQuote([yes(600_000n, null), yes(500_000n, 520_000n)])).toBeNull();
    // No leg: missing YES bid means no NO ask
    expect(comboQuote([no(null, 620_000n), yes(500_000n, 520_000n)])).toBeNull();
    expect(comboQuote([])).toBeNull();
  });
  it("six legs with small prices stay exact: bid floors to 0, ask rounds up to one micro", () => {
    const legs = Array.from({ length: 6 }, () => yes(50_000n, 60_000n));
    // 0.05^6 = 1.5625e-8 -> 0 ; 0.06^6 = 4.6656e-8 -> ceil to 0.000001
    expect(comboQuote(legs)).toEqual({ bid: 0n, ask: 1n });
    const mid = Array.from({ length: 6 }, () => yes(700_000n, 710_000n));
    // 0.7^6 = 0.117649 exactly ; 0.71^6 = 0.128100283921 -> 0.128101
    expect(comboQuote(mid)).toEqual({ bid: 117_649n, ask: 128_101n });
  });
  it("clamps to 0 <= bid <= ask <= 1e6", () => {
    expect(comboQuote([yes(ONE, ONE), yes(ONE, ONE)])).toEqual({ bid: ONE, ask: ONE });
    expect(comboQuote([yes(2n * ONE, 3n * ONE), yes(ONE, ONE)])).toEqual({ bid: ONE, ask: ONE });
    // crossed leg book: bid never above ask
    const q = comboQuote([yes(700_000n, 600_000n), yes(ONE, ONE)])!;
    expect(q.bid <= q.ask).toBe(true);
    for (const legs of [[yes(1n, 999_999n), no(1n, 999_999n)], [no(0n, ONE), yes(0n, ONE)]]) {
      const r = comboQuote(legs)!;
      expect(r.bid >= 0n && r.bid <= r.ask && r.ask <= ONE).toBe(true);
    }
  });
});

const NOW_SEC = Math.floor(Date.parse("2026-11-15T06:00:00.000Z") / 1000);
const iso = (sec: number) => new Date(sec * 1000).toISOString();

function rawCombo(symbol: string, legSymbols: string[], over: Record<string, unknown> = {}) {
  return {
    marketId: marketIdOf(symbol),
    symbol,
    origin: "vectis",
    label: symbol,
    legs: legSymbols.map((s, i) => ({
      symbol: s,
      outcome: i % 2 === 0 ? "yes" : "no",
      label: s,
      eventTitle: "E",
      eventTicker: "T",
      expiry: iso(NOW_SEC + 86_400 + i * 3600),
    })),
    closeTime: NOW_SEC + 86_400,
    expiry: iso(NOW_SEC + 86_400),
    requested: true,
    indicative: { bid: null, ask: null },
    ...over,
  };
}

const def = (symbol: string, legSymbols: string[]): ComboDef => {
  const v = validateCombo(rawCombo(symbol, legSymbols), NOW_SEC);
  if (!v.ok) throw new Error(v.reason);
  return v.def;
};

describe("validateCombo", () => {
  it("accepts a well-formed combo and normalises it", () => {
    const v = validateCombo(rawCombo("VECTIS-CMB-0123456789ABCDEF", ["GEMI-A", "GEMI-B"]), NOW_SEC);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.def.marketId).toBe(marketIdOf("VECTIS-CMB-0123456789ABCDEF"));
    expect(v.def.legs.map((l) => `${l.symbol}:${l.outcome}`)).toEqual(["GEMI-A:yes", "GEMI-B:no"]);
    expect(v.def.closeTime).toBe(NOW_SEC + 86_400);
  });
  it("accepts an upper-case marketId", () => {
    const raw = rawCombo("VECTIS-CMB-1", ["A", "B"]);
    expect(validateCombo({ ...raw, marketId: raw.marketId.toUpperCase().replace("0X", "0x") }, NOW_SEC).ok).toBe(true);
  });
  it("uses the smaller of the feed close time and the earliest leg expiry", () => {
    const early = rawCombo("VECTIS-CMB-2", ["A", "B"]);
    early.legs[1]!.expiry = iso(NOW_SEC + 7200);
    const v = validateCombo(early, NOW_SEC);
    expect(v.ok && v.def.closeTime).toBe(NOW_SEC + 7200);
    const feedEarlier = validateCombo(rawCombo("VECTIS-CMB-2", ["A", "B"], { closeTime: NOW_SEC + 600 }), NOW_SEC);
    expect(feedEarlier.ok && feedEarlier.def.closeTime).toBe(NOW_SEC + 600);
  });
  it("rejects a marketId that is not keccak256(symbol)", () => {
    const v = validateCombo(rawCombo("VECTIS-CMB-3", ["A", "B"], { marketId: marketIdOf("OTHER") }), NOW_SEC);
    expect(v).toEqual({ ok: false, reason: "marketId is not keccak256(symbol)" });
  });
  it("rejects bad leg counts, duplicate legs, bad outcomes and combo legs", () => {
    const bad = (raw: unknown) => {
      const v = validateCombo(raw, NOW_SEC);
      return v.ok ? "ok" : v.reason;
    };
    expect(bad(rawCombo("VECTIS-CMB-4", ["A"]))).toMatch(/1 legs/);
    expect(bad(rawCombo("VECTIS-CMB-4", ["A", "B", "C", "D", "E", "F", "G"]))).toMatch(/7 legs/);
    expect(bad(rawCombo("VECTIS-CMB-4", ["A", "B", "C", "D", "E", "F"]))).toBe("ok");
    expect(bad(rawCombo("VECTIS-CMB-4", ["A", "A"]))).toMatch(/duplicate leg A/);
    const outcome = rawCombo("VECTIS-CMB-4", ["A", "B"]);
    (outcome.legs[0] as { outcome: string }).outcome = "maybe";
    expect(bad(outcome)).toMatch(/outcome is not yes\/no/);
    expect(bad(rawCombo("VECTIS-CMB-4", ["A", "GEMI-CMB-261117-D2C25E954E0E19E0-CMB"]))).toMatch(/is a combo/);
    expect(bad(rawCombo("VECTIS-CMB-4", ["A", "VECTIS-CMB-4"]))).toMatch(/is a combo/);
    expect(bad({ ...rawCombo("VECTIS-CMB-4", ["A", "B"]), legs: undefined })).toBe("missing legs");
    expect(bad(null)).toBe("missing symbol");
  });
  it("rejects a close time that is not in the future", () => {
    expect(validateCombo(rawCombo("VECTIS-CMB-5", ["A", "B"], { closeTime: NOW_SEC }), NOW_SEC).ok).toBe(false);
    const expiredLeg = rawCombo("VECTIS-CMB-5", ["A", "B"]);
    expiredLeg.legs[0]!.expiry = iso(NOW_SEC - 60);
    expect(validateCombo(expiredLeg, NOW_SEC).ok).toBe(false);
  });
});

describe("combo symbols are never single markets", () => {
  it("recognises combo symbols", () => {
    expect(isComboSymbol("GEMI-CMB-261117-D2C25E954E0E19E0-CMB")).toBe(true);
    expect(isComboSymbol("VECTIS-CMB-0123456789ABCDEF")).toBe(true);
    expect(isComboSymbol("GEMI-NCAAF-2611150030-UTA-ARI-M-UTA")).toBe(false);
  });
  it("market selection skips combo contracts", () => {
    const now = Date.parse("2026-11-15T06:00:00.000Z");
    const c = { marketState: "open", expiryDate: new Date(now + 86_400_000).toISOString(), prices: { bestBid: "0.5", bestAsk: "0.52" } };
    const opts = { count: 8, nowMs: now };
    expect(isEligible({}, { ...c, instrumentSymbol: "GEMI-X" }, opts)).toBe(true);
    expect(isEligible({}, { ...c, instrumentSymbol: "GEMI-X", isCombo: true }, opts)).toBe(false);
    expect(isEligible({}, { ...c, instrumentSymbol: "GEMI-CMB-261117-D2C25E954E0E19E0-CMB" }, opts)).toBe(false);
  });
});

describe("selectCombos", () => {
  const a = def("VECTIS-CMB-A", ["L1", "L2"]);
  const b = def("VECTIS-CMB-B", ["L3", "L4"]);
  const c = def("VECTIS-CMB-C", ["L1", "L5"]);
  const d = def("VECTIS-CMB-D", ["L6", "L7", "L8"]);
  const base = { saved: [] as ComboDef[], carried: new Set<string>(), baseSymbols: ["M1", "M2"], maxBooks: 100 };

  it("takes the newest requested combos up to the count", () => {
    const s = selectCombos({ ...base, requested: [a, b, c, d], count: 2 });
    expect(s.tracked.map((x) => x.symbol)).toEqual(["VECTIS-CMB-A", "VECTIS-CMB-B"]);
    expect(s.books).toBe(6); // M1 M2 L1 L2 L3 L4
  });
  it("always keeps a combo with an active position, even if old or no longer listed", () => {
    const s = selectCombos({ ...base, requested: [a, b, c], saved: [d], carried: new Set([d.marketId]), count: 2 });
    expect(s.tracked.map((x) => x.symbol)).toEqual(["VECTIS-CMB-D", "VECTIS-CMB-A"]);
    const listedButOld = selectCombos({ ...base, requested: [a, b, c], carried: new Set([c.marketId]), count: 1 });
    expect(listedButOld.tracked.map((x) => x.symbol)).toEqual(["VECTIS-CMB-C"]);
  });
  it("carried combos may exceed the count but add no extra requested ones", () => {
    const s = selectCombos({ ...base, requested: [a], saved: [b, c, d], carried: new Set([b.marketId, c.marketId, d.marketId]), count: 2 });
    expect(s.tracked.map((x) => x.symbol).sort()).toEqual(["VECTIS-CMB-B", "VECTIS-CMB-C", "VECTIS-CMB-D"]);
  });
  it("count 0 tracks only carried combos", () => {
    expect(selectCombos({ ...base, requested: [a, b], count: 0 }).tracked).toEqual([]);
  });
  it("skips combos whose legs would exceed the book budget; shared legs are free", () => {
    // base 2 books + A (L1, L2) = 4. B needs 2 more (6 > 5): skipped. C shares L1, needs 1 more: fits.
    const s = selectCombos({ ...base, requested: [a, b, c], count: 6, maxBooks: 5 });
    expect(s.tracked.map((x) => x.symbol)).toEqual(["VECTIS-CMB-A", "VECTIS-CMB-C"]);
    expect(s.overBudget.map((x) => x.symbol)).toEqual(["VECTIS-CMB-B"]);
    expect(s.books).toBe(5);
  });
  it("legs that are already tracked markets cost nothing", () => {
    const s = selectCombos({ ...base, baseSymbols: ["L1", "L2"], requested: [a], count: 6, maxBooks: 2 });
    expect(s.tracked).toHaveLength(1);
    expect(s.books).toBe(2);
  });
  it("keeps a carried combo even when it breaks the budget", () => {
    const s = selectCombos({ ...base, requested: [a], saved: [d], carried: new Set([d.marketId]), count: 6, maxBooks: 3 });
    expect(s.tracked.map((x) => x.symbol)).toEqual(["VECTIS-CMB-D"]);
    expect(s.overBudget.map((x) => x.symbol)).toEqual(["VECTIS-CMB-A"]);
  });
});

describe("price-loop book budget", () => {
  it("stays at or under one request per second", () => {
    expect(booksPerCycle(10_000)).toBe(9);
    expect(booksPerCycle(3000)).toBe(2);
    expect(booksPerCycle(1000)).toBe(1);
  });
  it("bounds distinct books so a full rotation fits inside the heartbeat", () => {
    expect(maxDistinctBooks(10_000, 45_000)).toBe(27);
    expect(maxDistinctBooks(10_000, 15_000)).toBe(9);
    expect(maxDistinctBooks(3000, 45_000)).toBe(28);
  });
  it("refreshes never-fetched books first, then the oldest, within the budget", () => {
    const at: Record<string, number> = { a: 500, b: 0, c: 100, d: 300, e: 0 };
    expect(pickBooksToRefresh(["a", "b", "c", "d", "e"], (s) => at[s]!, 3)).toEqual(["b", "e", "c"]);
    expect(pickBooksToRefresh(["a", "b"], (s) => at[s]!, 9)).toEqual(["b", "a"]);
    expect(pickBooksToRefresh(["a", "b"], (s) => at[s]!, 0)).toEqual([]);
  });
  it("rotating within the budget touches every book once before any twice", () => {
    const symbols = Array.from({ length: 20 }, (_, i) => `S${i}`);
    const at = new Map<string, number>();
    let clock = 1;
    const seen = new Set<string>();
    for (let cycle = 0; cycle < 3; cycle++) {
      for (const s of pickBooksToRefresh(symbols, (x) => at.get(x) ?? 0, 9)) {
        if (cycle < 2) expect(seen.has(s)).toBe(false);
        seen.add(s);
        at.set(s, clock++);
      }
    }
    expect(seen.size).toBe(20);
  });
});

describe("ComboRegistry", () => {
  function setup(opts: { url?: string | null; count?: number; saved?: ComboDef[]; active?: string[]; maxBooks?: number } = {}) {
    const feed = { rows: [] as unknown[], source: "registry", fail: false, calls: 0 };
    const fetchImpl = (async (url: string | URL | Request) => {
      feed.calls++;
      expect(String(url)).toBe("http://app.invalid/api/combos?requested=1");
      if (feed.fail) throw new Error("ECONNREFUSED");
      return new Response(JSON.stringify({ source: feed.source, combos: feed.rows }), { status: 200 });
    }) as typeof fetch;
    let stored = opts.saved ?? [];
    const store = { getCombos: () => stored, setCombos: (d: ComboDef[]) => void (stored = d) };
    const synced: string[][] = [];
    const sink = { marketSymbols: () => ["M1"], syncCombos: async (d: ComboDef[]) => void synced.push(d.map((x) => x.symbol)) };
    const active = new Set(opts.active ?? []);
    const reg = new ComboRegistry(
      opts.url === undefined ? "http://app.invalid" : opts.url,
      opts.count ?? 6,
      opts.maxBooks ?? 27,
      store,
      sink,
      () => active,
      fetchImpl,
      () => NOW_SEC * 1000,
    );
    return { feed, reg, synced, active, stored: () => stored };
  }

  it("tracks valid requested combos, skips invalid ones and persists the definitions", async () => {
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const t = setup();
    t.feed.rows = [
      rawCombo("VECTIS-CMB-1", ["A", "B"]),
      rawCombo("VECTIS-CMB-BAD", ["A", "B"], { marketId: marketIdOf("nope") }),
      rawCombo("VECTIS-CMB-2", ["B", "C", "D"]),
    ];
    await t.reg.tick();
    await t.reg.tick();
    expect(t.synced.at(-1)).toEqual(["VECTIS-CMB-1", "VECTIS-CMB-2"]);
    expect(t.stored().map((d) => d.legs.length)).toEqual([2, 3]);
    // invalid combo is logged once, not on every poll
    expect(quiet.mock.calls.filter((c) => String(c[0]).includes("skipping invalid combo"))).toHaveLength(1);
    quiet.mockRestore();
    info.mockRestore();
  });

  it("keeps a combo with an active position after it drops off the registry", async () => {
    const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const t = setup({ count: 1 });
    t.feed.rows = [rawCombo("VECTIS-CMB-OLD", ["A", "B"])];
    await t.reg.tick();
    t.active.add(marketIdOf("VECTIS-CMB-OLD"));
    t.feed.rows = [rawCombo("VECTIS-CMB-NEW", ["C", "D"])];
    await t.reg.tick();
    expect(t.synced.at(-1)).toEqual(["VECTIS-CMB-OLD"]); // count 1 is used up by the carried combo
    t.active.clear();
    await t.reg.tick();
    expect(t.synced.at(-1)).toEqual(["VECTIS-CMB-NEW"]);
    info.mockRestore();
  });

  it("survives a registry outage and a restart from saved state", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const saved = [def("VECTIS-CMB-S1", ["A", "B"]), def("VECTIS-CMB-S2", ["C", "D"])];
    const t = setup({ saved });
    t.feed.fail = true;
    await t.reg.tick();
    await t.reg.tick();
    expect(t.synced.at(-1)).toEqual(["VECTIS-CMB-S1", "VECTIS-CMB-S2"]);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("combo registry unavailable"))).toHaveLength(1);
    // source "none" with an empty list is also an outage, not "no combos"
    t.feed.fail = false;
    t.feed.source = "none";
    await t.reg.tick();
    expect(t.synced.at(-1)).toEqual(["VECTIS-CMB-S1", "VECTIS-CMB-S2"]);
    warn.mockRestore();
    info.mockRestore();
  });

  it("with no app URL prices only saved combos that still have a position, and never fetches", async () => {
    const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const saved = [def("VECTIS-CMB-S1", ["A", "B"]), def("VECTIS-CMB-S2", ["C", "D"])];
    const t = setup({ url: null, saved, active: [marketIdOf("VECTIS-CMB-S2")] });
    await t.reg.tick();
    expect(t.synced.at(-1)).toEqual(["VECTIS-CMB-S2"]);
    expect(t.feed.calls).toBe(0);
    info.mockRestore();
  });
});

describe("combo fills are always simulated", () => {
  const quote = { bid: 190_000n, ask: 213_400n };
  function fakeTrade(response: OrderResponse = { orderId: "1", status: "filled", filledQuantity: "1", avgExecutionPrice: "0.2" }) {
    const calls: OrderRequest[] = [];
    return { calls, placeOrder: async (o: OrderRequest) => (calls.push(o), response) };
  }

  it("tradeFor strips the trade client for combos, in live mode too", () => {
    const trade = fakeTrade();
    expect(tradeFor(trade, true)).toBeNull();
    expect(tradeFor(trade, false)).toBe(trade);
    expect(tradeFor(null, false)).toBeNull();
  });

  it("live mode: a combo open and close never reach Gemini and fill at the leg-derived ask / bid", async () => {
    const quiet = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const trade = fakeTrade();
    const open = await openFill(tradeFor(trade, true), 7n, "VECTIS-CMB-1", 0, 10_000_000n, quote);
    expect(open).toEqual({ price: 213_400n, contracts: 46_860_000n, source: "simulated" });
    const close = await closeFill(tradeFor(trade, true), 7n, "VECTIS-CMB-1", 0, open.contracts, quote);
    expect(close).toEqual({ price: 190_000n, contracts: 46_860_000n, source: "simulated" });
    expect(trade.calls).toEqual([]);
    // the same call for a single market does go to Gemini
    await openFill(tradeFor(trade, false), 8n, "GEMI-X", 0, 10_000_000n, quote);
    expect(trade.calls).toHaveLength(1);
    quiet.mockRestore();
  });

  it("handles side 1 with the usual conversion", async () => {
    const open = await openFill(null, 7n, "VECTIS-CMB-1", 1, 10_000_000n, quote);
    expect(open.price).toBe(810_000n); // 1 - bid
    const close = await closeFill(null, 7n, "VECTIS-CMB-1", 1, open.contracts, quote);
    expect(close.price).toBe(786_600n); // 1 - ask
  });

  it("a zero bid closes at price 0; an open never submits a zero price or zero contracts", async () => {
    const zero = { bid: 0n, ask: 0n };
    expect(await closeFill(null, 7n, "VECTIS-CMB-1", 0, 5_000_000n, zero)).toEqual({ price: 0n, contracts: 5_000_000n, source: "simulated" });
    await expect(openFill(null, 7n, "VECTIS-CMB-1", 0, 10_000_000n, zero)).rejects.toBeInstanceOf(SkipFill);
    // price fine but size too small for 0.01 contract
    await expect(openFill(null, 7n, "VECTIS-CMB-1", 0, 1_000n, quote)).rejects.toBeInstanceOf(SkipFill);
  });
});
