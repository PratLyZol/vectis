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
      <p className="mt-3 max-w-[62ch] text-muted">
        Tell the hedge agent what you hold, owe or pay for: a position, a loan, a business cost. It searches Gemini prediction
        markets for positions that pay when that exposure hurts you, sizes them to your budget and explains the risks. Edit
        anything, then confirm to open the positions.
      </p>
      <HedgeAgent />
    </>
  );
}
