import { NextResponse } from "next/server";
import { getEvent } from "@/lib/gemini";

const CACHE = "public, s-maxage=15, stale-while-revalidate=60";

export async function GET(_request: Request, { params }: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await params;
  const data = await getEvent(ticker);
  if (!data) return NextResponse.json({ error: "Market not found" }, { status: 404 });
  return NextResponse.json(data, { headers: { "Cache-Control": CACHE } });
}
