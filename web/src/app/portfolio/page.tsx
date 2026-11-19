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
      <Portfolio />
    </>
  );
}
