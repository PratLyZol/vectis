// Recovering from a wallet that has not authorised this site (EIP-1193 error 4100, viem's
// UnauthorizedProviderError). That happens when wagmi restored a connection from storage but the
// wallet has since locked, revoked the site or moved to an account the site was never given.
// Instead of failing, ask the wallet for access again and retry the action once.
import { getAddress, isAddress, type Address } from "viem";

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

export type Eip1193 = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };

export const addressList = (v: unknown): Address[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && isAddress(x, { strict: false })).map((x) => getAddress(x)) : [];

const listed = (accounts: readonly Address[], a: Address | undefined) => a !== undefined && accounts.some((x) => x.toLowerCase() === a.toLowerCase());

/**
 * Ask the wallet for access after it refused `refused` with a 4100; resolves with the accounts it
 * then exposes. eth_requestAccounts first: it unlocks a locked wallet or reconnects the site. The
 * permission prompt (wallet_requestPermissions) follows only when that cannot have helped: the
 * refused account was already listed by eth_accounts beforehand (the wallet claims it is
 * permitted, so the same answer would be refused again; MetaMask returns it without a prompt), or
 * no account came back. A locked wallet lists nothing before and the account after, so it gets one
 * prompt. If the permission prompt is unsupported (4200, -32601) or already open (-32002), carry on
 * with what the wallet exposes; only a rejection (4001) stops here.
 */
export async function requestAccess(provider: Eip1193, refused: Address | undefined): Promise<Address[]> {
  const before = addressList(await provider.request({ method: "eth_accounts" }).catch(() => []));
  const accounts = addressList(await provider.request({ method: "eth_requestAccounts" }));
  if (accounts.length > 0 && !listed(before, refused)) return accounts;
  try {
    await provider.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
  } catch (e) {
    if (isUserRejected(e)) throw e;
  }
  return addressList(await provider.request({ method: "eth_accounts" }));
}

/** The account an action must send from; a missing one means no wallet is connected. */
export function needAccount(account: Address | undefined): Address {
  if (!account) throw new Error("Connect a wallet first.");
  return account;
}
