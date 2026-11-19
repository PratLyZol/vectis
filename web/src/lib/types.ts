// Compact market shapes served by /api/markets, /api/markets/[ticker] and /api/book/[symbol].
// Prices are YES-space integers scaled 1e6 (1_000_000 = $1.00), or null when Gemini has no quote.

export type DataSource = "gemini" | "fixture";

export type MarketContract = {
  symbol: string; // Gemini instrumentSymbol; marketId = keccak256(toBytes(symbol))
  label: string;
  ticker: string;
  open: boolean;
  expiry: string | null; // ISO
  yesBid: number | null;
  yesAsk: number | null;
  last: number | null;
};

export type MarketEvent = {
  id: string;
  ticker: string;
  title: string;
  slug: string;
  category: string;
  status: string;
  expiry: string | null; // ISO
  imageUrl: string | null;
  volume: number; // USD
  volume24h: number; // USD
  gameId?: string | null; // Gemini's id for the underlying game; events of one game share it
  contractCount: number;
  contracts: MarketContract[]; // lead contract first; the list endpoint trims this
};

export type MarketsResponse = {
  source: DataSource;
  events: MarketEvent[];
  total: number;
};

export type EventResponse = { source: DataSource; event: MarketEvent };

export type BookLevel = { price: number; amount: number }; // price 1e6 YES space, amount in contracts
export type BookResponse = { source: DataSource; bids: BookLevel[]; asks: BookLevel[] };

// ---------------------------------------------------------------------------------------------
// Hedge agent (/api/hedge). USDC amounts and prices are 1e6-scaled integers as plain numbers;
// leverage is in tenths (10 = 1x), as on-chain.

export type HedgeHolderType = "individual" | "small_business" | "fund" | "firm" | "other";
export type HedgeInstrumentClass =
  | "equity"
  | "crypto"
  | "commodity"
  | "rates_or_loan"
  | "fx"
  | "real_asset"
  | "operating_cost"
  | "revenue"
  | "event"
  | "other";
export type HedgeDirection = "long" | "short" | "cost" | "revenue" | "liability";

export type HedgeExposure = {
  holderType: HedgeHolderType;
  description: string;
  instrumentClass: HedgeInstrumentClass;
  direction: HedgeDirection;
  notionalUsd: number | null;
  horizon: string | null;
  adverseMove: string; // the move that hurts the holder, e.g. "natural gas prices rise"
};

export type HedgeLeg = {
  eventTicker: string;
  eventTitle: string;
  category: string;
  imageUrl: string | null;
  symbol: string;
  label: string;
  expiry: string | null;
  side: "yes" | "no";
  margin: number; // USDC 1e6
  leverage: number; // tenths
  price: number; // side ask 1e6 at quote time
  maxLeverage: number; // tenths at quote time
  rationale: string;
  hedgeMechanism: string; // how the leg pays when the adverse move happens
  basisRisk: "direct" | "proxy";
  basisRiskNote: string;
};

export type HedgeScenario = {
  name: string;
  description: string;
  winningSymbols: string[]; // legs (by symbol) that pay out in this scenario
};

export type HedgeProposal = {
  summary: string;
  exposure: HedgeExposure;
  horizonNote: string;
  legs: HedgeLeg[];
  scenarios: HedgeScenario[];
  warnings: string[];
  quotedAt: string; // ISO
  source: DataSource;
};

export type HedgeMessage = { role: "user" | "assistant"; content: string };

export type HedgeRequest = { messages: HedgeMessage[]; proposal?: HedgeProposal | null };

export type HedgeResponse =
  | { type: "question"; question: string }
  | { type: "proposal"; proposal: HedgeProposal }
  | { type: "error"; error: string };
