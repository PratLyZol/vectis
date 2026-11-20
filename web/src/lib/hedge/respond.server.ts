// Server only: how /api/hedge turns an agent run into a response. Shared by the JSON path and the
// SSE path so both report failures with the same messages.
import OpenAI from "openai";
import type { HedgeResponse, HedgeStepEvent } from "../types";
import { SSE_PING, encodeSse } from "./sse";

export const PING_MS = 15_000;

/** The error body and status for an exception thrown by the agent (provider errors and bugs). */
export function hedgeFailure(e: unknown): { body: HedgeResponse; status: number } {
  if (e instanceof OpenAI.RateLimitError) return { body: { type: "error", error: "The AI provider is rate limiting. Try again shortly." }, status: 429 };
  if (e instanceof OpenAI.AuthenticationError) return { body: { type: "error", error: "The AI provider rejected the API key." }, status: 502 };
  if (e instanceof OpenAI.APIError) {
    console.error("hedge agent: provider error", e.status, e.message);
    return { body: { type: "error", error: "The AI provider returned an error." }, status: 502 };
  }
  console.error("hedge agent failed", e);
  return { body: { type: "error", error: "The hedge agent failed." }, status: 500 };
}

/**
 * An SSE body for one agent run: a `step` frame per progress event, a `: ping` comment every
 * `pingMs` so proxies keep the connection open, and exactly one `result` frame at the end, also
 * when the run throws. Once the client goes away (cancel or `signal`), nothing more is written;
 * the run itself is not interrupted.
 */
export function hedgeSseStream(
  run: (emit: (e: HedgeStepEvent) => void) => Promise<HedgeResponse>,
  opts: { signal?: AbortSignal; pingMs?: number } = {},
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let stopped = false;
  let ping: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    stopped = true;
    clearInterval(ping);
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (s: string) => {
        if (stopped) return;
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          stop();
        }
      };
      const finish = () => {
        if (stopped) return;
        stop();
        try {
          controller.close();
        } catch {
          // Already closed or errored.
        }
      };
      if (opts.signal?.aborted) {
        finish();
        return;
      }
      opts.signal?.addEventListener("abort", finish, { once: true });
      ping = setInterval(() => write(SSE_PING), opts.pingMs ?? PING_MS);
      let ended = false;
      void run((e) => {
        if (!ended) write(encodeSse({ event: "step", data: e }));
      })
        .catch((e: unknown) => hedgeFailure(e).body)
        .then((result) => {
          ended = true;
          write(encodeSse({ event: "result", data: result }));
          finish();
        });
    },
    cancel() {
      stop();
    },
  });
}
