// Hedge agent endpoint. The browser posts the conversation (and the current, possibly edited,
// proposal); the agent answers with one clarifying question or a server-validated proposal.
// Read-only: positions are opened by the browser after the user confirms.
import { NextResponse } from "next/server";
import OpenAI from "openai";
import { runHedgeAgent } from "@/lib/hedge/agent.server";
import { veniceClient, veniceModel } from "@/lib/hedge/venice.server";
import type { HedgeMessage, HedgeProposal, HedgeResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
  return Array.isArray(p.legs) && typeof p.exposure === "object" && p.exposure !== null ? (p as HedgeProposal) : null;
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

  try {
    const result = await runHedgeAgent({ messages, proposal: parseProposal(body.proposal) }, { client, model: veniceModel() });
    return json(result, result.type === "error" ? 502 : 200);
  } catch (e) {
    if (e instanceof OpenAI.RateLimitError) return json({ type: "error", error: "The AI provider is rate limiting. Try again shortly." }, 429);
    if (e instanceof OpenAI.AuthenticationError) return json({ type: "error", error: "The AI provider rejected the API key." }, 502);
    if (e instanceof OpenAI.APIError) {
      console.error("hedge agent: provider error", e.status, e.message);
      return json({ type: "error", error: "The AI provider returned an error." }, 502);
    }
    console.error("hedge agent failed", e);
    return json({ type: "error", error: "The hedge agent failed." }, 500);
  }
}
