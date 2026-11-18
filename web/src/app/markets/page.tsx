import type { Metadata } from "next";
import { getMarkets } from "@/lib/gemini";
import { MarketsBrowser } from "@/components/MarketsBrowser";

// Regenerated at most every 15 seconds; the browser then refreshes prices from /api/markets.
export const revalidate = 15;

export const metadata: Metadata = {
  title: "Markets",
  description: "Every active Gemini prediction market Vectis has loaded, with Yes and No prices, volume and the leverage each allows.",
};

export default async function MarketsPage() {
  const initial = await getMarkets();
  return (
    <>
      <h1 className="text-[28px] md:text-[36px]">Prediction markets with up to 5x leverage</h1>
      <p className="mt-3 max-w-[62ch] text-muted">
        Pick a Gemini prediction market, post USDC margin and borrow the rest from the Vectis vault. Positions
        settle on Arc testnet.
      </p>
      <MarketsBrowser initial={initial} />
    </>
  );
}
