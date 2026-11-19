import { describe, expect, it } from "vitest";
import { buildProposal, clampLeverage, legPnl, proposalTotals, scenarioPnl } from "./validate";
import type { MarketEvent } from "../types";

const NOW = 1_800_000_000n;
const iso = (s: bigint) => new Date(Number(s) * 1000).toISOString();
const usd = (n: number) => Math.round(n * 1e6);

const brent: MarketEvent = {
  id: "1",
  ticker: "BRENT",
  title: "Oil (Brent) price?",
  slug: "brent",
  category: "Commodities",
  status: "active",
  expiry: iso(NOW + 86_400n * 3n),
  imageUrl: null,
  volume: 0,
  volume24h: 0,
  contractCount: 3,
  contracts: [
    { symbol: "B-91", label: "$91 or above", ticker: "91", open: true, expiry: iso(NOW + 86_400n * 3n), yesBid: usd(0.58), yesAsk: usd(0.6), last: null },
    { symbol: "B-95", label: "$95 or above", ticker: "95", open: false, expiry: iso(NOW + 86_400n * 3n), yesBid: usd(0.2), yesAsk: usd(0.25), last: null },
    { symbol: "B-99", label: "$99 or above", ticker: "99", open: true, expiry: iso(NOW + 1800n), yesBid: null, yesAsk: usd(0.08), last: null },
  ],
};
const fed: MarketEvent = {
  ...brent,
  id: "2",
  ticker: "FED",
  title: "Fed decision?",
  contracts: [
    { symbol: "F-HOLD", label: "Hold", ticker: "HOLD", open: true, expiry: iso(NOW + 86_400n * 20n), yesBid: usd(0.3), yesAsk: usd(0.32), last: null },
  ],
};

const leg = (over: Record<string, unknown>) => ({
  event_ticker: "BRENT",
  symbol: "B-91",
  side: "yes",
  margin_usdc: 50,
  leverage: 1,
  rationale: "r",
  hedge_mechanism: "m",
  basis_risk: "proxy",
  basis_risk_note: "n",
  ...over,
});

const build = (raw: unknown) => buildProposal({ raw, events: [brent, fed], nowSeconds: NOW, source: "fixture" });

describe("clampLeverage", () => {
  it("rounds down to 0.5x steps and clamps to [1x, max]", () => {
    expect(clampLeverage(27n, 50n)).toBe(25n);
    expect(clampLeverage(60n, 40n)).toBe(40n);
    expect(clampLeverage(3n, 50n)).toBe(10n);
  });
});

describe("buildProposal", () => {
  it("keeps a valid leg and recomputes price and max leverage from market data", () => {
    const p = build({ summary: "s", legs: [leg({ leverage: 2 })] });
    expect(p.legs).toHaveLength(1);
    expect(p.legs[0]!).toMatchObject({ symbol: "B-91", side: "yes", price: usd(0.6), leverage: 20, maxLeverage: 50, margin: usd(50) });
    expect(p.warnings).toEqual([]);
  });

  it("prices a No leg from the Yes bid", () => {
    const p = build({ legs: [leg({ side: "no" })] });
    expect(p.legs[0]!.price).toBe(usd(0.42));
  });

  it("clamps leverage above the limit and warns", () => {
    const p = build({ legs: [leg({ symbol: "F-HOLD", event_ticker: "FED", leverage: 5 })] });
    // 0.32 / 0.12 = 2.66 -> 2.5x
    expect(p.legs[0]!.leverage).toBe(25);
    expect(p.warnings.some((w) => w.includes("2.5x"))).toBe(true);
  });

  it("forces 1x inside the final hour before close", () => {
    const p = build({ legs: [leg({ symbol: "B-99", leverage: 3 })] });
    expect(p.legs[0]!.leverage).toBe(10);
  });

  it("drops unknown, closed and unquoted legs with a warning", () => {
    const p = build({
      legs: [leg({ symbol: "NOPE" }), leg({ symbol: "B-95" }), leg({ symbol: "B-99", side: "no" })],
    });
    expect(p.legs).toHaveLength(0);
    expect(p.warnings).toHaveLength(3);
  });

  it("finds a symbol paired with the wrong event", () => {
    const p = build({ legs: [leg({ event_ticker: "FED" })] });
    expect(p.legs[0]!.eventTicker).toBe("BRENT");
  });

  it("raises tiny margins to the minimum and dedupes legs", () => {
    const p = build({ legs: [leg({ margin_usdc: 0.2 }), leg({ margin_usdc: 9 })] });
    expect(p.legs).toHaveLength(1);
    expect(p.legs[0]!.margin).toBe(usd(1));
  });

  it("accepts margins written as strings", () => {
    expect(build({ legs: [leg({ margin_usdc: "$1,200" })] }).legs[0]!.margin).toBe(usd(1200));
  });

  it("caps the number of legs", () => {
    const legs = Array.from({ length: 8 }, (_, i) => leg({ side: i % 2 ? "no" : "yes", symbol: i < 2 ? "B-91" : "F-HOLD", event_ticker: i < 2 ? "BRENT" : "FED" }));
    const p = build({ legs });
    expect(p.legs.length).toBeLessThanOrEqual(6);
  });

  it("warns when there are no legs at all", () => {
    expect(build({ summary: "nothing", legs: [] }).warnings[0]).toMatch(/No listed market/);
  });

  it("keeps only scenario winners that are legs", () => {
    const p = build({ legs: [leg({})], scenarios: [{ name: "Spike", winning_symbols: ["B-91", "X"] }] });
    expect(p.scenarios[0]!.winningSymbols).toEqual(["B-91"]);
  });

  it("falls back on unknown enum values in the exposure", () => {
    const p = build({ exposure: { holder_type: "whale", direction: "sideways", adverse_move: "gas up", notional_usd: -5 } });
    expect(p.exposure).toMatchObject({ holderType: "other", direction: "long", adverseMove: "gas up", notionalUsd: null });
  });
});

describe("pnl figures", () => {
  const l = build({ legs: [leg({ margin_usdc: 60, leverage: 1 })] }).legs[0]!;
  it("a winning 1x leg pays contracts minus cost", () => {
    // 60 USDC at $0.60 = 100 contracts -> $100 payout, $40 profit
    expect(legPnl(l, true)).toBe(BigInt(usd(40)));
    expect(legPnl(l, false)).toBe(BigInt(-usd(60)));
  });
  it("sums scenarios and totals", () => {
    expect(scenarioPnl([l], { name: "s", description: "", winningSymbols: ["B-91"] })).toBe(BigInt(usd(40)));
    expect(proposalTotals([l]).total).toBe(BigInt(usd(60)));
  });
});
