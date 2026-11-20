import { describe, expect, it, vi } from "vitest";
import OpenAI from "openai";
import { runHedgeAgent, type MarketData } from "./agent.server";
import { hedgeSseStream } from "./respond.server";
import { createSseDecoder, encodeSse, readHedgeStream, type SseFrame } from "./sse";
import type { HedgeResponse, HedgeStepEvent } from "../types";

const step = (id: number, phase: "start" | "done", label = "Thinking"): HedgeStepEvent => ({ id, phase, kind: "model", label });

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  let out = "";
  const dec = new TextDecoder();
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return out + dec.decode();
    out += dec.decode(value, { stream: true });
  }
}

function frames(text: string): SseFrame[] {
  const out: SseFrame[] = [];
  const d = createSseDecoder((f) => out.push(f));
  d.push(text);
  d.end();
  return out;
}

/** A body that delivers `text` in the given chunk sizes, like a slow network. */
function chunked(text: string, sizes: number[]): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  let k = 0;
  return new ReadableStream({
    pull(c) {
      if (at >= bytes.length) return c.close();
      const n = sizes[k++ % sizes.length]!;
      c.enqueue(bytes.slice(at, at + n));
      at += n;
    },
  });
}

describe("SSE decoder", () => {
  it("reassembles frames split anywhere and skips comments", () => {
    const text = `: ping\n\n${encodeSse({ event: "step", data: step(1, "start") })}: ping\r\n\r\nevent: result\r\ndata: {"type":"question",\r\ndata: "question":"Budget?"}\r\n\r\n`;
    const out: SseFrame[] = [];
    const d = createSseDecoder((f) => out.push(f));
    for (const ch of text) d.push(ch); // one character at a time, including a split \r\n
    d.end();
    expect(out).toEqual([
      { event: "step", data: JSON.stringify(step(1, "start")) },
      { event: "result", data: '{"type":"question",\n"question":"Budget?"}' },
    ]);
  });
});

describe("readHedgeStream", () => {
  it("feeds steps to the callback and resolves with the result, across odd chunk boundaries", async () => {
    const result: HedgeResponse = { type: "question", question: "What is your budget? ünïcode €" };
    const text = [
      encodeSse({ event: "step", data: step(1, "start") }),
      ": ping\n\n",
      encodeSse({ event: "step", data: step(1, "done") }),
      "event: step\ndata: not json\n\n",
      "event: step\ndata: {\"id\":\"x\"}\n\n",
      encodeSse({ event: "result", data: result }),
    ].join("");
    const steps: HedgeStepEvent[] = [];
    const r = await readHedgeStream(chunked(text, [7, 1, 13, 3]), (s) => steps.push(s));
    expect(r).toEqual(result);
    expect(steps).toEqual([step(1, "start"), step(1, "done")]);
  });

  it("resolves null when the stream ends without a result", async () => {
    const r = await readHedgeStream(chunked(encodeSse({ event: "step", data: step(1, "start") }), [5]), () => {});
    expect(r).toBeNull();
  });
});

describe("hedgeSseStream", () => {
  const results = (text: string) => frames(text).filter((f) => f.event === "result");

  it("streams steps, then exactly one result, then closes", async () => {
    const out = await drain(
      hedgeSseStream(async (emit) => {
        emit(step(1, "start"));
        emit(step(1, "done"));
        return { type: "question", question: "Budget?" };
      }),
    );
    const fs = frames(out);
    expect(fs.map((f) => f.event)).toEqual(["step", "step", "result"]);
    expect(JSON.parse(fs[2]!.data)).toEqual({ type: "question", question: "Budget?" });
  });

  it("ends with one error result when the run throws a provider error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await drain(
      hedgeSseStream(async (emit) => {
        emit(step(1, "start"));
        throw new OpenAI.RateLimitError(429, undefined, "slow down", new Headers());
      }),
    );
    spy.mockRestore();
    const rs = results(out);
    expect(rs).toHaveLength(1);
    expect(JSON.parse(rs[0]!.data)).toEqual({ type: "error", error: "The AI provider is rate limiting. Try again shortly." });
  });

  it("ends with one error result for an unexpected exception", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await drain(
      hedgeSseStream(async () => {
        throw new Error("boom");
      }),
    );
    spy.mockRestore();
    const rs = results(out);
    expect(rs).toHaveLength(1);
    expect(JSON.parse(rs[0]!.data)).toEqual({ type: "error", error: "The hedge agent failed." });
  });

  it("ends with the out-of-time result when the agent's model call times out", async () => {
    const client = {
      chat: {
        completions: {
          create: async () => {
            throw new OpenAI.APIConnectionTimeoutError();
          },
        },
      },
    };
    const data = {} as MarketData;
    const out = await drain(
      hedgeSseStream((onEvent) => runHedgeAgent({ messages: [{ role: "user", content: "x" }] }, { client, model: "m", data, deadlineMs: 20_000, onEvent })),
    );
    const fs = frames(out);
    expect(fs.map((f) => f.event)).toEqual(["step", "result"]); // the model step started, never finished
    expect(JSON.parse(fs[1]!.data)).toEqual({ type: "error", error: expect.stringContaining("ran out of time") });
  });

  it("sends ping comments while the run is slow", async () => {
    vi.useFakeTimers();
    let finish!: (r: HedgeResponse) => void;
    const stream = hedgeSseStream(() => new Promise<HedgeResponse>((res) => (finish = res)), { pingMs: 15_000 });
    const text = drain(stream);
    await vi.advanceTimersByTimeAsync(31_000);
    finish({ type: "question", question: "q" });
    vi.useRealTimers();
    const out = await text;
    expect(out.match(/^: ping$/gm)).toHaveLength(2);
    expect(results(out)).toHaveLength(1);
  });

  it("stops writing once the client disconnects, without throwing", async () => {
    const ctrl = new AbortController();
    let emitLater!: () => void;
    const done = new Promise<void>((r) => (emitLater = r));
    const stream = hedgeSseStream(
      async (emit) => {
        emit(step(1, "start"));
        await done;
        emit(step(1, "done")); // after the disconnect: dropped
        return { type: "question", question: "q" };
      },
      { signal: ctrl.signal },
    );
    const reader = stream.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"phase":"start"');
    ctrl.abort();
    emitLater();
    await new Promise((r) => setTimeout(r, 0));
    const next = await reader.read();
    expect(next.done).toBe(true);
  });

  it("stops writing when the reader cancels", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let ran = false;
    const stream = hedgeSseStream(async (emit) => {
      await gate;
      emit(step(1, "start"));
      ran = true;
      return { type: "question", question: "q" };
    });
    await stream.cancel();
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(ran).toBe(true); // the run finished and its writes were dropped without an error
  });
});
