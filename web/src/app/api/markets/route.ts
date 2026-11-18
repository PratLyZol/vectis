import { NextResponse, type NextRequest } from "next/server";
import { getMarkets } from "@/lib/gemini";

const CACHE = "public, s-maxage=15, stale-while-revalidate=60";

const int = (v: string | null, min: number, max: number): number | undefined => {
  if (v === null) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
};

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const data = await getMarkets({
    category: sp.get("category")?.slice(0, 60) || undefined,
    search: sp.get("search")?.slice(0, 80) || undefined,
    limit: int(sp.get("limit"), 1, 100),
    offset: int(sp.get("offset"), 0, 10_000),
  });
  return NextResponse.json(data, { headers: { "Cache-Control": CACHE } });
}
