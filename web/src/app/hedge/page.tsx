import type { Metadata } from "next";
import { HedgeAgent } from "@/components/HedgeAgent";

export const metadata: Metadata = {
  title: "Hedge",
  description: "Describe any exposure in plain English and get proposed prediction-market positions to hedge it.",
};

export default function HedgePage() {
  return (
    <>
      <h1 className="text-[28px] md:text-[36px]">Hedge a real-world exposure</h1>
      <HedgeAgent />
    </>
  );
}
