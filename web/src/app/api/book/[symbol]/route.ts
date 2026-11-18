import { NextResponse } from "next/server";
import { getBook } from "@/lib/gemini";

const CACHE = "public, s-maxage=5, stale-while-revalidate=20";

export async function GET(_request: Request, { params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const data = await getBook(symbol);
  if (!data) return NextResponse.json({ error: "Unknown symbol" }, { status: 404 });
  return NextResponse.json(data, { headers: { "Cache-Control": CACHE } });
}
