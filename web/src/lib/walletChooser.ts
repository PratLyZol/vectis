"use client";

// Open/closed state of the one wallet chooser dialog, shared by every "Connect wallet" button.
import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();

function set(next: boolean) {
  if (open === next) return;
  open = next;
  listeners.forEach((l) => l());
}

export const openWalletChooser = () => set(true);
export const closeWalletChooser = () => set(false);

export function useWalletChooserOpen(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => open,
    () => false,
  );
}
