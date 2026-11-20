// Recovering from a wallet that has not authorised this site (EIP-1193 error 4100, viem's
// UnauthorizedProviderError). That happens when wagmi restored a connection from storage but the
// wallet has since locked, revoked the site or moved to an account the site was never given.
// Instead of failing, ask the wallet for access again and retry the action once.
import type { Address } from "viem";

export const WALLET_ACCESS_MESSAGE =
  "Your wallet has not given this site access to the selected account. Open your wallet and connect it, then try again.";

/** Raised when access could not be recovered; its message is the plain one above. */
export class WalletAccessError extends Error {
  constructor(cause?: unknown) {
    super(WALLET_ACCESS_MESSAGE, { cause });
    this.name = "WalletAccessError";
  }
}

type Coded = { code?: unknown; name?: unknown; cause?: unknown };

/** True if `e` or any error in its `cause` chain matches (viem and wagmi wrap provider errors). */
function inChain(e: unknown, match: (o: Coded) => boolean): boolean {
  let cur: unknown = e;
  for (let depth = 0; depth < 8 && typeof cur === "object" && cur !== null; depth++) {
    const o = cur as Coded;
    if (match(o)) return true;
    cur = o.cause;
  }
  return false;
}

export const isUnauthorized = (e: unknown) => inChain(e, (o) => o.code === 4100 || o.name === "UnauthorizedProviderError");
export const isUserRejected = (e: unknown) => inChain(e, (o) => o.code === 4001 || o.name === "UserRejectedRequestError");

export type WalletRun = <T>(action: (account: Address | undefined) => Promise<T>) => Promise<T>;

/**
 * Wallet access for one click. `run(action)` calls the action with the current account; if it
 * fails with 4100, the wallet is asked for access once (`reauthorize` resolves with the account it
 * authorised and leaves the wallet on the app's chain) and the action is retried once with that
 * account. Later actions in the same click use that account too. A second 4100 in the click, or a
 * 4100 from the prompt itself, becomes a WalletAccessError. A rejected prompt (4001) and every
 * other error pass through unchanged. Never loops.
 */
export function walletSession(opts: { account: () => Address | undefined; reauthorize: () => Promise<Address> }): WalletRun {
  let reauthorized = false;
  let granted: Address | undefined;
  const fail = (e: unknown) => (isUnauthorized(e) ? new WalletAccessError(e) : e);
  return async (action) => {
    try {
      return await action(granted ?? opts.account());
    } catch (e) {
      if (!isUnauthorized(e)) throw e;
      if (reauthorized) throw new WalletAccessError(e);
      reauthorized = true;
      try {
        granted = await opts.reauthorize();
      } catch (r) {
        throw fail(r);
      }
      try {
        return await action(granted);
      } catch (e2) {
        throw fail(e2);
      }
    }
  };
}

/** The account an action must send from; a missing one means no wallet is connected. */
export function needAccount(account: Address | undefined): Address {
  if (!account) throw new Error("Connect a wallet first.");
  return account;
}
