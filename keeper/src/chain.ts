// viem clients, revert decoding and the single serialized transaction queue.
import {
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  defineChain,
  erc20Abi,
  http,
  parseGwei,
  type Abi,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { lendingVaultAbi, marginManagerAbi, priceOracleAbi } from "./abis.js";
import { errText, logger } from "./log.js";

const log = logger("chain");

/** Arc drops transactions priced under 20 gwei without an error, so this is a hard floor. */
export const MIN_MAX_FEE = parseGwei("20");
export const PRIORITY_FEE = parseGwei("1");

export interface Clients {
  chain: Chain;
  account: Account;
  publicClient: PublicClient<Transport, Chain>;
  walletClient: WalletClient<Transport, Chain, Account>;
}

/** Build the chain from the RPC's real chain id so anvil (31337) and Arc (5042002) both work. */
export async function createClients(rpcUrl: string, privateKey: Hex): Promise<Clients> {
  const transport = http(rpcUrl, { timeout: 20_000, retryCount: 2 });
  const probe = createPublicClient({ transport });
  const chainId = await probe.getChainId();
  const chain = defineChain({
    id: chainId,
    name: chainId === 5042002 ? "Arc Testnet" : chainId === 31337 ? "Anvil" : `chain-${chainId}`,
    // Arc's native gas token is USDC with 18 decimals; on anvil the label is cosmetic.
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const account = privateKeyToAccount(privateKey);
  return {
    chain,
    account,
    publicClient: createPublicClient({ chain, transport, pollingInterval: 700 }),
    walletClient: createWalletClient({ chain, transport, account }),
  };
}

/** maxFeePerGas = max(20 gwei, 2 x base fee), never below the priority fee. */
export function computeFees(baseFee: bigint | null | undefined, bumpPct = 100n) {
  let maxFeePerGas = (baseFee ?? 0n) * 2n;
  if (maxFeePerGas < MIN_MAX_FEE) maxFeePerGas = MIN_MAX_FEE;
  let maxPriorityFeePerGas = PRIORITY_FEE;
  if (bumpPct !== 100n) {
    maxFeePerGas = (maxFeePerGas * bumpPct) / 100n;
    maxPriorityFeePerGas = (maxPriorityFeePerGas * bumpPct) / 100n;
  }
  if (maxFeePerGas < maxPriorityFeePerGas) maxFeePerGas = maxPriorityFeePerGas;
  return { maxFeePerGas, maxPriorityFeePerGas };
}

const ERROR_ABI: Abi = [...priceOracleAbi, ...marginManagerAbi, ...lendingVaultAbi, ...erc20Abi].filter(
  (item) => item.type === "error",
) as Abi;

function findRevertData(err: unknown, depth = 0): Hex | undefined {
  if (!err || typeof err !== "object" || depth > 8) return undefined;
  const e = err as { data?: unknown; cause?: unknown };
  if (typeof e.data === "string" && /^0x[0-9a-fA-F]*$/.test(e.data) && e.data.length >= 10) return e.data as Hex;
  if (e.data && typeof e.data === "object") {
    const inner = findRevertData(e.data, depth + 1);
    if (inner) return inner;
  }
  return findRevertData(e.cause, depth + 1);
}

/** Human-readable revert reason: decoded custom error when possible, otherwise the short message. */
export function revertReason(err: unknown): string {
  const data = findRevertData(err);
  if (data) {
    try {
      const decoded = decodeErrorResult({ abi: ERROR_ABI, data });
      const args = (decoded.args ?? []).map((a) => String(a)).join(", ");
      return `${decoded.errorName}(${args})`;
    } catch {
      try {
        // Error(string) / Panic(uint256)
        const decoded = decodeErrorResult({ data });
        return `${decoded.errorName}(${(decoded.args ?? []).map((a) => String(a)).join(", ")})`;
      } catch {
        return `revert data ${data.slice(0, 10)}: ${errText(err, 160)}`;
      }
    }
  }
  return errText(err);
}

export class TxError extends Error {
  constructor(
    message: string,
    /** True when the call reverted in simulation or on-chain (as opposed to an RPC failure). */
    readonly reverted: boolean,
  ) {
    super(message);
  }
}

/**
 * All writes go through this queue: one transaction at a time, local nonce tracking, EIP-1559
 * fees with the Arc floor, wait for the receipt before the next send.
 */
export class TxQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private nonce: number | null = null;
  private bumpPct = 100n;
  private pending = 0;

  constructor(private readonly clients: Clients) {}

  get depth(): number {
    return this.pending;
  }

  /** Resolves when everything queued so far has settled. */
  async drain(): Promise<void> {
    await this.tail.catch(() => undefined);
  }

  send(label: string, to: Address, data: Hex): Promise<Hex> {
    this.pending++;
    const run = this.tail.then(() => this.execute(label, to, data)).finally(() => this.pending--);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async execute(label: string, to: Address, data: Hex): Promise<Hex> {
    const { publicClient, walletClient, account } = this.clients;

    // Estimating doubles as simulation: a revert surfaces here with its reason, before any send.
    let gas: bigint;
    try {
      gas = await publicClient.estimateGas({ account: account.address, to, data });
    } catch (err) {
      const hasData = findRevertData(err) !== undefined;
      const text = revertReason(err);
      throw new TxError(`${label} would revert: ${text}`, hasData || /revert/i.test(text));
    }

    let hash: Hex;
    try {
      if (this.nonce === null) {
        this.nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
      }
      const block = await publicClient.getBlock({ blockTag: "latest" });
      const fees = computeFees(block.baseFeePerGas, this.bumpPct);
      hash = await walletClient.sendTransaction({
        to,
        data,
        nonce: this.nonce,
        gas: (gas * 13n) / 10n + 10_000n,
        ...fees,
      });
      this.nonce++;
    } catch (err) {
      this.nonce = null; // resync from the chain on the next send
      throw new TxError(`${label} send failed: ${revertReason(err)}`, false);
    }

    try {
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
      this.bumpPct = 100n;
      if (receipt.status !== "success") {
        throw new TxError(`${label} reverted on-chain (tx ${hash})`, true);
      }
      log.info(`${label} confirmed`, { tx: hash, block: receipt.blockNumber, gasUsed: receipt.gasUsed });
      return hash;
    } catch (err) {
      if (err instanceof TxError) throw err;
      // No receipt in time: the tx may be stuck. Reuse its nonce with higher fees next time.
      try {
        this.nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "latest" });
      } catch {
        this.nonce = null;
      }
      this.bumpPct = 150n;
      throw new TxError(`${label} not confirmed within 60s (tx ${hash}): ${errText(err, 120)}`, false);
    }
  }
}
