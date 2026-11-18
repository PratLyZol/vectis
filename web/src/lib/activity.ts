// Shapes served by /api/activity and the plain-words wording of each event.
import { fmtContracts, fmtLeverage, fmtPrice, fmtUsdc } from "./format";

export type ActivityEvent = {
  seq: number;
  id: string;
  blockNumber: number;
  txHash: string | null; // null for demo rows, which never touched a chain
  logIndex: number;
  address: string;
  eventName: string;
  positionId: string | null;
  owner: string | null;
  marketId: string | null;
  args: Record<string, unknown>;
  receivedAt: string; // ISO
};

export type ActivitySource = "quicknode-stream" | "none";
export type ActivityResponse = { source: ActivitySource; events: ActivityEvent[]; cursor: number };

/** Events that change a position's on-chain state; a new one means position reads are stale. */
export const POSITION_EVENTS = new Set([
  "PositionOpened",
  "FillRecorded",
  "PositionClosed",
  "PositionLiquidated",
  "PositionSettled",
]);

const big = (v: unknown): bigint | null => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  return null;
};

const usdc = (v: unknown) => {
  const n = big(v);
  return n === null ? "an unknown amount of" : fmtUsdc(n);
};
const price = (v: unknown) => {
  const n = big(v);
  return n === null ? "an unknown price" : fmtPrice(n);
};

/** One event in plain words, e.g. "Opened 3x YES" or "Settled, paid out 12.40 USDC". */
export function describeActivity(eventName: string, args: Record<string, unknown>): string {
  switch (eventName) {
    case "PositionOpened": {
      const lev = big(args.leverage);
      const side = Number(args.side) === 1 ? "NO" : "YES";
      return `Opened ${lev !== null ? `${fmtLeverage(lev)} ` : ""}${side} with ${usdc(args.margin)} USDC margin`;
    }
    case "FillRecorded": {
      const contracts = big(args.contracts);
      return `Filled ${contracts !== null ? fmtContracts(contracts) : "an unknown number of"} contracts at ${price(args.entryPrice)}`;
    }
    case "PositionClosed":
      return "Close requested";
    case "PositionLiquidated":
      return Number(args.reason) === 1
        ? `Deleveraged before the close at ${price(args.markPrice)}`
        : `Liquidated at ${price(args.markPrice)}`;
    case "PositionSettled":
      return `Settled at ${price(args.exitPrice)}, paid out ${usdc(args.payout)} USDC`;
    case "OpenFeePaid":
      return `Paid a ${usdc(args.fee)} USDC open fee to lenders`;
    case "FeeCollected":
      return `Vault collected ${usdc(args.amount)} USDC in open fees`;
    case "Deposit":
      return `Deposited ${usdc(args.assets)} USDC in the vault`;
    case "Withdraw":
      return `Withdrew ${usdc(args.assets)} USDC from the vault`;
    case "Borrowed":
      return `Vault lent ${usdc(args.amount)} USDC`;
    case "Repaid": {
      const loss = big(args.loss);
      return `Vault was repaid ${usdc(args.amount)} USDC${loss !== null && loss > 0n ? `, with a ${fmtUsdc(loss)} USDC loss` : ""}`;
    }
    default:
      return eventName;
  }
}

/** "just now", "42s ago", "5m ago", "3h ago", "2d ago". */
export function relativeTime(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.floor((nowMs - then) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}
