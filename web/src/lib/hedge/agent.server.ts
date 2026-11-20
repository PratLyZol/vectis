// Server only: imported by app/api/hedge/route.ts. The hedge agent turns a plain-English
// description of any exposure into proposed prediction-market positions. It runs a tool loop
// against Venice AI (OpenAI-compatible chat completions) over read-only Gemini market data, and
// ends when the model calls `ask_user` or `propose_hedge`. Nothing here touches the chain.
import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { getBook, getEvent, getMarkets, isSafeId } from "../gemini";
import { unixSeconds } from "../format";
import { maxLeverage, previewOpen } from "../math";
import type {
  BookResponse,
  DataSource,
  EventResponse,
  HedgeMessage,
  HedgeProposal,
  HedgeResponse,
  HedgeStepEvent,
  HedgeThoughtEvent,
  MarketEvent,
  MarketsResponse,
} from "../types";
import { buildProposal, clampLeverage, contractAsk } from "./validate";

export const MAX_STEPS = 10;
/** Wall-clock budget for the whole loop; the route's maxDuration leaves headroom above it. */
export const AGENT_DEADLINE_MS = 75_000;
const MAX_CALL_MS = 35_000; // per model attempt; two must fit in AGENT_DEADLINE_MS
const MIN_CALL_MS = 5_000;
const OUT_OF_TIME: HedgeResponse = {
  type: "error",
  error: "The agent ran out of time before proposing a hedge. Try a more specific request.",
};
const MAX_TOOL_RESULT_CHARS = 24_000;

export type MarketData = {
  getMarkets: (q: { search?: string; category?: string; limit?: number }) => Promise<MarketsResponse>;
  getEvent: (ticker: string) => Promise<EventResponse | null>;
  getBook: (symbol: string) => Promise<BookResponse | null>;
};

export const geminiData: MarketData = { getMarkets, getEvent, getBook };

export type ChatClient = {
  chat: {
    completions: {
      create: (params: ChatCompletionCreateParamsNonStreaming, options?: { timeout?: number; maxRetries?: number }) => Promise<ChatCompletion>;
    };
  };
};

export type AgentDeps = {
  client: ChatClient | OpenAI;
  model: string;
  reasoningEffort?: "low" | "medium" | "high";
  data?: MarketData;
  now?: () => Date;
  deadlineMs?: number; // wall-clock budget for the whole loop
  /** Progress of the loop, for streaming. Called synchronously; a listener that throws is ignored. */
  onEvent?: (e: HedgeStepEvent) => void;
  /** A short piece of the model's reasoning per model step, for the trace. Same rules as onEvent. */
  onThought?: (t: HedgeThoughtEvent) => void;
};

// ---------------------------------------------------------------------------------------------
// Prompt

export function systemPrompt(now: Date): string {
  return `You are Vectis's hedging agent. Vectis trades Gemini prediction markets: binary contracts that pay $1 if they resolve Yes and $0 otherwise, bought on the Yes or No side, optionally with leverage from a lending vault. Today is ${now.toISOString().slice(0, 10)} (UTC).

Anyone may ask you for a hedge: individuals, small businesses, funds, VCs, firms. The exposure can be anything: long or short positions in any market, crypto, equities, commodities, business costs or revenues, loans and leverage, real assets, FX, rates, events. Your job is to find Gemini positions whose payoff rises when the thing that hurts the user happens, and propose them.

Process:
1. Work out the exposure: what it is, its direction (long / short / cost / revenue / liability), its size, its horizon and the ADVERSE MOVE (the outcome that hurts the user).
2. If the budget or size, the direction, or a detail that decides which market fits (a city for weather, which asset) is missing and cannot be reasonably assumed, call ask_user with ONE short question. Ask at most once per conversation; afterwards assume sensible defaults.
3. Explore what exists: list_categories, then search_markets with short keywords (e.g. "oil", "ETH", "Fed", "gas", "copper"), then get_event for the contract ladder of promising events. Only listed markets exist; never invent tickers or symbols.
4. Choose legs. Prefer direct markets (an ETH-price bucket for an ETH holder, a Fed-decision market for a floating-rate loan); otherwise use proxies with a clear causal link (cold temperatures -> heating demand -> gas; Brent -> energy costs).
   - Long exposures: legs that pay on the downside (No on "X or above", Yes on "X or below").
   - Short positions, costs and liabilities: legs that pay on the upside.
   - Prefer expiries that match the exposure's horizon.
5. Size: total cost (margin plus open fees) fits the budget; with no budget, keep it a modest share of the exposure. For large sizes, call get_book and keep each leg within what the ask side can fill.
6. Leverage: from 1x to the leg's max (preview_position reports it with exact cost; the server also enforces it). Liquidation defeats a hedge, so use 1x unless the budget forces otherwise.
7. Call propose_hedge. Its fields are data only: no explanations, rationales or disclaimers (the UI shows market data and a fixed disclaimer). If nothing listed relates, propose no legs and say why in note.

Before each data tool call, write one short plain-English sentence (under 25 words) in your message, for a non-expert audience, saying what you are checking and why; name markets by their title or strike (e.g. "the $1,750 contract"), never by ticker or symbol, and use no shorthand such as "null". The fields of propose_hedge and ask_user stay data only.

Always finish by calling ask_user or propose_hedge. Never reply with plain text alone.`;
}

// ---------------------------------------------------------------------------------------------
// Tools

const fn = (name: string, description: string, parameters: Record<string, unknown>): ChatCompletionTool => ({
  type: "function",
  function: { name, description, parameters },
});

const legSchema = {
  type: "object",
  properties: {
    event_ticker: { type: "string" },
    symbol: { type: "string", description: "Contract instrument symbol from get_event." },
    side: { type: "string", enum: ["yes", "no"] },
    margin_usdc: { type: "number", description: "USDC the user posts as margin (open fee is added on top)." },
    leverage: { type: "number", description: "1 to 5 in 0.5 steps, at most the leg's max leverage." },
    basis: {
      type: "string",
      enum: ["direct", "proxy"],
      description: "direct: the market is on the exposure itself. proxy: it moves with the exposure through a causal link.",
    },
  },
  required: ["event_ticker", "symbol", "side", "margin_usdc", "leverage", "basis"],
};

export const TOOLS: ChatCompletionTool[] = [
  fn("list_categories", "Market categories on Gemini right now, with counts and sample event titles.", {
    type: "object",
    properties: {},
  }),
  fn("search_markets", "Search active Gemini events by keyword and/or category. Returns up to 25 events with their first contracts.", {
    type: "object",
    properties: {
      search: { type: "string", description: "Short keyword, e.g. 'oil', 'ETH', 'Fed', 'temperature'." },
      category: { type: "string", description: "Exact category name from list_categories." },
    },
  }),
  fn("get_event", "Every contract (outcome bucket) of one event with Yes bid/ask in cents.", {
    type: "object",
    properties: { ticker: { type: "string" } },
    required: ["ticker"],
  }),
  fn("get_book", "Order book depth for one contract symbol (Yes-space prices, sizes in contracts).", {
    type: "object",
    properties: { symbol: { type: "string" } },
    required: ["symbol"],
  }),
  fn("preview_position", "Exact cost and risk of one leg: max leverage, contracts, open fee, liquidation price, payout.", {
    type: "object",
    properties: {
      event_ticker: { type: "string" },
      symbol: { type: "string" },
      side: { type: "string", enum: ["yes", "no"] },
      margin_usdc: { type: "number" },
      leverage: { type: "number" },
    },
    required: ["event_ticker", "symbol", "side", "margin_usdc", "leverage"],
  }),
  fn("ask_user", "Ask the user one short clarifying question. Ends your turn.", {
    type: "object",
    properties: { question: { type: "string" } },
    required: ["question"],
  }),
  fn("propose_hedge", "Submit the hedge as data. The UI shows each leg with live market data, so add no explanations. Ends your turn.", {
    type: "object",
    properties: {
      hedging_against: {
        type: "string",
        description: "The adverse move in at most 8 words, e.g. 'Natural gas prices rising' or 'ETH falling below $1,750'.",
      },
      legs: { type: "array", items: legSchema },
      scenarios: {
        type: "array",
        description: "2-3 outcomes: the adverse move, the base case, the favourable move.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "At most 4 words, e.g. 'Gas spikes above $4'." },
            winning_symbols: { type: "array", items: { type: "string" }, description: "Leg symbols that pay out in this outcome." },
          },
          required: ["name", "winning_symbols"],
        },
      },
      note: {
        type: "string",
        description: "Optional, at most 20 words. Only for something the legs cannot show, e.g. why no market fits.",
      },
    },
    required: ["hedging_against", "legs", "scenarios"],
  }),
];

const cents = (p: number | bigint | null) => (p === null ? null : Number(p) / 10_000);
const usd = (v: bigint) => Number(v) / 1e6;
const clip = (s: string) => (s.length > MAX_TOOL_RESULT_CHARS ? `${s.slice(0, MAX_TOOL_RESULT_CHARS)}…(truncated)` : s);
const str = (v: unknown, max = 120) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function eventSummary(e: MarketEvent, contractLimit?: number) {
  return {
    ticker: e.ticker,
    title: e.title,
    category: e.category,
    expiry: e.expiry,
    volume_24h_usd: Math.round(e.volume24h),
    contract_count: e.contractCount,
    contracts: e.contracts.slice(0, contractLimit).map((c) => ({
      symbol: c.symbol,
      label: c.label,
      open: c.open,
      expiry: c.expiry,
      yes_bid_cents: cents(c.yesBid),
      yes_ask_cents: cents(c.yesAsk),
    })),
  };
}

// `contractLabels`: symbol -> contract label, filled from Gemini data as preview_position resolves
// a contract, so the step label can name it.
type ToolContext = { data: MarketData; now: Date; sources: Set<DataSource>; contractLabels: Map<string, string> };

async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const { data } = ctx;
  switch (name) {
    case "list_categories": {
      const m = await data.getMarkets({});
      ctx.sources.add(m.source);
      const byCat = new Map<string, string[]>();
      for (const e of m.events) byCat.set(e.category, [...(byCat.get(e.category) ?? []), e.title]);
      return {
        categories: [...byCat.entries()]
          .sort((a, b) => b[1].length - a[1].length)
          .map(([category, titles]) => ({ category, events: titles.length, examples: titles.slice(0, 4) })),
      };
    }
    case "search_markets": {
      const search = str(args.search, 80) || undefined;
      const category = str(args.category, 60) || undefined;
      const m = await data.getMarkets({ search, category, limit: 60 });
      ctx.sources.add(m.source);
      const events = m.events.slice(0, 25).map((e) => eventSummary(e, 3));
      return events.length
        ? { events, note: "Contracts are trimmed to the first 3; call get_event for the full ladder." }
        : { events: [], note: "No matches. Try a shorter or different keyword, or a category from list_categories." };
    }
    case "get_event": {
      const ticker = str(args.ticker);
      if (!isSafeId(ticker)) return { error: "Invalid ticker." };
      const r = await data.getEvent(ticker);
      if (!r) return { error: `No event ${ticker}.` };
      ctx.sources.add(r.source);
      return eventSummary(r.event);
    }
    case "get_book": {
      const symbol = str(args.symbol);
      if (!isSafeId(symbol)) return { error: "Invalid symbol." };
      const b = await data.getBook(symbol);
      if (!b) return { error: `No book for ${symbol}.` };
      const lvl = (l: { price: number; amount: number }) => ({ yes_price_cents: cents(l.price), contracts: l.amount });
      return {
        symbol,
        yes_bids: b.bids.slice(0, 8).map(lvl),
        yes_asks: b.asks.slice(0, 8).map(lvl),
        note: "Buying Yes lifts yes_asks; buying No hits yes_bids (No price = 100 - Yes bid).",
      };
    }
    case "preview_position": {
      const ticker = str(args.event_ticker);
      const symbol = str(args.symbol);
      const side = args.side === "no" ? "no" : "yes";
      if (!isSafeId(ticker)) return { error: "Invalid ticker." };
      const r = await data.getEvent(ticker);
      const contract = r?.event.contracts.find((c) => c.symbol === symbol);
      if (!r || !contract) return { error: `${symbol} is not a contract of ${ticker}.` };
      ctx.contractLabels.set(symbol, contract.label);
      if (!contract.open) return { error: "This contract is closed to trading." };
      const price = contractAsk(contract, side);
      if (price === null) return { error: `No ${side} offer right now.` };
      const marginUsd = Number(args.margin_usdc);
      if (!Number.isFinite(marginUsd) || marginUsd < 1) return { error: "margin_usdc must be at least 1." };
      const nowS = BigInt(Math.floor(ctx.now.getTime() / 1000));
      const max = maxLeverage(price, nowS, unixSeconds(contract.expiry ?? r.event.expiry));
      const asked = BigInt(Math.max(10, Math.round(Number(args.leverage) * 10) || 10));
      const lev = clampLeverage(asked, max);
      const p = previewOpen(BigInt(Math.floor(marginUsd * 1e6)), lev, price);
      return {
        side_price_cents: cents(price),
        max_leverage: Number(max) / 10,
        leverage_used: Number(lev) / 10,
        leverage_was_lowered: asked > max,
        contracts: usd(p.contracts),
        borrowed_usdc: usd(p.borrowed),
        open_fee_usdc: usd(p.fee),
        total_cost_usdc: usd(p.total),
        liquidation_price_cents: p.liqPrice === 0n ? null : cents(p.liqPrice),
        payout_if_wins_usdc: usd(p.payoutIfWin),
        profit_if_wins_usdc: usd(p.payoutIfWin - p.total),
        max_loss_usdc: usd(p.total),
      };
    }
    default:
      return { error: `Unknown tool ${name}.` };
  }
}

// ---------------------------------------------------------------------------------------------
// Progress labels (streamed to the browser). Fixed templates only: the one piece of model text
// allowed is the search keyword or category, trimmed to 40 characters. Everything else is either
// a number we computed or an identifier or title that came back from Gemini data, so a label can
// never carry the model's free text or a tool result verbatim.

const KEYWORD_CHARS = 40;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const keyword = (v: unknown) => str(v, KEYWORD_CHARS).replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
const obj = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null);
const fmtLev = (x: number) => `${Number.isInteger(x) ? x : x.toFixed(1)}x`;

/** The label shown while a data tool runs. Uses only the arguments' keyword, side and leverage. */
export function toolStartLabel(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "list_categories":
      return "Listing market categories";
    case "search_markets": {
      const kw = keyword(args.search) || keyword(args.category);
      return kw ? `Searching markets for "${kw}"` : "Searching markets";
    }
    case "get_event":
      return "Reading an event";
    case "get_book":
      return "Checking an order book";
    case "preview_position": {
      const side = args.side === "no" ? "No" : "Yes";
      const lev = Number(args.leverage);
      return Number.isFinite(lev) && lev >= 1 && lev <= 100 ? `Pricing ${side} at ${fmtLev(Math.round(lev * 10) / 10)}` : `Pricing ${side}`;
    }
    default:
      return "Running a tool";
  }
}

/**
 * The label and detail once a data tool has returned. Reads the structured result we built in
 * runTool (counts, and tickers, titles and symbols that Gemini returned), never its text.
 * `contract` is the Gemini label of the contract a preview_position call resolved, if any.
 */
export function toolDoneLabel(name: string, startLabel: string, result: unknown, contract?: string): { label: string; detail?: string } {
  const r = obj(result);
  if (!r || "error" in r) return { label: startLabel, detail: "no result" };
  switch (name) {
    case "list_categories":
      return { label: startLabel, detail: plural(Array.isArray(r.categories) ? r.categories.length : 0, "category", "categories") };
    case "search_markets":
      return { label: startLabel, detail: plural(Array.isArray(r.events) ? r.events.length : 0, "event") };
    case "get_event": {
      const title = typeof r.title === "string" && r.title.trim() ? r.title.trim().slice(0, 80) : typeof r.ticker === "string" ? r.ticker : "";
      const n = Array.isArray(r.contracts) ? r.contracts.length : 0;
      return { label: title ? `Reading ${title}` : startLabel, detail: plural(n, "contract") };
    }
    case "get_book": {
      const symbol = typeof r.symbol === "string" ? r.symbol : "";
      const n = (Array.isArray(r.yes_bids) ? r.yes_bids.length : 0) + (Array.isArray(r.yes_asks) ? r.yes_asks.length : 0);
      return { label: symbol ? `Checking the order book for ${symbol}` : startLabel, detail: plural(n, "level") };
    }
    case "preview_position": {
      const max = Number(r.max_leverage);
      const c = contract ? contract.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 60) : "";
      const label = c ? startLabel.replace(/^Pricing (Yes|No)/, (m) => `${m} on "${c}"`) : startLabel;
      return { label, detail: Number.isFinite(max) ? `max ${fmtLev(max)}` : undefined };
    }
    default:
      return { label: startLabel };
  }
}

// ---------------------------------------------------------------------------------------------
// Thoughts (streamed to the browser as `thought` events, never as labels). Model free text: the
// provider's reasoning field, a <think> block, or the short sentence the prompt asks for before
// each tool call. Plain text only, and never added to the conversation beyond what the assistant
// message already carries.

export const THOUGHT_CHARS = 600;
const ENCRYPTED = /^\[some reasoning content is encrypted\]$/i;

/** Plain text for the trace: no control characters or think tags, single spaces, capped. */
// Instrument-like identifiers the audience should not see: Gemini symbols (GEMI-…) and bare
// tickers of 2+ capitals and 6+ digits with optional -SUFFIX parts (NGAS2611302200).
const INSTRUMENT = /\b(?:GEMI(?:-[A-Z0-9]+)+|[A-Z]{2,}\d{6,}(?:-[A-Z0-9]+)*)\b/g;

export function cleanThought(s: string): string {
  let t = s.replace(/<\/?think>/gi, " ").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ");
  const scrubbed = t.replace(INSTRUMENT, " ");
  // Tidy only where a token was removed: no space left before punctuation. No grammar repair.
  if (scrubbed !== t) t = scrubbed.replace(/\s+([.,;:!?)])/g, "$1");
  t = t.replace(/\s+/g, " ").trim();
  return t.length > THOUGHT_CHARS ? `${t.slice(0, THOUGHT_CHARS - 1).trimEnd()}…` : t;
}

/** Splits a leading <think>…</think> block (or reasoning closed by a bare </think>) off content. */
export function splitThink(content: string): { think: string; rest: string } {
  const close = content.search(/<\/think>/i);
  if (close >= 0) {
    const head = content.slice(0, close);
    const open = head.search(/<think>/i);
    // Only reasoning that leads the message counts; text before an opening tag stays content.
    if (open < 0 || !head.slice(0, open).trim()) {
      return { think: open < 0 ? head : head.slice(open + 7), rest: content.slice(close + 8) };
    }
  }
  const m = /^\s*<think>/i.exec(content);
  return m ? { think: content.slice(m[0].length), rest: "" } : { think: "", rest: content };
}

/** The thought for one model message, first non-empty source wins. */
export function thoughtOf(msg: { reasoning_content?: unknown; reasoning?: unknown }, think: string, content: string, hasCalls: boolean): string {
  for (const raw of [msg.reasoning_content, msg.reasoning, think, hasCalls ? content : ""]) {
    if (typeof raw !== "string") continue;
    const t = cleanThought(raw);
    if (t && !ENCRYPTED.test(t)) return t;
  }
  return "";
}

// ---------------------------------------------------------------------------------------------
// Loop

function parseArgs(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw || "{}");
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function proposalContext(p: HedgeProposal): string {
  const legs = p.legs.map((l) => ({
    event_ticker: l.eventTicker,
    symbol: l.symbol,
    market: `${l.eventTitle}: ${l.label}`,
    side: l.side,
    margin_usdc: l.margin / 1e6,
    leverage: l.leverage / 10,
    basis: l.basisRisk,
  }));
  return `The user's current proposal (they may have edited it; treat it as the starting point and keep what they did not ask to change):\n${JSON.stringify({ hedging_against: p.hedgingAgainst, legs }).slice(0, 8000)}`;
}

async function finalize(raw: Record<string, unknown>, ctx: ToolContext): Promise<HedgeProposal> {
  const legs = Array.isArray(raw.legs) ? raw.legs : [];
  const tickers = new Set<string>();
  for (const l of legs) {
    const t = typeof l === "object" && l !== null ? (l as Record<string, unknown>).event_ticker : null;
    if (typeof t === "string" && isSafeId(t)) tickers.add(t);
  }
  const events: MarketEvent[] = [];
  for (const t of [...tickers].slice(0, 12)) {
    const r = await ctx.data.getEvent(t);
    if (r) {
      events.push(r.event);
      ctx.sources.add(r.source);
    }
  }
  return buildProposal({
    raw,
    events,
    nowSeconds: BigInt(Math.floor(ctx.now.getTime() / 1000)),
    source: ctx.sources.has("fixture") ? "fixture" : "gemini",
    quotedAt: ctx.now.toISOString(),
  });
}

export async function runHedgeAgent(
  input: { messages: HedgeMessage[]; proposal?: HedgeProposal | null },
  deps: AgentDeps,
): Promise<HedgeResponse> {
  const now = deps.now?.() ?? new Date();
  const deadline = Date.now() + (deps.deadlineMs ?? AGENT_DEADLINE_MS);
  const ctx: ToolContext = { data: deps.data ?? geminiData, now, sources: new Set(), contractLabels: new Map() };
  const client = deps.client as ChatClient;
  let stepId = 0;
  const emit = (e: HedgeStepEvent) => {
    try {
      deps.onEvent?.(e);
    } catch {
      // A listener (e.g. a closed stream) must never break the loop.
    }
  };
  const emitThought = (t: HedgeThoughtEvent) => {
    try {
      deps.onThought?.(t);
    } catch {
      // Same as emit.
    }
  };

  const messages: ChatCompletionMessageParam[] = [{ role: "system", content: systemPrompt(now) }];
  input.messages.forEach((m, i) => {
    const last = i === input.messages.length - 1;
    const content = last && m.role === "user" && input.proposal ? `${proposalContext(input.proposal)}\n\nUser: ${m.content}` : m.content;
    messages.push({ role: m.role, content });
  });

  let nudged = false;
  for (let step = 0; step < MAX_STEPS; step++) {
    const remaining = deadline - Date.now();
    if (remaining < MIN_CALL_MS) break;
    const finalStep = step === MAX_STEPS - 1;
    if (finalStep) {
      messages.push({ role: "user", content: "Step limit reached. Call propose_hedge now with your best proposal, or ask_user." });
    }
    const params = {
      model: deps.model,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
      temperature: 0.2,
      ...(deps.reasoningEffort ? { reasoning_effort: deps.reasoningEffort } : {}),
      // Venice extensions: no Venice persona prompt, no web search (stay on Gemini data). Thinking
      // is not stripped so the trace can show it; a <think> block in content is split off below.
      venice_parameters: { include_venice_system_prompt: false, enable_web_search: "off", strip_thinking_response: false },
    } as ChatCompletionCreateParamsNonStreaming;
    let res: ChatCompletion;
    const modelStep = ++stepId;
    emit({ id: modelStep, phase: "start", kind: "model", label: "Thinking" });
    try {
      // Cap each attempt so a timeout plus its retry still fits the loop's budget (and the route's
      // maxDuration); retry only when the remaining budget holds a second capped attempt.
      const attemptMs = Math.min(remaining, MAX_CALL_MS);
      res = await client.chat.completions.create(params, { timeout: attemptMs, maxRetries: remaining >= 2 * attemptMs ? 1 : 0 });
    } catch (e) {
      if (e instanceof OpenAI.APIConnectionTimeoutError) return OUT_OF_TIME;
      throw e;
    }
    const msg = res.choices[0]?.message;
    const calls = (msg?.tool_calls ?? []).filter((c) => c.type === "function");
    emit({ id: modelStep, phase: "done", kind: "model", label: "Thinking", ...(calls.length ? { detail: plural(calls.length, "tool call") } : {}) });
    if (!msg) return { type: "error", error: "The model returned no message." };
    // Reasoning in a <think> block never goes back to the model or into a reply.
    const { think, rest: content } = splitThink(msg.content ?? "");
    const thought = thoughtOf(msg as { reasoning_content?: unknown; reasoning?: unknown }, think, content, calls.length > 0);
    if (thought) emitThought({ id: modelStep, text: thought });

    if (calls.length === 0) {
      const textReply = content.trim();
      if (nudged || finalStep) {
        return textReply ? { type: "question", question: textReply } : { type: "error", error: "The agent did not produce a proposal." };
      }
      nudged = true;
      messages.push({ role: "assistant", content: textReply || "(no reply)" });
      messages.push({ role: "user", content: "Respond by calling propose_hedge or ask_user, not with plain text." });
      continue;
    }

    messages.push({ role: "assistant", content: content.trim() ? content : null, tool_calls: calls });

    const terminal = calls.find((c) => c.function.name === "propose_hedge" || c.function.name === "ask_user");
    if (terminal) {
      const args = parseArgs(terminal.function.arguments);
      if (args && terminal.function.name === "ask_user" && typeof args.question === "string" && args.question.trim()) {
        return { type: "question", question: args.question.trim().slice(0, 600) };
      }
      if (args && terminal.function.name === "propose_hedge") {
        const id = ++stepId;
        const label = "Validating the proposal against live prices";
        emit({ id, phase: "start", kind: "tool", tool: "propose_hedge", label });
        const proposal = await finalize(args, ctx);
        emit({ id, phase: "done", kind: "tool", tool: "propose_hedge", label, detail: plural(proposal.legs.length, "leg") });
        return { type: "proposal", proposal };
      }
      // Malformed terminal call: report it back and let the model retry.
    }

    for (const call of calls) {
      const args = parseArgs(call.function.arguments);
      let result: unknown;
      if (!args) result = { error: "Arguments were not valid JSON. Call the tool again." };
      else if (call === terminal) result = { error: "Missing or invalid fields. Call the tool again with every required field." };
      else if (call.function.name === "propose_hedge" || call.function.name === "ask_user") result = { error: "Ignored." };
      else {
        const name = call.function.name;
        const id = ++stepId;
        const label = toolStartLabel(name, args);
        emit({ id, phase: "start", kind: "tool", tool: name, label });
        try {
          result = await runTool(name, args, ctx);
        } catch (e) {
          result = { error: e instanceof Error ? e.message : "Tool failed." };
        }
        const contract = name === "preview_position" ? ctx.contractLabels.get(str(args.symbol)) : undefined;
        emit({ id, phase: "done", kind: "tool", tool: name, ...toolDoneLabel(name, label, result, contract) });
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: clip(JSON.stringify(result)) });
    }
  }
  return OUT_OF_TIME;
}
