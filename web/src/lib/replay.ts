// Replay of a hypothetical Vectis position on a market's real price history. The position is
// opened and settled with the same integer rules the contracts use (see math.ts), so the liquidation
// price, the fee and the payout are what the protocol would have produced at those prices.
import { ONE, SIDE_YES, maxLeverageForPrice, notional, previewOpen, settle, type OpenPreview, type Side } from "./math";

/** [unix seconds, open, high, low, close] in YES space, 1e6 = $1. Oldest first. */
export type Candle = [number, number, number, number, number];
export type CandlesResponse = { symbol: string; source: "gemini" | "snapshot"; candles: Candle[] };

/** A market offered on the replay page. `day` is set when its history is a saved snapshot. */
export type ReplayMarket = { symbol: string; title: string; label: string; day?: string };

export type SideBar = { t: number; open: number; high: number; low: number; close: number };

/** A bar in the position's own side: a NO bar is the YES bar mirrored around $1. */
export function sideBar(c: Candle, side: Side): SideBar {
  const [t, open, high, low, close] = c;
  if (side === SIDE_YES) return { t, open, high, low, close };
  const one = Number(ONE);
  return { t, open: one - open, high: one - low, low: one - high, close: one - close };
}

export type StepStatus = "before" | "open" | "liquidated" | "closed";
export type Step = {
  status: StepStatus;
  mark: number; // side-space close of the bar
  equity: bigint; // what the position would pay out if sold at the mark
  pnl: bigint; // equity - margin - open fee
  pnl1x: bigint; // the same margin spent with no loan
};

export type Sim = {
  side: Side;
  leverage: bigint; // tenths, after the price cap
  maxLeverage: bigint;
  margin: bigint;
  open: OpenPreview;
  entryIndex: number;
  endIndex: number;
  outcome: "liquidated" | "closed";
  exitPrice: bigint;
  payout: bigint;
  vaultLoss: bigint;
  pnl: bigint;
  steps: Step[];
};

/**
 * Open at the close of bar `entryIndex` and hold. A bar whose low reaches the liquidation price
 * sells the position: at the liquidation price, or at the bar's close when the bar ends below it
 * (the price jumped past and the keeper sold into what was left). Otherwise the position is sold
 * at the last bar's close. The final-hour step-down to 1x is not modelled.
 */
export function simulate(candles: Candle[], side: Side, leverage: bigint, entryIndex: number, margin: bigint): Sim | null {
  const first = candles[entryIndex];
  if (!first || entryIndex >= candles.length - 1) return null;
  const entry = BigInt(sideBar(first, side).close);
  if (entry <= 0n || entry >= ONE) return null;

  const max = maxLeverageForPrice(entry);
  const lev = leverage > max ? max : leverage;
  const open = previewOpen(margin, lev, entry);
  const flat = (margin * ONE) / entry; // contracts at 1x

  const steps: Step[] = [];
  let endIndex = candles.length - 1;
  let outcome: Sim["outcome"] = "closed";
  let exitPrice = 0n;
  let final: Step | null = null;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (!c) continue;
    const bar = sideBar(c, side);
    const mark = BigInt(bar.close);
    const pnl1x = i < entryIndex ? 0n : notional(flat, mark) - margin;

    if (i < entryIndex) {
      steps.push({ status: "before", mark: bar.close, equity: margin, pnl: 0n, pnl1x });
      continue;
    }
    if (final) {
      steps.push({ ...final, mark: bar.close, pnl1x });
      continue;
    }

    const hit = i > entryIndex && open.liqPrice > 0n && BigInt(bar.low) <= open.liqPrice;
    const last = i === candles.length - 1;
    if (hit || last) {
      exitPrice = hit && mark > open.liqPrice ? open.liqPrice : mark;
      const s = settle(open.contracts, exitPrice, open.borrowed);
      final = { status: hit ? "liquidated" : "closed", mark: bar.close, equity: s.payout, pnl: s.payout - margin - open.fee, pnl1x };
      outcome = hit ? "liquidated" : "closed";
      endIndex = i;
      steps.push(final);
      continue;
    }

    const value = notional(open.contracts, mark);
    const equity = value > open.borrowed ? value - open.borrowed : 0n;
    steps.push({ status: "open", mark: bar.close, equity, pnl: equity - margin - open.fee, pnl1x });
  }

  const s = settle(open.contracts, exitPrice, open.borrowed);
  return {
    side,
    leverage: lev,
    maxLeverage: max,
    margin,
    open,
    entryIndex,
    endIndex,
    outcome,
    exitPrice,
    payout: s.payout,
    vaultLoss: s.loss,
    pnl: s.payout - margin - open.fee,
    steps,
  };
}

export type Scenario = { side: Side; leverage: bigint; entryIndex: number };

/**
 * Search this market's history for an entry worth showing, at the highest leverage the price
 * allowed. "gain": the leveraged position that made the most. "liquidation": a position that was
 * liquidated, preferring one where the same trade at 1x ended ahead, then the longest held.
 */
export function findScenario(candles: Candle[], kind: "gain" | "liquidation", margin: bigint): Scenario | null {
  const stride = Math.max(1, Math.floor(candles.length / 120));
  let best: { score: number; scenario: Scenario } | null = null;
  for (const side of [0, 1] as Side[]) {
    for (let i = 0; i < candles.length - 2; i += stride) {
      const c = candles[i];
      if (!c) continue;
      const max = maxLeverageForPrice(BigInt(sideBar(c, side).close));
      if (max <= 10n) continue;
      const sim = simulate(candles, side, max, i, margin);
      if (!sim) continue;
      let score: number;
      if (kind === "gain") {
        if (sim.outcome !== "closed" || sim.pnl <= 0n) continue;
        score = Number(sim.pnl);
      } else {
        if (sim.outcome !== "liquidated") continue;
        const flatEnd = Number(sim.steps[sim.steps.length - 1]?.pnl1x ?? 0n);
        score = flatEnd + (sim.endIndex - i) * 1000;
      }
      if (!best || score > best.score) best = { score, scenario: { side, leverage: sim.leverage, entryIndex: i } };
    }
  }
  return best?.scenario ?? null;
}
