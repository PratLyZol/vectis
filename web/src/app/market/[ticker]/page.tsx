import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getEvent } from "@/lib/gemini";
import { MarketView } from "@/components/MarketView";
import { SIDE_NO, SIDE_YES } from "@/lib/math";

type Props = {
  params: Promise<{ ticker: string }>;
  searchParams: Promise<{ c?: string | string[]; side?: string | string[] }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { ticker } = await params;
  const data = await getEvent(decodeURIComponent(ticker));
  if (!data) return { title: "Market not found" };
  return {
    title: data.event.title,
    description: `Order book and leveraged Yes or No positions on ${data.event.title}, a Gemini prediction market.`,
  };
}

export default async function MarketPage({ params, searchParams }: Props) {
  const [{ ticker }, { c, side }] = await Promise.all([params, searchParams]);
  const data = await getEvent(decodeURIComponent(ticker));
  if (!data) notFound();
  const wanted = Array.isArray(c) ? c[0] : c;
  const initialSymbol = data.event.contracts.some((x) => x.symbol === wanted) ? wanted : undefined;
  // `side=no` preselects the No side; anything else is Yes.
  const initialSide = (Array.isArray(side) ? side[0] : side) === "no" ? SIDE_NO : SIDE_YES;
  return <MarketView initial={data} initialSymbol={initialSymbol} initialSide={initialSide} />;
}
