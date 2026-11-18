"use client";

import { useWallet, useWalletUsdc } from "@/hooks/useChain";
import { fmtUsdc, shortAddress } from "@/lib/format";

/** Connect, show the short address and USDC balance, or ask for the Arc network. */
export function WalletButton() {
  const wallet = useWallet();
  const balance = useWalletUsdc();
  // wagmi runs with `ssr: true`, so the wallet reads as disconnected on the server and on the
  // first browser render, then reconnects: the markup matches on both sides.
  if (!wallet.connected || !wallet.address) {
    return (
      <button
        type="button"
        className="btn btn-secondary"
        onClick={wallet.connect}
        disabled={wallet.connecting || !wallet.hasConnector}
      >
        {wallet.connecting ? "Connecting…" : "Connect wallet"}
      </button>
    );
  }

  if (wallet.wrongChain) {
    return (
      <button type="button" className="btn btn-primary" onClick={wallet.switchToArc} disabled={wallet.switching}>
        {wallet.switching ? "Switching…" : "Switch to Arc Testnet"}
      </button>
    );
  }

  return (
    <button
      type="button"
      className="btn btn-secondary"
      onClick={wallet.disconnect}
      title="Disconnect wallet"
    >
      <span className="num hidden text-[13px] text-muted sm:inline">
        {balance === undefined ? "…" : fmtUsdc(balance)} USDC
      </span>
      <span className="num text-[13px]">{shortAddress(wallet.address)}</span>
    </button>
  );
}
