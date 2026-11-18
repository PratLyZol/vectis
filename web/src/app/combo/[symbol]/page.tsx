import type { Metadata } from "next";
import { ComboView } from "@/components/ComboView";

export const metadata: Metadata = {
  title: "Combo",
  description: "A combo's legs, its price calculated from the legs, and a leveraged position on every leg hitting.",
};

export default async function ComboPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  return <ComboView symbol={decodeURIComponent(symbol)} />;
}
