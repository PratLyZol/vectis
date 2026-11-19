// Server only: imported by app/api/hedge/route.ts. Venice AI is OpenAI-compatible, so the
// official `openai` client is pointed at Venice's base URL. The key never reaches the browser.
import OpenAI from "openai";

export const VENICE_BASE_URL = "https://api.venice.ai/api/v1";
// Any Venice text model with supportsFunctionCalling works; override with VENICE_MODEL.
export const DEFAULT_VENICE_MODEL = "kimi-k3";

let client: OpenAI | null = null;

/** null when VENICE_API_KEY is not set. */
export function veniceClient(): OpenAI | null {
  const apiKey = process.env.VENICE_API_KEY;
  if (!apiKey) return null;
  client ??= new OpenAI({ apiKey, baseURL: VENICE_BASE_URL, timeout: 45_000, maxRetries: 1 });
  return client;
}

export const veniceModel = () => process.env.VENICE_MODEL || DEFAULT_VENICE_MODEL;

const EFFORTS = ["low", "medium", "high"] as const;
type Effort = (typeof EFFORTS)[number];
// Reasoning models spend most of each step thinking; "low" keeps a full search-and-size loop
// inside the route's time budget. Override with VENICE_REASONING_EFFORT.
export const veniceReasoningEffort = (): Effort => {
  const v = process.env.VENICE_REASONING_EFFORT as Effort | undefined;
  return v && EFFORTS.includes(v) ? v : "low";
};
