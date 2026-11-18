// Pure integer math mirroring MarginManager. All values are bigint.
// USDC: 6 decimals. Prices: 1e6 = $1.00. Contracts: 6 decimals. Leverage: tenths (10 = 1x).

export const ONE = 1_000_000n; // $1.00, one contract, one USDC
export const LEVERAGE_UNIT = 10n;
export const LEVERAGE_STEP = 5n;
export const MAX_LEVERAGE = 50n;
export const LEVERAGE_PRICE_DIVISOR = 120_000n; // $0.12
export const LIQ_BUFFER = 40_000n; // $0.04
export const DELEVERAGE_WINDOW = 3600n; // seconds
export const MIN_MARGIN = ONE; // 1 USDC
export const BPS = 10_000n;
export const OPEN_FEE_BPS = 100n; // 1% of the amount borrowed, paid to lenders when a position opens

export const SIDE_YES = 0;
export const SIDE_NO = 1;
export type Side = typeof SIDE_YES | typeof SIDE_NO;

/** Price a side pays to open. YES ask = ask; NO ask = 1e6 - YES bid. */
export function sideAsk(side: Side, yesBid: bigint, yesAsk: bigint): bigint {
  return side === SIDE_YES ? yesAsk : ONE - yesBid;
}

/** Price a side is marked and closed at. YES bid = bid; NO bid = 1e6 - YES ask. */
export function sideBid(side: Side, yesBid: bigint, yesAsk: bigint): bigint {
  return side === SIDE_YES ? yesBid : ONE - yesAsk;
}

/** Max leverage in tenths for a side-space price, ignoring time. */
export function maxLeverageForPrice(price: bigint): bigint {
  if (price <= 0n) return LEVERAGE_UNIT;
  const raw = (price * LEVERAGE_UNIT) / LEVERAGE_PRICE_DIVISOR;
  const stepped = (raw / LEVERAGE_STEP) * LEVERAGE_STEP;
  if (stepped > MAX_LEVERAGE) return MAX_LEVERAGE;
  if (stepped < LEVERAGE_UNIT) return LEVERAGE_UNIT;
  return stepped;
}

/** True inside the final hour before close (and after it). Times are unix seconds. */
export function inDeleverageWindow(now: bigint, closeTime: bigint): boolean {
  return closeTime > 0n && now + DELEVERAGE_WINDOW >= closeTime;
}

/** Max leverage in tenths at a price and time: 1x inside the final hour before close. */
export function maxLeverage(price: bigint, now: bigint, closeTime: bigint): bigint {
  if (inDeleverageWindow(now, closeTime)) return LEVERAGE_UNIT;
  return maxLeverageForPrice(price);
}

export function isValidLeverage(leverage: bigint, max: bigint): boolean {
  return leverage >= LEVERAGE_UNIT && leverage <= max && leverage % LEVERAGE_STEP === 0n;
}

/** ceil(borrowed * 1e6 / contracts) + LIQ_BUFFER. Zero when nothing is borrowed. */
export function liquidationPrice(borrowed: bigint, contracts: bigint): bigint {
  if (borrowed === 0n || contracts === 0n) return 0n;
  const num = borrowed * ONE;
  return (num + contracts - 1n) / contracts + LIQ_BUFFER;
}

/** Open fee on a borrowed amount: ceil(borrowed * OPEN_FEE_BPS / 10_000). Zero at 1x. */
export function openFee(borrowed: bigint): bigint {
  if (borrowed <= 0n) return 0n;
  return (borrowed * OPEN_FEE_BPS + BPS - 1n) / BPS;
}

/**
 * Open fee a position paid, from its posted margin and leverage (tenths). The fee is charged on
 * the borrow requested at open, margin * (leverage - 10) / 10, even if the fill later used less.
 */
export function positionOpenFee(margin: bigint, leverage: bigint): bigint {
  return openFee((margin * (leverage - LEVERAGE_UNIT)) / LEVERAGE_UNIT);
}

/** PnL after the open fee: the fee is paid on top of margin and is in neither cost nor payout. */
export function netPnl(grossPnl: bigint, margin: bigint, leverage: bigint): bigint {
  return grossPnl - positionOpenFee(margin, leverage);
}

export type OpenPreview = {
  size: bigint; // USDC
  borrowed: bigint; // USDC
  contracts: bigint; // 6 decimals
  liqPrice: bigint; // side space, 0 = none
  refPrice: bigint; // side ask used
  payoutIfWin: bigint; // contracts x $1 - borrowed
  maxLoss: bigint; // the margin
  fee: bigint; // open fee on the borrowed amount, paid to the vault on top of the margin
  total: bigint; // what openPosition pulls from the trader: margin + fee
};

/** What openPosition does at a side-space ask price. */
export function previewOpen(margin: bigint, leverage: bigint, price: bigint): OpenPreview {
  const size = (margin * leverage) / LEVERAGE_UNIT;
  const borrowed = size - margin;
  const contracts = price > 0n ? (size * ONE) / price : 0n;
  const liqPrice = liquidationPrice(borrowed, contracts);
  const payoutIfWin = contracts > borrowed ? contracts - borrowed : 0n;
  const fee = openFee(borrowed);
  return { size, borrowed, contracts, liqPrice, refPrice: price, payoutIfWin, maxLoss: margin, fee, total: margin + fee };
}

/** USDC value of a contract quantity at a price. */
export function notional(contracts: bigint, price: bigint): bigint {
  return (contracts * price) / ONE;
}

/** Health in bps: (mark - liq) / (entry - liq), clamped to [0, 10000]. 10000 when unborrowed. */
export function healthBps(mark: bigint, entry: bigint, liqPrice: bigint, borrowed: bigint): bigint {
  if (borrowed === 0n || liqPrice === 0n) return BPS;
  if (mark <= liqPrice) return 0n;
  if (entry <= liqPrice) return BPS;
  const h = ((mark - liqPrice) * BPS) / (entry - liqPrice);
  return h > BPS ? BPS : h;
}

/** Unrealised PnL in USDC: value at the side bid minus what the fill cost. */
export function unrealisedPnl(contracts: bigint, mark: bigint, cost: bigint): bigint {
  return notional(contracts, mark) - cost;
}

/** What the owner receives on a close fill, and the vault's loss. */
export function settle(contracts: bigint, exitPrice: bigint, borrowed: bigint) {
  const proceeds = notional(contracts, exitPrice);
  const repaid = proceeds < borrowed ? proceeds : borrowed;
  return { proceeds, repaid, loss: borrowed - repaid, payout: proceeds - repaid };
}

// ---------------------------------------------------------------------------------------------
// Combos. A combo wins only if every leg wins, so it is priced as the product of its legs.

export type ComboLegQuote = {
  outcome: "yes" | "no"; // the outcome the leg must have
  yesBid: bigint | null; // YES-space best bid of the leg contract, null when there is none
  yesAsk: bigint | null; // YES-space best ask of the leg contract, null when there is none
};

/**
 * YES-space quote of a combo from its legs' quotes. Each leg is converted to its required side
 * (Yes: bid, ask; No: 1 - ask, 1 - bid). Bid = product of side bids rounded down to the
 * micro-dollar; ask = product of side asks rounded up; then 0 <= bid <= ask <= 1e6.
 * null when a leg has no side ask (the combo cannot be priced). A leg with no side bid makes the
 * combo bid 0.
 */
export function comboQuote(legs: ComboLegQuote[]): { bid: bigint; ask: bigint } | null {
  if (legs.length === 0) return null;
  let bidProduct = 1n;
  let askProduct = 1n;
  let hasBid = true;
  for (const leg of legs) {
    const legBid = leg.outcome === "yes" ? leg.yesBid : leg.yesAsk === null ? null : ONE - leg.yesAsk;
    const legAsk = leg.outcome === "yes" ? leg.yesAsk : leg.yesBid === null ? null : ONE - leg.yesBid;
    if (legAsk === null || legAsk < 0n || legAsk > ONE) return null;
    if (legBid === null || legBid <= 0n) hasBid = false;
    else bidProduct *= legBid > ONE ? ONE : legBid;
    askProduct *= legAsk;
  }
  const scale = ONE ** BigInt(legs.length - 1);
  let ask = (askProduct + scale - 1n) / scale; // round up
  let bid = hasBid ? bidProduct / scale : 0n; // round down
  if (ask > ONE) ask = ONE;
  if (bid > ask) bid = ask;
  return { bid, ask };
}
