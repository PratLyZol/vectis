import { NextResponse } from "next/server";
import { getCandles } from "@/lib/replays.server";

const CACHE = "public, s-maxage=30, stale-while-revalidate=120";

export async function GET(_request: Request, { params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const data = await getCandles(symbol);
  if (!data) return NextResponse.json({ error: "No price history for this symbol" }, { status: 404 });
  return NextResponse.json(data, { headers: { "Cache-Control": CACHE } });
}
