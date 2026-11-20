// Hedge agent endpoint. The browser posts the conversation (and the current, possibly edited,
// proposal); the agent answers with one clarifying question or a server-validated proposal.
// Read-only: positions are opened by the browser after the user confirms.
//
// With `Accept: text/event-stream` the answer is streamed: a `step` event per tool-loop step and a
// `thought` event per short piece of model reasoning, then one `result` event carrying the same body the JSON path returns. Requests rejected before the
// agent starts (no key, bad body) get plain JSON either way.
import { NextResponse } from "next/server";
import { runHedgeAgent } from "@/lib/hedge/agent.server";
import { hedgeFailure, hedgeSseStream } from "@/lib/hedge/respond.server";
import { SSE_CONTENT_TYPE } from "@/lib/hedge/sse";
import { veniceClient, veniceModel, veniceReasoningEffort } from "@/lib/hedge/venice.server";
import type { HedgeMessage, HedgeProposal, HedgeResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 90; // above AGENT_DEADLINE_MS (75s)

const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGES = 16;
const MAX_MESSAGE_CHARS = 2000;

const json = (body: HedgeResponse, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

function parseMessages(v: unknown): HedgeMessage[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_MESSAGES) return null;
  const out: HedgeMessage[] = [];
  for (const m of v) {
    if (typeof m !== "object" || m === null) return null;
    const { role, content } = m as Record<string, unknown>;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") return null;
    const text = content.trim().slice(0, MAX_MESSAGE_CHARS);
    if (!text) return null;
    out.push({ role, content: text });
  }
  return out.at(-1)?.role === "user" ? out : null;
}

/** The proposal is only used as context for the model, so a shallow shape check is enough. */
function parseProposal(v: unknown): HedgeProposal | null {
  if (typeof v !== "object" || v === null) return null;
  const p = v as Partial<HedgeProposal>;
  return Array.isArray(p.legs) ? (p as HedgeProposal) : null;
}

export async function POST(req: Request) {
  const client = veniceClient();
  if (!client) return json({ type: "error", error: "The hedge agent is not configured (VENICE_API_KEY is missing)." }, 503);

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json({ type: "error", error: "Request too large." }, 413);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ type: "error", error: "Invalid JSON." }, 400);
  }
  const messages = parseMessages(body?.messages);
  if (!messages) return json({ type: "error", error: "Send 1-16 messages ending with a user message." }, 400);

  const input = { messages, proposal: parseProposal(body.proposal) };
  const deps = { client, model: veniceModel(), reasoningEffort: veniceReasoningEffort() };

  if ((req.headers.get("accept") ?? "").includes(SSE_CONTENT_TYPE)) {
    const stream = hedgeSseStream((onEvent, onThought) => runHedgeAgent(input, { ...deps, onEvent, onThought }), { signal: req.signal });
    return new Response(stream, {
      headers: {
        "Content-Type": SSE_CONTENT_TYPE,
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  }

  try {
    const result = await runHedgeAgent(input, deps);
    return json(result, result.type === "error" ? 502 : 200);
  } catch (e) {
    const { body, status } = hedgeFailure(e);
    return json(body, status);
  }
}
