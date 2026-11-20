import { describe, expect, it } from "vitest";
import { UnauthorizedProviderError, UserRejectedRequestError, type Address } from "viem";
import { errorMessage } from "./format";
import { WALLET_ACCESS_MESSAGE, WalletAccessError, isUnauthorized, isUserRejected, needsPermissionPrompt, walletSession } from "./walletAccess";

const A = "0x00000000000000000000000000000000000000aA" as Address;
const B = "0x00000000000000000000000000000000000000bB" as Address;

const unauthorized = () => new UnauthorizedProviderError(new Error("not authorized"));
// What wagmi's writeContract throws: viem's ContractFunctionExecutionError around the provider error.
const wrapped = (inner: unknown) => Object.assign(new Error("Execution reverted"), { name: "ContractFunctionExecutionError", cause: { name: "TransactionExecutionError", cause: inner } });
const rejected = () => new UserRejectedRequestError(new Error("User rejected the request."));

/** A session with counters, and an action that fails with the given errors in turn, then succeeds. */
function setup(failures: unknown[], reauth: () => Promise<Address> = async () => A) {
  const calls: (Address | undefined)[] = [];
  let reauths = 0;
  const run = walletSession({
    account: () => A,
    reauthorize: () => {
      reauths++;
      return reauth();
    },
  });
  const action = async (account: Address | undefined) => {
    calls.push(account);
    const e = failures.shift();
    if (e) throw e;
    return "hash";
  };
  return { run, action, calls, reauths: () => reauths };
}

describe("error matching", () => {
  it("finds 4100 at the top level, by code on a plain object, and nested in cause", () => {
    expect(isUnauthorized(unauthorized())).toBe(true);
    expect(isUnauthorized({ code: 4100, message: "x" })).toBe(true);
    expect(isUnauthorized(wrapped({ code: 4100 }))).toBe(true);
    expect(isUnauthorized(wrapped(new Error("nope")))).toBe(false);
    expect(isUserRejected(wrapped(rejected()))).toBe(true);
    expect(isUserRejected(unauthorized())).toBe(false);
  });

  it("gives the plain message instead of the raw text", () => {
    expect(errorMessage(wrapped(unauthorized()))).toBe(WALLET_ACCESS_MESSAGE);
    expect(errorMessage(new WalletAccessError())).toBe(WALLET_ACCESS_MESSAGE);
    expect(errorMessage(rejected())).toBe("User rejected the request.");
  });
});

describe("walletSession", () => {
  it("re-authorises once and retries once on a top-level 4100", async () => {
    const s = setup([unauthorized()]);
    await expect(s.run(s.action)).resolves.toBe("hash");
    expect(s.reauths()).toBe(1);
    expect(s.calls).toEqual([A, A]);
  });

  it("does the same for a 4100 nested in cause, and retries with the account the wallet authorised", async () => {
    const s = setup([wrapped({ code: 4100 })], async () => B);
    await expect(s.run(s.action)).resolves.toBe("hash");
    expect(s.reauths()).toBe(1);
    expect(s.calls).toEqual([A, B]);
    // Later actions in the same click use the new account and do not prompt again.
    await s.run(s.action);
    expect(s.calls.at(-1)).toBe(B);
    expect(s.reauths()).toBe(1);
  });

  it("stops without a retry when the user rejects the prompt (4001)", async () => {
    const s = setup([unauthorized()], async () => {
      throw rejected();
    });
    const err = await s.run(s.action).catch((e: unknown) => e);
    expect(isUserRejected(err)).toBe(true);
    expect(s.calls).toHaveLength(1);
  });

  it("does not retry a rejected transaction", async () => {
    const s = setup([rejected()]);
    await expect(s.run(s.action)).rejects.toBeInstanceOf(UserRejectedRequestError);
    expect(s.reauths()).toBe(0);
    expect(s.calls).toHaveLength(1);
  });

  it("surfaces the plain message on a second 4100 after re-authorising, and never loops", async () => {
    const s = setup([unauthorized(), wrapped(unauthorized()), unauthorized()]);
    const err = await s.run(s.action).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WalletAccessError);
    expect(errorMessage(err)).toBe(WALLET_ACCESS_MESSAGE);
    expect(s.calls).toHaveLength(2);
    // The budget is per click: a later 4100 in the same session does not prompt again.
    await expect(s.run(s.action)).rejects.toBeInstanceOf(WalletAccessError);
    expect(s.reauths()).toBe(1);
  });

  it("turns a 4100 from the prompt itself into the plain message", async () => {
    const s = setup([unauthorized()], async () => {
      throw unauthorized();
    });
    await expect(s.run(s.action)).rejects.toBeInstanceOf(WalletAccessError);
  });

  it("passes other errors through unchanged", async () => {
    const boom = new Error("insufficient funds");
    const s = setup([boom]);
    await expect(s.run(s.action)).rejects.toBe(boom);
    expect(s.reauths()).toBe(0);
  });
});

describe("needsPermissionPrompt", () => {
  it("asks for the permission prompt when no account came back or the refused one came back again", () => {
    expect(needsPermissionPrompt([], A)).toBe(true);
    expect(needsPermissionPrompt([A.toLowerCase() as Address], A)).toBe(true);
    expect(needsPermissionPrompt([B], A)).toBe(false);
    expect(needsPermissionPrompt([B], undefined)).toBe(false);
  });
});
