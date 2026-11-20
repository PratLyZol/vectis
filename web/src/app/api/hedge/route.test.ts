import { beforeEach, describe, expect, it, vi } from "vitest";
import OpenAI from "openai";
import { createSseDecoder, type SseFrame } from "@/lib/hedge/sse";

// A fake Venice client: no network, no key. `reply` decides what each model call does.
const fake = vi.hoisted(() => ({ client: null as unknown, reply: (() => {}) as () => unknown }));
vi.mock("@/lib/hedge/venice.server", () => ({
  veniceClient: () => fake.client,
  veniceModel: () => "m",
  veniceReasoningEffort: () => "low",
}));

const { POST } = await import("./route");

const askUser = () => ({
  id: "x",
  object: "chat.completion",
  created: 0,
  model: "m",
  choices: [
    {
      index: 0,
      finish_reason: "tool_calls",
      logprobs: null,
      message: {
        role: "assistant",
        content: null,
        refusal: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "ask_user", arguments: '{"question":"What is your budget?"}' } }],
      },
    },
  ],
});

const body = JSON.stringify({ messages: [{ role: "user", content: "I hold 20 ETH." }] });
const post = (accept?: string, b = body) =>
  POST(new Request("http://localhost/api/hedge", { method: "POST", body: b, headers: { "content-type": "application/json", ...(accept ? { accept } : {}) } }));

function frames(text: string): SseFrame[] {
  const out: SseFrame[] = [];
  const d = createSseDecoder((f) => out.push(f));
  d.push(text);
  d.end();
  return out;
}

beforeEach(() => {
  fake.client = { chat: { completions: { create: async () => fake.reply() } } };
  fake.reply = askUser;
});

describe("POST /api/hedge", () => {
  it("answers JSON without an event-stream Accept header, as before", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ type: "question", question: "What is your budget?" });
  });

  it("keeps the JSON status codes for provider errors", async () => {
    fake.reply = () => {
      throw new OpenAI.RateLimitError(429, undefined, "slow", new Headers());
    };
    const res = await post();
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ type: "error", error: "The AI provider is rate limiting. Try again shortly." });
  });

  it("streams steps and one result with an event-stream Accept header", async () => {
    const res = await post("text/event-stream, application/json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-store, no-transform");
    const fs = frames(await res.text());
    expect(fs.map((f) => f.event)).toEqual(["step", "step", "result"]);
    expect(JSON.parse(fs[0]!.data)).toEqual({ id: 1, phase: "start", kind: "model", label: "Thinking" });
    expect(JSON.parse(fs[2]!.data)).toEqual({ type: "question", question: "What is your budget?" });
  });

  it("streams a provider error as the result event", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fake.reply = () => {
      throw new OpenAI.AuthenticationError(401, undefined, "bad key", new Headers());
    };
    const res = await post("text/event-stream");
    const results = frames(await res.text()).filter((f) => f.event === "result");
    expect(results.map((f) => JSON.parse(f.data))).toEqual([{ type: "error", error: "The AI provider rejected the API key." }]);
  });

  it("rejects bad requests with plain JSON before streaming", async () => {
    const bad = await post("text/event-stream", "{nope");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ type: "error", error: "Invalid JSON." });

    const big = await post("text/event-stream", "x".repeat(70 * 1024));
    expect(big.status).toBe(413);

    fake.client = null;
    const off = await post("text/event-stream");
    expect(off.status).toBe(503);
    expect(off.headers.get("content-type")).toContain("application/json");
    expect(await off.json()).toEqual({ type: "error", error: "The hedge agent is not configured (VENICE_API_KEY is missing)." });
  });
});
