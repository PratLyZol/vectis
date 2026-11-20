// Server-Sent Events for the hedge agent, shared by the route (encoding) and the browser
// (decoding). The browser cannot POST with EventSource, so it reads the fetch body and decodes it
// here. Wire format: `event: step` and `event: thought` frames while the agent works, then exactly
// one `event: result`. Readers ignore event types they do not know, so either side can add one.
import type { HedgeResponse, HedgeStepEvent, HedgeStreamEvent, HedgeThoughtEvent } from "../types";

export const SSE_CONTENT_TYPE = "text/event-stream";

/** One SSE frame. JSON never contains a raw newline, so the data fits on one `data:` line. */
export function encodeSse(e: HedgeStreamEvent): string {
  return `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;
}

export const SSE_PING = ": ping\n\n";

export type SseFrame = { event: string; data: string };

/**
 * Incremental SSE decoder: feed it text chunks split anywhere, get whole frames back. Comment
 * lines (`: ping`) and unknown fields are skipped, as the spec says.
 */
export function createSseDecoder(onFrame: (f: SseFrame) => void) {
  let buf = "";
  let event = "";
  let data: string[] = [];
  const line = (l: string) => {
    if (l === "") {
      if (data.length) onFrame({ event: event || "message", data: data.join("\n") });
      event = "";
      data = [];
      return;
    }
    if (l.startsWith(":")) return;
    const i = l.indexOf(":");
    const field = i < 0 ? l : l.slice(0, i);
    let value = i < 0 ? "" : l.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  };
  return {
    push(chunk: string) {
      buf += chunk;
      let nl: number;
      while ((nl = buf.search(/\r\n|\r|\n/)) >= 0) {
        const len = buf[nl] === "\r" && buf[nl + 1] === "\n" ? 2 : 1;
        // A lone \r at the end may be the first half of \r\n: wait for the next chunk.
        if (buf[nl] === "\r" && len === 1 && nl === buf.length - 1) break;
        line(buf.slice(0, nl));
        buf = buf.slice(nl + len);
      }
    },
    end() {
      if (buf) line(buf);
      buf = "";
      line("");
    },
  };
}

function parseStep(v: unknown): HedgeStepEvent | null {
  if (typeof v !== "object" || v === null) return null;
  const s = v as Record<string, unknown>;
  if (typeof s.id !== "number" || (s.phase !== "start" && s.phase !== "done") || (s.kind !== "model" && s.kind !== "tool")) return null;
  if (typeof s.label !== "string") return null;
  return {
    id: s.id,
    phase: s.phase,
    kind: s.kind,
    label: s.label,
    ...(typeof s.tool === "string" ? { tool: s.tool } : {}),
    ...(typeof s.detail === "string" ? { detail: s.detail } : {}),
  };
}

const THOUGHT_MAX = 600;

function parseThought(v: unknown): HedgeThoughtEvent | null {
  if (typeof v !== "object" || v === null) return null;
  const t = v as Record<string, unknown>;
  if (typeof t.id !== "number" || typeof t.text !== "string") return null;
  const text = t.text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, THOUGHT_MAX);
  return text ? { id: t.id, text } : null;
}

function parseResult(v: unknown): HedgeResponse | null {
  if (typeof v !== "object" || v === null) return null;
  const t = (v as { type?: unknown }).type;
  return t === "question" || t === "proposal" || t === "error" ? (v as HedgeResponse) : null;
}

/**
 * Reads a hedge SSE body to the end. Calls `onStep` for each step and `onThought` for each thought,
 * and resolves with the result, or null if the stream ended without one. Other event types are
 * ignored. Rejects if the read fails (including on abort).
 */
export async function readHedgeStream(
  body: ReadableStream<Uint8Array>,
  onStep: (s: HedgeStepEvent) => void,
  onThought?: (t: HedgeThoughtEvent) => void,
): Promise<HedgeResponse | null> {
  let result: HedgeResponse | null = null;
  const decoder = createSseDecoder((f) => {
    let v: unknown;
    try {
      v = JSON.parse(f.data);
    } catch {
      return;
    }
    if (f.event === "step") {
      const s = parseStep(v);
      if (s && !result) onStep(s);
    } else if (f.event === "thought") {
      const t = parseThought(v);
      if (t && !result) onThought?.(t);
    } else if (f.event === "result" && !result) {
      result = parseResult(v);
    }
  });
  const reader = body.getReader();
  const text = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      decoder.push(text.decode(value, { stream: true }));
      if (result) break;
    }
    decoder.push(text.decode());
    decoder.end();
  } finally {
    reader.releaseLock();
  }
  return result;
}
