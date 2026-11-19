import type { Metadata } from "next";
import { CombosBrowser } from "@/components/CombosBrowser";

export const metadata: Metadata = {
  title: "Combos",
  description:
    "Build a combo of two to six Gemini prediction-market legs and trade it with leverage. Combo prices are calculated from the legs.",
};

export default function CombosPage() {
  return (
    <>
      <h1 className="text-[28px] md:text-[36px]">Leveraged combos</h1>
      <CombosBrowser />
    </>
  );
}
