import { NextResponse } from "next/server";
import { getCombo } from "@/lib/combos.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const combo = await getCombo(symbol);
  if (!combo) return NextResponse.json({ error: "Combo not found" }, { status: 404 });
  // Prices come from the legs' books, which are cached for 5 seconds.
  return NextResponse.json(combo, { headers: { "Cache-Control": "public, s-maxage=5, stale-while-revalidate=20" } });
}
