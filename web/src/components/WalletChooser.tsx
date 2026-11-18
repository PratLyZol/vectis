"use client";

import { useEffect, useRef } from "react";
import { useWallet } from "@/hooks/useChain";
import { errorMessage } from "@/lib/format";
import { closeWalletChooser, useWalletChooserOpen } from "@/lib/walletChooser";

/**
 * Lists the wallets installed in this browser. Needed because several wallet extensions fight over
 * `window.ethereum`; each one is addressed directly here (EIP-6963) instead.
 */
export function WalletChooser() {
  const open = useWalletChooserOpen();
  const wallet = useWallet();
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // Close once a wallet is connected.
  useEffect(() => {
    if (wallet.connected) closeWalletChooser();
  }, [wallet.connected]);

  return (
    <dialog
      ref={ref}
      className="wallet-dialog"
      aria-labelledby="wallet-dialog-title"
      onClose={closeWalletChooser}
      onClick={(e) => {
        if (e.target === ref.current) closeWalletChooser(); // click on the backdrop
      }}
    >
      <div className="p-5">
        <h2 id="wallet-dialog-title" className="text-[17px] font-medium text-text">
          Connect a wallet
        </h2>
        <p className="mt-1 text-[13px] text-muted">Vectis runs on Arc Testnet. Your wallet will ask to add it.</p>

        {wallet.options.length === 0 ? (
          <p className="mt-4 text-[14px] text-text-2">
            No browser wallet was found. Install a wallet extension such as MetaMask, then reload this page.
          </p>
        ) : (
          <ul className="mt-4 flex flex-col gap-2">
            {wallet.options.map((option) => (
              <li key={option.uid}>
                <button
                  type="button"
                  className="btn btn-secondary w-full justify-start"
                  disabled={wallet.connecting}
                  onClick={() => wallet.connectWith(option)}
                >
                  {option.icon ? (
                    // eslint-disable-next-line @next/next/no-img-element -- data URI supplied by the wallet
                    <img src={option.icon} alt="" width={22} height={22} />
                  ) : null}
                  <span>{option.name === "Injected" ? "Browser wallet" : option.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <p role="status" className="mt-3 min-h-[18px] text-[13px] text-danger">
          {wallet.connecting ? (
            <span className="text-muted">Waiting for the wallet…</span>
          ) : wallet.error ? (
            errorMessage(wallet.error)
          ) : null}
        </p>

        <button type="button" className="btn btn-outline mt-2 w-full" onClick={closeWalletChooser}>
          Cancel
        </button>
      </div>
    </dialog>
  );
}
