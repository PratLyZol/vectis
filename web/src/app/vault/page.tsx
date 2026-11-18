import type { Metadata } from "next";
import Link from "next/link";
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
      <p className="mt-3 max-w-[62ch] text-muted">
        An ERC-4626 vault of USDC on Arc testnet. Traders borrow from it to open leveraged positions and pay
        lenders 1% of what they borrow.{" "}
        <Link className="link" href="/lend">
          Read how lending works
        </Link>
      </p>
      <VaultCard />
    </>
  );
}
