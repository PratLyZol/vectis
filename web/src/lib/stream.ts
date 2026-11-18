// QuickNode Streams webhook helpers: signature check, log extraction and event decoding.
// Pure functions (no env, no database) so they can be unit-tested.
import { createHmac, timingSafeEqual } from "node:crypto";
import { decodeEventLog, erc4626Abi, type Abi, type Hex } from "viem";
import { lendingVaultAbi, marginManagerAbi } from "@/config/abis";

export const MAX_SKEW_SECONDS = 600;

/** Hex HMAC-SHA256 over `nonce + timestamp + rawBody`, keyed with the stream's security token. */
export function signStreamPayload(nonce: string, timestamp: string, rawBody: string, token: string): string {
  return createHmac("sha256", Buffer.from(token, "utf8"))
    .update(nonce + timestamp + rawBody, "utf8")
    .digest("hex");
}

export type SignatureCheck = { ok: true } | { ok: false; reason: string };

export function verifyStreamSignature(input: {
  nonce: string | null;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  token: string;
  nowSeconds: number;
}): SignatureCheck {
  const { nonce, timestamp, signature, rawBody, token, nowSeconds } = input;
  if (!nonce || !timestamp || !signature) return { ok: false, reason: "missing signature headers" };
  if (!/^\d{1,16}$/.test(timestamp)) return { ok: false, reason: "bad timestamp" };
  let ts = Number(timestamp);
  if (ts > 1e11) ts = Math.floor(ts / 1000); // tolerate milliseconds
  if (Math.abs(nowSeconds - ts) > MAX_SKEW_SECONDS) return { ok: false, reason: "timestamp outside window" };

  const expected = Buffer.from(signStreamPayload(nonce, timestamp, rawBody, token), "utf8");
  const given = Buffer.from(signature.trim().toLowerCase().replace(/^0x/, ""), "utf8");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "signature mismatch" };
  }
  return { ok: true };
}

export type RawLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber?: string | number;
  transactionHash: string;
  logIndex?: string | number;
};

const MAX_DEPTH = 12;

/**
 * Collect every log-shaped object anywhere in a parsed payload. Handles `{logs: [...]}`,
 * `{data: ..., metadata: ...}` wrappers and the nested arrays of an unfiltered logs dataset.
 */
export function extractLogs(payload: unknown): RawLog[] {
  const out: RawLog[] = [];
  const walk = (node: unknown, depth: number) => {
    if (node === null || typeof node !== "object" || depth > MAX_DEPTH) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const o = node as Record<string, unknown>;
    if (
      typeof o.address === "string" &&
      Array.isArray(o.topics) &&
      o.topics.every((t) => typeof t === "string") &&
      typeof o.transactionHash === "string"
    ) {
      out.push({
        address: o.address,
        topics: o.topics as string[],
        data: typeof o.data === "string" ? o.data : "0x",
        blockNumber: o.blockNumber as string | number | undefined,
        transactionHash: o.transactionHash,
        logIndex: o.logIndex as string | number | undefined,
      });
      return;
    }
    for (const value of Object.values(o)) walk(value, depth + 1);
  };
  walk(payload, 0);
  return out;
}

export const MANAGER_EVENTS = [
  "PositionOpened",
  "FillRecorded",
  "PositionClosed",
  "PositionLiquidated",
  "PositionSettled",
  "OpenFeePaid",
] as const;
export const VAULT_EVENTS = ["Deposit", "Withdraw", "Borrowed", "Repaid", "FeeCollected"] as const;

const vaultAbi = [...lendingVaultAbi, ...erc4626Abi] as Abi;
const managerAbi = marginManagerAbi as Abi;

export type StreamRow = {
  id: string; // `${chainId}:${txHash}:${logIndex}`
  chainId: number;
  blockNumber: number;
  txHash: string;
  logIndex: number;
  address: string; // lowercased
  eventName: string;
  positionId: string | null; // decimal string
  owner: string | null; // lowercased
  marketId: string | null;
  args: Record<string, unknown>; // bigints as decimal strings
};

const toInt = (v: string | number | undefined): number | null => {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? v : null;
  if (typeof v !== "string" || v === "") return null;
  const n = Number(v); // accepts "0x1a" and "26"
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

/** JSON-safe copy of decoded args: bigints become decimal strings. */
export function jsonArgs(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonArgs);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, jsonArgs(v)]));
  }
  return value;
}

/**
 * Decode one log into a storable row, or null when it is not from our contracts, is not one of
 * the stored events, or does not decode.
 */
export function decodeStreamLog(
  log: RawLog,
  target: { chainId: number; marginManager: string; lendingVault: string },
): StreamRow | null {
  const address = log.address.toLowerCase();
  const isManager = address === target.marginManager.toLowerCase();
  const isVault = address === target.lendingVault.toLowerCase();
  if (!isManager && !isVault) return null;

  const blockNumber = toInt(log.blockNumber);
  const logIndex = toInt(log.logIndex);
  if (blockNumber === null || logIndex === null) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(log.transactionHash) || log.topics.length === 0) return null;

  let eventName: string;
  let args: Record<string, unknown>;
  try {
    const decoded = decodeEventLog({
      abi: isManager ? managerAbi : vaultAbi,
      topics: log.topics as [Hex, ...Hex[]],
      data: (log.data || "0x") as Hex,
    });
    if (!decoded.eventName || !decoded.args || Array.isArray(decoded.args)) return null;
    eventName = decoded.eventName;
    args = jsonArgs(decoded.args) as Record<string, unknown>;
  } catch {
    return null;
  }

  const stored: readonly string[] = isManager ? MANAGER_EVENTS : VAULT_EVENTS;
  if (!stored.includes(eventName)) return null;

  const txHash = log.transactionHash.toLowerCase();
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  // viem's ERC-4626 ABI names the share recipient of Deposit `receiver`; OpenZeppelin calls the
  // same indexed argument `owner`. Store it under `owner` so every row uses one name.
  if (eventName === "Deposit" && args.owner === undefined && typeof args.receiver === "string") {
    args = { ...args, owner: args.receiver };
  }
  return {
    id: `${target.chainId}:${txHash}:${logIndex}`,
    chainId: target.chainId,
    blockNumber,
    txHash,
    logIndex,
    address,
    eventName,
    positionId: isManager ? str(args.id) : null,
    owner: str(args.owner)?.toLowerCase() ?? null,
    marketId: str(args.marketId),
    args,
  };
}
