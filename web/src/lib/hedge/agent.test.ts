import { describe, expect, it } from "vitest";
import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { MAX_STEPS, runHedgeAgent, type MarketData } from "./agent.server";
import type { MarketEvent } from "../types";

const NOW = new Date("2026-11-18T12:00:00Z");
const brent: MarketEvent = {
  id: "1",
  ticker: "BRENT",
  title: "Oil (Brent) price?",
  slug: "brent",
  category: "Commodities",
  status: "active",
  expiry: "2026-11-25T22:00:00Z",
  imageUrl: null,
  volume: 0,
  volume24h: 1000,
  contractCount: 1,
  contracts: [
    { symbol: "B-91", label: "$91 or above", ticker: "91", open: true, expiry: "2026-11-25T22:00:00Z", yesBid: 580_000, yesAsk: 600_000, last: null },
  ],
};

const data: MarketData = {
  getMarkets: async () => ({ source: "gemini", events: [brent], total: 1 }),
  getEvent: async (t) => (t === "BRENT" ? { source: "gemini", event: brent } : null),
  getBook: async () => ({ source: "gemini", bids: [], asks: [] }),
};

type Reply = { content?: string | null; calls?: { name: string; args: unknown | string }[] };

function mockClient(replies: Reply[]) {
  const seen: ChatCompletionCreateParamsNonStreaming[] = [];
  let i = 0;
  const client = {
    chat: {
      completions: {
        create: async (params: ChatCompletionCreateParamsNonStreaming): Promise<ChatCompletion> => {
          seen.push(structuredClone(params));
          const r = replies[Math.min(i++, replies.length - 1)]!;
          return {
            id: "x",
            object: "chat.completion",
            created: 0,
            model: "m",
            choices: [
              {
                index: 0,
                finish_reason: r.calls ? "tool_calls" : "stop",
                logprobs: null,
                message: {
                  role: "assistant",
                  content: r.content ?? null,
                  refusal: null,
                  tool_calls: r.calls?.map((c, n) => ({
                    id: `call_${i}_${n}`,
                    type: "function" as const,
                    function: { name: c.name, arguments: typeof c.args === "string" ? c.args : JSON.stringify(c.args) },
                  })),
                },
              },
            ],
          };
        },
      },
    },
  };
  return { client, seen };
}

const proposeArgs = {
  summary: "Buy Brent upside",
  exposure: { holder_type: "small_business", description: "gas bill", instrument_class: "operating_cost", direction: "cost", notional_usd: 900, horizon: "1 month", adverse_move: "gas up" },
  horizon_note: "short-dated",
  legs: [{ event_ticker: "BRENT", symbol: "B-91", side: "yes", margin_usdc: 60, leverage: 1, rationale: "r", hedge_mechanism: "m", basis_risk: "proxy", basis_risk_note: "n" }],
  scenarios: [{ name: "Spike", description: "", winning_symbols: ["B-91"] }],
  warnings: [],
};




describe("runHedgeAgent", () => {
  it("runs data tools, then returns a validated proposal", async () => {
    const { client, seen } = mockClient([
      { calls: [{ name: "search_markets", args: { search: "oil" } }, { name: "get_event", args: { ticker: "BRENT" } }] },
      { calls: [{ name: "propose_hedge", args: proposeArgs }] },
    ]);
    const r = await runHedgeAgent({ messages: [{ role: "user", content: "laundromat" }] }, { client, model: "m", data, now: () => NOW });
    expect(r.type).toBe("proposal");
    if (r.type !== "proposal") return;
    expect(r.proposal.legs[0]!).toMatchObject({ symbol: "B-91", price: 600_000, margin: 60_000_000 });
    // Second request carries both tool results.
    const toolMsgs = seen[1]!.messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(2);
    expect(String(toolMsgs[1]!.content)).toContain("B-91");
    expect((seen[0] as unknown as { venice_parameters: object }).venice_parameters).toMatchObject({ enable_web_search: "off" });
  });

  it("returns a question from ask_user", async () => {
    const { client } = mockClient([{ calls: [{ name: "ask_user", args: { question: "What is your budget?" } }] }]);
    const r = await runHedgeAgent({ messages: [{ role: "user", content: "hedge me" }] }, { client, model: "m", data, now: () => NOW });
    expect(r).toEqual({ type: "question", question: "What is your budget?" });
  });

  it("reports malformed tool JSON back to the model and continues", async () => {
    const { client, seen } = mockClient([
      { calls: [{ name: "get_event", args: "{not json" }] },
      { calls: [{ name: "propose_hedge", args: proposeArgs }] },
    ]);
    const r = await runHedgeAgent({ messages: [{ role: "user", content: "x" }] }, { client, model: "m", data, now: () => NOW });
    expect(r.type).toBe("proposal");
    expect(String(seen[1]!.messages.at(-1)?.content)).toContain("not valid JSON");
  });

  it("nudges once on a plain-text reply, then treats text as a question", async () => {
    const { client, seen } = mockClient([{ content: "Which city are you in?" }]);
    const r = await runHedgeAgent({ messages: [{ role: "user", content: "x" }] }, { client, model: "m", data, now: () => NOW });
    expect(seen).toHaveLength(2);
    expect(r).toEqual({ type: "question", question: "Which city are you in?" });
  });

  it("stops at the step limit", async () => {
    const { client, seen } = mockClient([{ calls: [{ name: "list_categories", args: {} }] }]);
    const r = await runHedgeAgent({ messages: [{ role: "user", content: "x" }] }, { client, model: "m", data, now: () => NOW });
    expect(seen).toHaveLength(MAX_STEPS);
    expect(r.type).toBe("error");
  });

  it("includes the edited proposal as context for a refinement", async () => {
    const { client, seen } = mockClient([{ calls: [{ name: "ask_user", args: { question: "ok?" } }] }]);
    const first = await runHedgeAgent(
      { messages: [{ role: "user", content: "x" }] },
      { client: mockClient([{ calls: [{ name: "propose_hedge", args: proposeArgs }] }]).client, model: "m", data, now: () => NOW },
    );
    if (first.type !== "proposal") throw new Error("expected proposal");
    await runHedgeAgent(
      { messages: [{ role: "user", content: "make it cheaper" }], proposal: first.proposal },
      { client, model: "m", data, now: () => NOW },
    );
    const last = seen[0]!.messages.at(-1);
    expect(String(last?.content)).toContain("current proposal");
    expect(String(last?.content)).toContain("make it cheaper");
  });

  it("previews a position with server-side math", async () => {
    const { client, seen } = mockClient([
      { calls: [{ name: "preview_position", args: { event_ticker: "BRENT", symbol: "B-91", side: "yes", margin_usdc: 60, leverage: 9 } }] },
      { calls: [{ name: "ask_user", args: { question: "q" } }] },
    ]);
    await runHedgeAgent({ messages: [{ role: "user", content: "x" }] }, { client, model: "m", data, now: () => NOW });
    const result = JSON.parse(String(seen[1]!.messages.at(-1)?.content));
    expect(result).toMatchObject({ max_leverage: 5, leverage_used: 5, leverage_was_lowered: true, side_price_cents: 60 });
  });
});
