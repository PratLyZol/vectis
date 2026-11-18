// Pure price and quantity maths. No I/O; everything here is unit-tested.
import { keccak256, toBytes, type Hex } from "viem";

/** 1e6 = $1.00 for prices, one contract for quantities. */
export const ONE = 1_000_000n;
/** Gemini quantity increment: 0.01 contract in 6-decimal units. */
export const QTY_STEP = 10_000n;

export type Side = 0 | 1; // 0 = YES, 1 = NO
export type Rounding = "down" | "up";

export interface Quote {
  /** YES-space best bid, 1e6 scale. */
  bid: bigint;
  /** YES-space best ask, 1e6 scale. */
  ask: bigint;
}

export function marketIdOf(instrumentSymbol: string): Hex {
  return keccak256(toBytes(instrumentSymbol));
}

/**
 * Decimal-dollar value ("0.515", 0.9, "1") to micro-dollars, rounding sub-micro digits in the
 * given direction. Returns null for missing, malformed or negative input. String maths, no floats.
 */
export function toMicro(value: string | number | null | undefined, rounding: Rounding): bigint | null {
  if (value === null || value === undefined) return null;
  let s = typeof value === "number" ? numberToPlain(value) : value.trim();
  if (s === null || !/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return null;
  const [intPart = "", fracPart = ""] = s.split(".");
  const kept = fracPart.slice(0, 6).padEnd(6, "0");
  const rest = fracPart.slice(6);
  let micro = BigInt(intPart === "" ? "0" : intPart) * ONE + BigInt(kept);
  if (rounding === "up" && /[1-9]/.test(rest)) micro += 1n;
  return micro;
}

function numberToPlain(n: number): string | null {
  if (!Number.isFinite(n) || n < 0) return null;
  // toFixed avoids exponent notation; 12 digits is far below float noise for 0..1 prices.
  return n.toFixed(12);
}

/** Micro-dollars or 6-decimal quantity to a plain decimal string without trailing zeros. */
export function microToDecimal(micro: bigint): string {
  const whole = micro / ONE;
  const frac = (micro % ONE).toString().padStart(6, "0").replace(/0+$/, "");
  return frac === "" ? whole.toString() : `${whole}.${frac}`;
}

/**
 * Build an oracle quote from raw YES-space bid/ask strings: bid rounded down, ask rounded up,
 * clamped so that 0 <= bid <= ask <= 1e6. Null when either side is missing or malformed.
 */
export function buildQuote(
  rawBid: string | number | null | undefined,
  rawAsk: string | number | null | undefined,
): Quote | null {
  const b = toMicro(rawBid, "down");
  const a = toMicro(rawAsk, "up");
  if (b === null || a === null) return null;
  return clampQuote(b, a);
}

export function clampQuote(bid: bigint, ask: bigint): Quote {
  let a = ask > ONE ? ONE : ask < 0n ? 0n : ask;
  let b = bid < 0n ? 0n : bid > ONE ? ONE : bid;
  if (b > a) b = a; // crossed book: never post bid above ask
  return { bid: b, ask: a };
}

/** Price at which `side` can be bought (YES ask, or 1 - YES bid for NO). */
export function sideAsk(q: Quote, side: Side): bigint {
  return side === 0 ? q.ask : ONE - q.bid;
}

/** Price at which `side` can be sold (YES bid, or 1 - YES ask for NO). */
export function sideBid(q: Quote, side: Side): bigint {
  return side === 0 ? q.bid : ONE - q.ask;
}

export function toSide(n: number | bigint): Side {
  const v = Number(n);
  if (v !== 0 && v !== 1) throw new Error(`invalid side ${v}`);
  return v;
}

/** ceil(contracts * price / 1e6): USDC cost of a fill, rounded against the buyer. */
export function fillCost(contracts: bigint, price: bigint): bigint {
  return (contracts * price + ONE - 1n) / ONE;
}

/**
 * Contracts purchasable with `size` USDC (6 decimals) at `fillPrice` (side space, 1e6), rounded
 * down to 0.01 contract, such that the rounded-up cost never exceeds `size`. Zero if nothing fits.
 */
export function contractsForSize(size: bigint, fillPrice: bigint): bigint {
  if (size <= 0n || fillPrice <= 0n) return 0n;
  let contracts = (size * ONE) / fillPrice;
  contracts -= contracts % QTY_STEP;
  while (contracts > 0n && fillCost(contracts, fillPrice) > size) contracts -= QTY_STEP;
  return contracts < 0n ? 0n : contracts;
}

/** Round a 6-decimal quantity down to the 0.01-contract step. */
export function floorToStep(contracts: bigint): bigint {
  return contracts - (contracts % QTY_STEP);
}

/** Quantity-weighted price of two partial fills, rounded down. */
export function blendPrice(qtyA: bigint, priceA: bigint, qtyB: bigint, priceB: bigint): bigint {
  const total = qtyA + qtyB;
  if (total === 0n) return 0n;
  return (qtyA * priceA + qtyB * priceB) / total;
}

/** YES-space top of book for one contract; null = that side of the book is empty. */
export interface Top {
  bid: bigint | null;
  ask: bigint | null;
}

export interface ComboLegQuote extends Top {
  /** The side of the leg the combo needs to win. */
  outcome: "yes" | "no";
}

const clampUnit = (v: bigint): bigint => (v < 0n ? 0n : v > ONE ? ONE : v);

/** A leg's YES-space top of book in the leg's required side: yes = (bid, ask); no = (1 - ask, 1 - bid). */
export function legSideTop(leg: ComboLegQuote): Top {
  const bid = leg.bid === null ? null : clampUnit(leg.bid);
  const ask = leg.ask === null ? null : clampUnit(leg.ask);
  return leg.outcome === "yes" ? { bid, ask } : { bid: ask === null ? null : ONE - ask, ask: bid === null ? null : ONE - bid };
}

/**
 * Leg-derived combo quote. A combo pays only if every leg wins, so its price is the product of
 * the legs' side prices: bid = product of side bids rounded down, ask = product of side asks
 * rounded up (exact bigint maths, one division at the end), clamped to 0 <= bid <= ask <= 1e6.
 * Any leg without a side ask: null (do not post; the price goes stale and blocks new opens).
 * Any leg without a side bid: combo bid = 0.
 */
export function comboQuote(legs: ComboLegQuote[]): Quote | null {
  if (legs.length === 0) return null;
  let bidProduct: bigint | null = 1n;
  let askProduct = 1n;
  for (const leg of legs) {
    const side = legSideTop(leg);
    if (side.ask === null) return null;
    askProduct *= side.ask;
    bidProduct = bidProduct === null || side.bid === null ? null : bidProduct * side.bid;
  }
  const scale = ONE ** BigInt(legs.length - 1);
  const bid = bidProduct === null ? 0n : bidProduct / scale;
  const ask = (askProduct + scale - 1n) / scale;
  return clampQuote(bid, ask);
}
