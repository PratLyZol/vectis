import type { Metadata } from "next";
import { VaultCard } from "@/components/VaultCard";

export const metadata: Metadata = {
  title: "Vault",
  description:
    "Deposit USDC into the Vectis lending vault. Traders borrow from it and pay lenders 1% of the amount borrowed when a position opens.",
};

export default function VaultPage() {
  return (
    <>
      <h1 className="text-[28px] md:text-[36px]">Vault</h1>
      <VaultCard />
    </>
  );
}
