import type { Hex } from "viem";
import type { Side } from "./math";

export const STATUS = { None: 0, PendingOpen: 1, Open: 2, PendingClose: 3, Closed: 4 } as const;
export type Status = (typeof STATUS)[keyof typeof STATUS];

/** One position, in the contract's units, from the chain or from the demo store. */
export type PositionView = {
  id: bigint;
  marketId: Hex;
  side: Side;
  status: Status;
  liquidated: boolean;
  margin: bigint;
  leverage: bigint; // tenths
  borrowed: bigint;
  cost: bigint;
  entryPrice: bigint; // side space; 0 until the open fill
  contracts: bigint;
  liqPrice: bigint;
  openedAt: bigint; // unix seconds
  refPrice?: bigint; // side ask at open, known for demo positions
  exitPrice?: bigint; // known once settled, when available
  payout?: bigint;
  settledDebt?: bigint; // vault debt at the close fill (repaid + loss)
};

/** What the UI needs to name a market, keyed by marketId in the browser. */
export type MarketMeta = {
  symbol: string;
  eventTicker: string;
  title: string;
  label: string;
  expiry: string | null;
  imageUrl?: string | null; // Gemini's event image, when the market has one
  kind?: "combo"; // a combo: `symbol` is the combo symbol and `title` its label
};

export type YesQuote = { yesBid: bigint; yesAsk: bigint };

export const isActive = (s: Status) =>
  s === STATUS.PendingOpen || s === STATUS.Open || s === STATUS.PendingClose;

export function statusLabel(p: Pick<PositionView, "status" | "liquidated">): string {
  switch (p.status) {
    case STATUS.PendingOpen:
      return "Pending open";
    case STATUS.Open:
      return "Open";
    case STATUS.PendingClose:
      return p.liquidated ? "Liquidating" : "Pending close";
    case STATUS.Closed:
      return p.liquidated ? "Liquidated" : "Closed";
    default:
      return "Unknown";
  }
}
