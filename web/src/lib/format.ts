import { formatUnits, parseUnits } from "viem";
import { WALLET_ACCESS_MESSAGE, isUnauthorized } from "./walletAccess";

const group = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** Fixed-point bigint (6 decimals) to a grouped decimal string, rounded down to `dp` places. */
export function fmtUnits6(value: bigint, dp = 2): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const cut = 10n ** BigInt(6 - dp);
  const s = formatUnits((abs / cut) * cut, 6);
  const [whole = "0", frac = ""] = s.split(".");
  const out = dp > 0 ? `${group(whole)}.${frac.padEnd(dp, "0").slice(0, dp)}` : group(whole);
  return neg ? `-${out}` : out;
}

/** USDC amount, e.g. "1,234.56". */
export const fmtUsdc = (value: bigint, dp = 2) => fmtUnits6(value, dp);

/** Signed USDC amount, e.g. "+12.40" or "-3.10". */
export const fmtSigned = (value: bigint) => (value > 0n ? `+${fmtUnits6(value)}` : fmtUnits6(value));

/** Signed dollar amount, e.g. "+$12.40" or "-$3.10". */
export function fmtSignedUsd(value: bigint): string {
  const sign = value > 0n ? "+" : value < 0n ? "-" : "";
  return sign + "$" + fmtUnits6(value < 0n ? -value : value);
}

/** 1e6 price as dollars: "$0.60", or three places when it is not a whole cent. */
export function fmtPrice(price: bigint | number | null | undefined): string {
  if (price === null || price === undefined) return "n/a";
  const p = BigInt(price);
  return `$${fmtUnits6(p, p % 10_000n === 0n ? 2 : 3)}`;
}

/** 1e6 price in cents for compact quotes: "60¢". */
export function fmtCents(price: number | null | undefined): string {
  if (price === null || price === undefined) return "n/a";
  const cents = price / 10_000;
  return `${Number.isInteger(cents) ? cents : cents.toFixed(1)}¢`;
}

export const fmtContracts = (value: bigint) => fmtUnits6(value, 2);

/** Leverage tenths to "2.5x". */
export function fmtLeverage(tenths: bigint | number): string {
  const t = Number(tenths);
  return `${t % 10 === 0 ? t / 10 : (t / 10).toFixed(1)}x`;
}

export function fmtCompactUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}K`;
  return `$${Math.round(n)}`;
}

export const fmtPercentBps = (bps: bigint | number, dp = 1) => `${(Number(bps) / 100).toFixed(dp)}%`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Fixed UTC wording so server and browser render the same text: "16 Nov, 02:30 UTC". */
export function fmtCloseTime(iso: string | null | undefined): string {
  if (!iso) return "No close time";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "No close time";
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${hh}:${mm} UTC`;
}

/** Parse a user-typed USDC amount. null when empty, malformed, or finer than 6 decimals. */
export function parseUsdc(input: string): bigint | null {
  const s = input.trim().replace(/,/g, "");
  if (s === "" || s === "." || !/^\d*\.?\d{0,6}$/.test(s)) return null;
  try {
    return parseUnits(s, 6);
  } catch {
    return null;
  }
}

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const shortHash = (h: string) => `${h.slice(0, 10)}…`;

export const unixSeconds = (iso: string | null | undefined): bigint => {
  if (!iso) return 0n;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0n : BigInt(Math.floor(t / 1000));
};

/** A short, plain message from a wallet or RPC error. */
export function errorMessage(e: unknown): string {
  // The wallet has not authorised this site or account (4100): say what to do, not the raw text.
  if (isUnauthorized(e)) return WALLET_ACCESS_MESSAGE;
  if (typeof e === "object" && e !== null) {
    const o = e as { shortMessage?: unknown; message?: unknown };
    if (typeof o.shortMessage === "string") return o.shortMessage;
    if (typeof o.message === "string") return o.message.split("\n")[0] ?? "Something went wrong.";
  }
  return "Something went wrong.";
}
