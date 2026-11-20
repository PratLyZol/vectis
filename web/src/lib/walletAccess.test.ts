import { describe, expect, it } from "vitest";
import { UnauthorizedProviderError, UserRejectedRequestError, getAddress, type Address } from "viem";
import { errorMessage } from "./format";
import { WALLET_ACCESS_MESSAGE, WalletAccessError, isUnauthorized, isUserRejected, requestAccess, walletSession, type Eip1193 } from "./walletAccess";

const A = getAddress("0x00000000000000000000000000000000000000aa");
const B = getAddress("0x00000000000000000000000000000000000000bb");

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

/**
 * A fake EIP-1193 wallet. `before` is what eth_accounts lists until a prompt is answered; each
 * prompt (eth_requestAccounts or wallet_requestPermissions) then exposes `after`, or throws.
 */
function wallet(opts: { before: Address[]; after: Address[]; permissions?: unknown }) {
  const methods: string[] = [];
  let exposed = opts.before;
  const provider: Eip1193 = {
    request: async ({ method }) => {
      methods.push(method);
      if (method === "eth_accounts") return exposed;
      if (method === "eth_requestAccounts") {
        exposed = opts.after;
        return exposed;
      }
      if (method === "wallet_requestPermissions") {
        if (opts.permissions) throw opts.permissions;
        exposed = opts.after;
        return [{ parentCapability: "eth_accounts" }];
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const prompts = () => methods.filter((m) => m === "eth_requestAccounts" || m === "wallet_requestPermissions");
  return { provider, methods, prompts };
}

/** One Buy click: the send is refused (4100) until the wallet has prompted, then succeeds. */
async function click(w: ReturnType<typeof wallet>, stillRefused = false) {
  const sends: (Address | undefined)[] = [];
  const run = walletSession({
    account: () => A,
    reauthorize: async () => {
      const next = (await requestAccess(w.provider, A))[0];
      if (!next) throw new WalletAccessError();
      return next;
    },
  });
  const result = await run(async (account) => {
    sends.push(account);
    if (sends.length === 1 || stillRefused) throw unauthorized();
    return "hash";
  }).catch((e: unknown) => e);
  return { result, sends };
}

describe("requestAccess", () => {
  it("locked then unlocked: one unlock prompt, no permission prompt, and the retry succeeds", async () => {
    const w = wallet({ before: [], after: [A] });
    const { result, sends } = await click(w);
    expect(result).toBe("hash");
    expect(w.prompts()).toEqual(["eth_requestAccounts"]);
    expect(sends).toEqual([A, A]);
  });

  it("escalates once to the permission prompt when the refused account was already listed", async () => {
    const w = wallet({ before: [A], after: [B] });
    const { result, sends } = await click(w);
    expect(result).toBe("hash");
    expect(w.prompts()).toEqual(["eth_requestAccounts", "wallet_requestPermissions"]);
    expect(sends).toEqual([A, B]);
  });

  it("escalates when no account comes back", async () => {
    const w = wallet({ before: [], after: [] });
    const { result, sends } = await click(w);
    expect(w.prompts()).toEqual(["eth_requestAccounts", "wallet_requestPermissions"]);
    expect(errorMessage(result)).toBe(WALLET_ACCESS_MESSAGE);
    expect(sends).toHaveLength(1);
  });

  for (const [what, err] of [
    ["unsupported (4200)", { code: 4200, message: "The Provider does not support the requested method." }],
    ["unsupported (-32601)", { code: -32601, message: "Method not found" }],
    ["already pending (-32002)", { code: -32002, message: "Request of type 'wallet_requestPermissions' already pending" }],
  ] as const) {
    it(`falls through when the permission prompt is ${what}: no raw error`, async () => {
      const w = wallet({ before: [A], after: [A], permissions: err });
      const { result, sends } = await click(w, true);
      // Retried with what the wallet exposes; refused again, so the plain message, never the raw text.
      expect(sends).toEqual([A, A]);
      expect(errorMessage(result)).toBe(WALLET_ACCESS_MESSAGE);
    });
  }

  it("stops without a retry when the permission prompt is rejected (4001)", async () => {
    const w = wallet({ before: [A], after: [A], permissions: rejected() });
    const { result, sends } = await click(w);
    expect(isUserRejected(result)).toBe(true);
    expect(sends).toHaveLength(1);
  });
});
