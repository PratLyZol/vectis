import type { Metadata } from "next";
import { Portfolio } from "@/components/Portfolio";

export const metadata: Metadata = {
  title: "Portfolio",
  description: "Your leveraged prediction-market positions on Vectis: entry, mark, liquidation price, PnL and health.",
};

export default function PortfolioPage() {
  return (
    <>
      <h1 className="text-[28px] md:text-[36px]">Portfolio</h1>
      <p className="mt-3 max-w-[62ch] text-muted">
        Positions are marked at the bid for their side. A position can be liquidated when its mark reaches the
        liquidation price.
      </p>
      <Portfolio />
    </>
  );
}
