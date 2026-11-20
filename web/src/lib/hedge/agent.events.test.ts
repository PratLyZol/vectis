import { describe, expect, it } from "vitest";
import type { ChatCompletion } from "openai/resources/chat/completions";
import { THOUGHT_CHARS, cleanThought, runHedgeAgent, splitThink, toolDoneLabel, toolStartLabel, type MarketData } from "./agent.server";
import type { HedgeStepEvent, HedgeThoughtEvent, MarketEvent } from "../types";

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
  getBook: async () => ({ source: "gemini", bids: [{ price: 580_000, amount: 10 }], asks: [] }),
};

type Reply = { content?: string | null; reasoning?: string; calls?: { name: string; args: unknown }[] };

/** `sent` holds a JSON snapshot of the messages each call received (the loop mutates its array). */
function mockClient(replies: Reply[], sent: string[] = []) {
  let i = 0;
  return {
    chat: {
      completions: {
        create: async (p: { messages: unknown[] }): Promise<ChatCompletion> => {
          sent.push(JSON.stringify(p.messages));
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
                  ...(r.reasoning ? { reasoning_content: r.reasoning } : {}),
                  refusal: null,
                  tool_calls: r.calls?.map((c, n) => ({
                    id: `call_${i}_${n}`,
                    type: "function" as const,
                    function: { name: c.name, arguments: JSON.stringify(c.args) },
                  })),
                },
              },
            ],
          };
        },
      },
    },
  };
}

const proposeArgs = {
  hedging_against: "Natural gas prices rising",
  legs: [{ event_ticker: "BRENT", symbol: "B-91", side: "yes", margin_usdc: 60, leverage: 1, basis: "proxy" }],
  scenarios: [{ name: "Spike", winning_symbols: ["B-91"] }],
};

// Model text that must never reach a label: the free-text content of the assistant message.
const MODEL_TEXT = "SECRET-REASONING the user is clearly panicking";

describe("runHedgeAgent onEvent", () => {
  it("emits start/done pairs in order, one per model call and data tool", async () => {
    const client = mockClient([
      {
        content: MODEL_TEXT,
        calls: [
          { name: "search_markets", args: { search: "  oil  " } },
          { name: "get_event", args: { ticker: "BRENT" } },
          { name: "get_book", args: { symbol: "B-91" } },
          { name: "preview_position", args: { event_ticker: "BRENT", symbol: "B-91", side: "no", margin_usdc: 10, leverage: 2 } },
        ],
      },
      { calls: [{ name: "list_categories", args: {} }] },
      { content: MODEL_TEXT, calls: [{ name: "propose_hedge", args: proposeArgs }] },
    ]);
    const events: HedgeStepEvent[] = [];
    const r = await runHedgeAgent(
      { messages: [{ role: "user", content: "laundromat" }] },
      { client, model: "m", data, now: () => NOW, onEvent: (e) => events.push(e) },
    );
    expect(r.type).toBe("proposal");

    // Every start is followed by its done before the next start.
    for (let k = 0; k < events.length; k += 2) {
      expect(events[k]!.phase).toBe("start");
      expect(events[k + 1]!).toMatchObject({ phase: "done", id: events[k]!.id, kind: events[k]!.kind });
    }
    const starts = events.filter((e) => e.phase === "start");
    expect(starts.map((e) => e.id)).toEqual(starts.map((_, n) => n + 1));
    expect(starts.map((e) => (e.kind === "model" ? "model" : e.tool))).toEqual([
      "model",
      "search_markets",
      "get_event",
      "get_book",
      "preview_position",
      "model",
      "list_categories",
      "model",
      "propose_hedge",
    ]);
    expect(events.filter((e) => e.kind === "model").every((e) => e.tool === undefined)).toBe(true);

    const done = events.filter((e) => e.phase === "done");
    expect(done.map((e) => [e.label, e.detail])).toEqual([
      ["Thinking", "4 tool calls"],
      ['Searching markets for "oil"', "1 event"],
      ["Reading Oil (Brent) price?", "1 contract"],
      ["Checking the order book for B-91", "1 level"],
      ['Pricing No on "$91 or above" at 2x', expect.stringMatching(/^max \d/)],
      ["Thinking", "1 tool call"],
      ["Listing market categories", "1 category"],
      ["Thinking", "1 tool call"],
      ["Validating the proposal against live prices", "1 leg"],
    ]);
    for (const e of events) {
      expect(e.label).not.toContain("SECRET");
      expect(e.detail ?? "").not.toContain("SECRET");
    }
  });

  it("returns the same result with and without a listener, and survives a throwing listener", async () => {
    const replies: Reply[] = [{ calls: [{ name: "get_event", args: { ticker: "BRENT" } }] }, { calls: [{ name: "propose_hedge", args: proposeArgs }] }];
    const plain = await runHedgeAgent({ messages: [{ role: "user", content: "x" }] }, { client: mockClient(replies), model: "m", data, now: () => NOW });
    const noisy = await runHedgeAgent(
      { messages: [{ role: "user", content: "x" }] },
      {
        client: mockClient(replies),
        model: "m",
        data,
        now: () => NOW,
        onEvent: () => {
          throw new Error("stream closed");
        },
      },
    );
    expect(noisy).toEqual(plain);
  });
});

describe("runHedgeAgent onThought", () => {
  const run = async (replies: Reply[]) => {
    const sent: string[] = [];
    const steps: HedgeStepEvent[] = [];
    const thoughts: HedgeThoughtEvent[] = [];
    const r = await runHedgeAgent(
      { messages: [{ role: "user", content: "laundromat" }] },
      { client: mockClient(replies, sent), model: "m", data, now: () => NOW, onEvent: (e) => steps.push(e), onThought: (t) => thoughts.push(t) },
    );
    return { r, sent, steps, thoughts };
  };
  const search = [{ name: "search_markets", args: { search: "oil" } }];
  const propose = [{ name: "propose_hedge", args: proposeArgs }];

  it("emits the provider's reasoning field for the model step, ahead of content, and keeps it out of history and labels", async () => {
    const { r, sent, steps, thoughts } = await run([
      { reasoning: "REASONING-ONE gas costs track Brent", content: "Checking oil markets for a proxy.", calls: search },
      { calls: propose },
    ]);
    expect(r.type).toBe("proposal");
    expect(thoughts).toEqual([{ id: 1, text: "REASONING-ONE gas costs track Brent" }]);
    expect(steps.find((s) => s.id === 1)).toMatchObject({ kind: "model" });
    expect(sent[1]).not.toContain("REASONING-ONE");
    // The assistant content was already part of the message, and stays exactly that.
    expect(sent[1]).toContain("Checking oil markets for a proxy.");
    for (const s of steps) expect(`${s.label} ${s.detail ?? ""}`).not.toMatch(/REASONING|Checking oil/);
  });

  it("uses the content alongside tool calls when there is no reasoning field", async () => {
    const { thoughts, steps } = await run([{ content: "  Looking for\n oil markets.  ", calls: search }, { calls: propose }]);
    expect(thoughts).toEqual([{ id: 1, text: "Looking for oil markets." }]);
    for (const s of steps) expect(s.label).not.toContain("Looking");
  });

  it("unwraps a <think> block, and never sends it back or into a reply", async () => {
    const { thoughts, sent } = await run([{ content: "<think>THINK-TEXT compare gas and oil</think>", calls: search }, { calls: propose }]);
    expect(thoughts).toEqual([{ id: 1, text: "THINK-TEXT compare gas and oil" }]);
    expect(sent[1]).not.toContain("THINK-TEXT");

    const q = await run([{ content: "<think>THINK-TEXT unsure</think>Which city are you in?" }]);
    // Nudged once (the mock repeats its reply), so one thought per model step.
    expect(q.thoughts).toEqual([
      { id: 1, text: "THINK-TEXT unsure" },
      { id: 2, text: "THINK-TEXT unsure" },
    ]);
    expect(q.r).toEqual({ type: "question", question: "Which city are you in?" });
    expect(q.sent.join("")).not.toContain("THINK-TEXT");
  });

  it("does not turn a plain-text reply into a thought, and still nudges", async () => {
    const { r, thoughts, sent } = await run([{ content: "Which city are you in?" }]);
    expect(thoughts).toEqual([]);
    expect(sent).toHaveLength(2);
    expect(r).toEqual({ type: "question", question: "Which city are you in?" });
  });

  it("skips empty and encrypted reasoning", async () => {
    const { thoughts } = await run([{ reasoning: "[Some reasoning content is encrypted]", calls: search }, { reasoning: "   ", calls: propose }]);
    expect(thoughts).toEqual([]);
  });

  it("cleans thought text: control characters, think tags, whitespace, 600 characters", () => {
    expect(cleanThought("a\u0000b\u0007\u001b[31mc\t\n d <think>e</think>")).toBe("a b [31mc d e");
    const long = cleanThought("word ".repeat(400));
    expect(long.length).toBe(THOUGHT_CHARS);
    expect(long.endsWith("…")).toBe(true);
    expect(splitThink("plan</think>Answer")).toEqual({ think: "plan", rest: "Answer" });
    expect(splitThink("Answer <think>x</think>")).toEqual({ think: "", rest: "Answer <think>x</think>" });
    expect(splitThink("<think>unclosed")).toEqual({ think: "unclosed", rest: "" });
  });
});

describe("step labels", () => {
  it("only carry the keyword from the arguments, trimmed to 40 characters", () => {
    const long = `oil ${"x".repeat(100)}`;
    expect(toolStartLabel("search_markets", { search: long })).toBe(`Searching markets for "${long.slice(0, 40).trim()}"`);
    expect(toolStartLabel("search_markets", { category: "Crypto" })).toBe('Searching markets for "Crypto"');
    expect(toolStartLabel("search_markets", { search: "a\nb\u0007c" })).toBe('Searching markets for "a b c"');
    // Model-supplied identifiers are not echoed before Gemini confirms them.
    expect(toolStartLabel("get_event", { ticker: "IGNORE-PREVIOUS" })).toBe("Reading an event");
    expect(toolStartLabel("get_book", { symbol: "IGNORE-PREVIOUS" })).toBe("Checking an order book");
    expect(toolStartLabel("preview_position", { side: "say hi", leverage: "lots" })).toBe("Pricing Yes");
    expect(toolStartLabel("whatever_tool", { text: "hello" })).toBe("Running a tool");
  });

  it("never copy text from a tool result except Gemini titles and identifiers", () => {
    const leak = "LEAKED-RESULT-TEXT";
    expect(toolDoneLabel("search_markets", "S", { events: [{ title: leak }], note: leak })).toEqual({ label: "S", detail: "1 event" });
    expect(toolDoneLabel("list_categories", "L", { categories: [{ category: leak, examples: [leak] }, {}] })).toEqual({ label: "L", detail: "2 categories" });
    expect(toolDoneLabel("get_event", "R", { error: leak })).toEqual({ label: "R", detail: "no result" });
    expect(toolDoneLabel("preview_position", "P", { max_leverage: 3, note: leak })).toEqual({ label: "P", detail: "max 3x" });
    // A "$1" in a Gemini contract label is text, not a regex backreference.
    expect(toolDoneLabel("preview_position", "Pricing No at 1x", { max_leverage: 4 }, "$1,750 or above")).toEqual({
      label: 'Pricing No on "$1,750 or above" at 1x',
      detail: "max 4x",
    });
    expect(toolDoneLabel("preview_position", "Pricing Yes at 2x", { max_leverage: 3 }, "$&$`$' or above").label).toBe('Pricing Yes on "$&$`$\' or above" at 2x');
    expect(JSON.stringify(toolDoneLabel("get_book", "B", { symbol: "B-91", yes_bids: [], yes_asks: [], note: leak }))).not.toContain(leak);
  });
});
