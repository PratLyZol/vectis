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
  MarketEvent,
  MarketsResponse,
} from "../types";
import { buildProposal, clampLeverage, contractAsk } from "./validate";

export const MAX_STEPS = 10;
/** Wall-clock budget for the whole loop; the route's maxDuration leaves headroom above it. */
export const AGENT_DEADLINE_MS = 75_000;
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

Always finish by calling ask_user or propose_hedge. Do not reply with plain text.`;
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

type ToolContext = { data: MarketData; now: Date; sources: Set<DataSource> };

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
  const ctx: ToolContext = { data: deps.data ?? geminiData, now, sources: new Set() };
  const client = deps.client as ChatClient;

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
      // Venice extensions: no Venice persona prompt, no web search (stay on Gemini data), no
      // reasoning text in the reply.
      venice_parameters: { include_venice_system_prompt: false, enable_web_search: "off", strip_thinking_response: true },
    } as ChatCompletionCreateParamsNonStreaming;
    let res: ChatCompletion;
    try {
      // Never let one model call outlive the loop's budget; retry only when there is time for it.
      res = await client.chat.completions.create(params, { timeout: remaining, maxRetries: remaining > 40_000 ? 1 : 0 });
    } catch (e) {
      if (e instanceof OpenAI.APIConnectionTimeoutError) return OUT_OF_TIME;
      throw e;
    }
    const msg = res.choices[0]?.message;
    if (!msg) return { type: "error", error: "The model returned no message." };

    const calls = (msg.tool_calls ?? []).filter((c) => c.type === "function");
    if (calls.length === 0) {
      const textReply = (msg.content ?? "").trim();
      if (nudged || finalStep) {
        return textReply ? { type: "question", question: textReply } : { type: "error", error: "The agent did not produce a proposal." };
      }
      nudged = true;
      messages.push({ role: "assistant", content: textReply || "(no reply)" });
      messages.push({ role: "user", content: "Respond by calling propose_hedge or ask_user, not with plain text." });
      continue;
    }

    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: calls });

    const terminal = calls.find((c) => c.function.name === "propose_hedge" || c.function.name === "ask_user");
    if (terminal) {
      const args = parseArgs(terminal.function.arguments);
      if (args && terminal.function.name === "ask_user" && typeof args.question === "string" && args.question.trim()) {
        return { type: "question", question: args.question.trim().slice(0, 600) };
      }
      if (args && terminal.function.name === "propose_hedge") {
        return { type: "proposal", proposal: await finalize(args, ctx) };
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
        try {
          result = await runTool(call.function.name, args, ctx);
        } catch (e) {
          result = { error: e instanceof Error ? e.message : "Tool failed." };
        }
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: clip(JSON.stringify(result)) });
    }
  }
  return OUT_OF_TIME;
}
