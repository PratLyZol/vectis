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
