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
      <p className="mt-3 max-w-[62ch] text-muted">
        A combo is one position on several outcomes at once. It pays $1 per contract only if every leg hits, so its
        price is the product of the legs&apos; prices.
      </p>
      <CombosBrowser />
    </>
  );
}
