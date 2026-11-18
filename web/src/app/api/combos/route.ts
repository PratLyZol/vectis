// Combos: Gemini's active combos merged with the ones someone asked Vectis to trade.
import { NextResponse, type NextRequest } from "next/server";
import type { CombosResponse } from "@/lib/combo";
import { listCombos, listRequested, requestCombo } from "@/lib/combos.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_CHARS = 4096;
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: NextRequest) {
  if (request.nextUrl.searchParams.get("requested") === "1") {
    // The keeper's poll: one SELECT, no Gemini calls, no prices.
    const rows = await listRequested();
    const body: CombosResponse = rows ? { source: "database", combos: rows } : { source: "none", combos: [] };
    return NextResponse.json(body, { headers: NO_STORE });
  }
  return NextResponse.json(await listCombos(), {
    headers: { "Cache-Control": "public, s-maxage=15, stale-while-revalidate=60" },
  });
}

export async function POST(request: Request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS)
    return NextResponse.json({ error: "The request body is too large.", code: "too_large" }, { status: 413, headers: NO_STORE });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "The request body is not JSON.", code: "bad_request" }, { status: 400, headers: NO_STORE });
  }
  const result = await requestCombo(body);
  return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
}
