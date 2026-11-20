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
  basisRisk: "direct" | "proxy"; // direct: the market is on the exposure itself
};

export type HedgeScenario = {
  name: string; // a few words, e.g. "Gas spikes"
  winningSymbols: string[]; // legs (by symbol) that pay out in this scenario
};

export type HedgeProposal = {
  hedgingAgainst: string; // the adverse move, e.g. "Natural gas prices rising"
  legs: HedgeLeg[];
  scenarios: HedgeScenario[];
  notes: string[]; // adjustments the server made, and the agent's note when nothing fits
  quotedAt: string; // ISO
  source: DataSource;
};

export type HedgeMessage = { role: "user" | "assistant"; content: string };

export type HedgeRequest = { messages: HedgeMessage[]; proposal?: HedgeProposal | null };

export type HedgeResponse =
  | { type: "question"; question: string }
  | { type: "proposal"; proposal: HedgeProposal }
  | { type: "error"; error: string };

// Streaming (/api/hedge with `Accept: text/event-stream`). Each step of the agent's tool loop is
// sent as it starts and again when it finishes (same id); the stream ends with one result.
// `label` and `detail` come from fixed server templates; the only outside text in them is the
// search keyword and identifiers or titles from Gemini data.
export type HedgeStepKind = "model" | "tool";

export type HedgeStepEvent = {
  id: number;
  phase: "start" | "done";
  kind: HedgeStepKind;
  tool?: string; // only when kind is "tool"
  label: string;
  detail?: string;
};

// A short piece of the model's reasoning for model step `id`, shown in the trace. Unlike labels
// this is model free text: plain text only, never rendered as HTML or markdown.
export type HedgeThoughtEvent = { id: number; text: string };

export type HedgeStreamEvent =
  | { event: "step"; data: HedgeStepEvent }
  | { event: "thought"; data: HedgeThoughtEvent }
  | { event: "result"; data: HedgeResponse };
