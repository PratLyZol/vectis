// Single markets someone wants to trade that the keeper may not price yet. The hedge page posts
// the legs it proposes; the keeper polls GET, then registers and prices each market.
import { NextResponse } from "next/server";
import { listMarketRequests, requestMarkets } from "@/lib/marketRequests.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_CHARS = 4096;
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  return NextResponse.json(await listMarketRequests(), { headers: NO_STORE });
}

export async function POST(request: Request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) return NextResponse.json({ error: "Request too large." }, { status: 413, headers: NO_STORE });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400, headers: NO_STORE });
  }
  const result = await requestMarkets(body);
  return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
}
