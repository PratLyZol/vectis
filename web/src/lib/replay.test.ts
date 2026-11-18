import { describe, expect, it } from "vitest";
import { SIDE_NO, SIDE_YES } from "./math";
import { findScenario, simulate, type Candle } from "./replay";

const usd = (n: number) => Math.round(n * 1e6);
/** Flat bars at each close; the bar's open is the previous close. */
const bars = (closes: number[]): Candle[] =>
  closes.map((c, i) => {
    const o = closes[i - 1] ?? c;
    return [i * 60, usd(o), usd(Math.max(o, c)), usd(Math.min(o, c)), usd(c)];
  });
const MARGIN = 100_000_000n;

describe("simulate", () => {
  it("holds to the last bar and pays contracts x price - loan", () => {
    const sim = simulate(bars([0.6, 0.62, 0.66, 0.72]), SIDE_YES, 30n, 0, MARGIN);
    expect(sim?.outcome).toBe("closed");
    // 300 USDC at $0.60 = 500 contracts; 500 x 0.72 = 360; minus 200 borrowed = 160; fee 2.
    expect(sim?.payout).toBe(160_000_000n);
    expect(sim?.pnl).toBe(58_000_000n);
    expect(sim?.steps[3]?.pnl1x).toBe(20_000_000n - 1n); // 166.666666 contracts, rounded down
  });

  it("liquidates at the liquidation price when the bar closes above it", () => {
    // 3x at $0.60: liquidation at 0.40 + 0.04 = $0.44. The bar dips to 0.43 and closes at 0.50.
    const candles = bars([0.6, 0.55, 0.5, 0.5]);
    candles[2] = [120, usd(0.55), usd(0.55), usd(0.43), usd(0.5)];
    const sim = simulate(candles, SIDE_YES, 30n, 0, MARGIN);
    expect(sim?.outcome).toBe("liquidated");
    expect(sim?.endIndex).toBe(2);
    expect(sim?.exitPrice).toBe(440_000n);
    expect(sim?.vaultLoss).toBe(0n);
    expect(sim?.payout).toBe(20_000_000n);
  });

  it("books a vault loss when the price jumps past the loan", () => {
    // 5x at $0.60 borrows $0.48 a contract; a jump to $0.30 leaves 18 cents a contract unpaid.
    const sim = simulate(bars([0.6, 0.6, 0.3, 0.3]), SIDE_YES, 50n, 0, MARGIN);
    expect(sim?.outcome).toBe("liquidated");
    expect(sim?.exitPrice).toBe(300_000n);
    expect(sim?.payout).toBe(0n);
    expect(sim?.vaultLoss).toBeGreaterThan(149_000_000n);
    expect(sim?.pnl).toBe(-MARGIN - 4_000_000n);
  });

  it("mirrors the bars for NO and caps leverage by price", () => {
    // YES at 0.80 is NO at 0.20: one twelfth-of-a-dollar step allows 1.5x.
    const sim = simulate(bars([0.8, 0.7, 0.6]), SIDE_NO, 50n, 0, MARGIN);
    expect(sim?.leverage).toBe(15n);
    expect(sim?.open.refPrice).toBe(200_000n);
    expect(sim?.outcome).toBe("closed");
    expect(sim!.pnl > 0n).toBe(true);
  });

  it("never liquidates at 1x", () => {
    const sim = simulate(bars([0.6, 0.1, 0.05]), SIDE_YES, 10n, 0, MARGIN);
    expect(sim?.outcome).toBe("closed");
    expect(sim?.vaultLoss).toBe(0n);
  });
});

describe("findScenario", () => {
  const candles = bars([0.5, 0.5, 0.3, 0.3, 0.5, 0.7, 0.9, 0.9]);
  it("finds a gain and a liquidation in the same history", () => {
    const gain = findScenario(candles, "gain", MARGIN);
    const liq = findScenario(candles, "liquidation", MARGIN);
    expect(gain && simulate(candles, gain.side, gain.leverage, gain.entryIndex, MARGIN)!.pnl > 0n).toBe(true);
    expect(liq && simulate(candles, liq.side, liq.leverage, liq.entryIndex, MARGIN)!.outcome).toBe("liquidated");
  });
  it("returns null for a flat market", () => {
    expect(findScenario(bars([0.5, 0.5, 0.5, 0.5]), "liquidation", MARGIN)).toBeNull();
  });
});
