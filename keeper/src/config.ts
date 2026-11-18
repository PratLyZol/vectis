// Environment and address-file loading. Secrets are read here and never logged.
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { getAddress, isAddress, zeroAddress, type Address, type Hex } from "viem";

/** keeper/ package root, independent of the working directory. */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface Addresses {
  chainId: number;
  usdc: Address;
  priceOracle: Address;
  lendingVault: Address;
  marginManager: Address;
  deployBlock: bigint;
}

export interface Config {
  privateKey: Hex;
  rpcUrl: string;
  geminiPublicBase: string;
  geminiTradeBase: string;
  geminiApiKey: string;
  geminiApiSecret: string;
  /** True when no Gemini API key is configured: fills are simulated. */
  mock: boolean;
  marketCount: number;
  pollMs: number;
  heartbeatMs: number;
  scanEvents: number;
  /** Web app base URL serving /api/activity (QuickNode Streams feed). Empty = RPC polling only. */
  appUrl: string;
  streamPollMs: number;
  comboPollMs: number;
  /** Max combos tracked (combos with active positions are kept on top of this). */
  comboCount: number;
  symbols: string[];
  addressesFile: string;
  stateFile: string;
  addresses: Addresses;
}

export class ConfigError extends Error {}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new ConfigError(`${name} must be an integer >= ${min}`);
  return n;
}

function strEnv(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name]?.trim();
  return raw ? raw.replace(/\/+$/, "") : fallback;
}

export function parsePrivateKey(raw: string | undefined): Hex {
  const v = raw?.trim() ?? "";
  if (!v) throw new ConfigError("DEPLOYER_PRIVATE_KEY is not set (expected in ../.env)");
  const hex = v.startsWith("0x") || v.startsWith("0X") ? v.slice(2) : v;
  // Deliberately no echo of the value in the error.
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new ConfigError("DEPLOYER_PRIVATE_KEY is not a 32-byte hex string");
  return `0x${hex}`;
}

export function parseAddresses(json: unknown, file: string): Addresses {
  const o = (json ?? {}) as Record<string, unknown>;
  const addr = (key: string): Address => {
    const v = o[key];
    if (typeof v !== "string" || !isAddress(v, { strict: false })) {
      throw new ConfigError(`${file}: "${key}" is missing or not an address`);
    }
    return getAddress(v);
  };
  const out: Addresses = {
    chainId: Number(o.chainId),
    usdc: addr("usdc"),
    priceOracle: addr("priceOracle"),
    lendingVault: addr("lendingVault"),
    marginManager: addr("marginManager"),
    deployBlock: BigInt(typeof o.deployBlock === "number" || typeof o.deployBlock === "string" ? o.deployBlock : 0),
  };
  if (!Number.isInteger(out.chainId) || out.chainId <= 0) throw new ConfigError(`${file}: "chainId" is missing`);
  const zero = (["usdc", "priceOracle", "lendingVault", "marginManager"] as const).filter((k) => out[k] === zeroAddress);
  if (zero.length > 0) {
    throw new ConfigError(
      `${file}: ${zero.join(", ")} ${zero.length > 1 ? "are" : "is"} the zero address. ` +
        "Deploy the contracts first (the deploy script rewrites this file), then start the keeper.",
    );
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // The repo-root .env holds the wallet key; values already in the environment win.
  dotenv.config({ path: resolve(PACKAGE_ROOT, "..", ".env"), quiet: true });

  const addressesRaw = env.ADDRESSES_FILE?.trim() || "./addresses.json";
  const addressesFile = isAbsolute(addressesRaw) ? addressesRaw : resolve(PACKAGE_ROOT, addressesRaw);
  if (!existsSync(addressesFile)) throw new ConfigError(`addresses file not found: ${addressesFile}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(addressesFile, "utf8"));
  } catch {
    throw new ConfigError(`addresses file is not valid JSON: ${addressesFile}`);
  }
  const addresses = parseAddresses(parsed, addressesFile);

  const geminiApiKey = env.GEMINI_API_KEY?.trim() ?? "";
  const geminiApiSecret = env.GEMINI_API_SECRET?.trim() ?? "";
  if (geminiApiKey && !geminiApiSecret) throw new ConfigError("GEMINI_API_KEY is set but GEMINI_API_SECRET is empty");

  const pollMs = intEnv(env, "KEEPER_POLL_MS", 10_000, 1000);
  const heartbeatMs = intEnv(env, "KEEPER_HEARTBEAT_MS", 45_000, 1000);

  return {
    privateKey: parsePrivateKey(env.DEPLOYER_PRIVATE_KEY),
    rpcUrl: strEnv(env, "ARC_RPC_URL", "https://rpc.testnet.arc.io"),
    geminiPublicBase: strEnv(env, "GEMINI_PUBLIC_BASE", "https://api.gemini.com"),
    geminiTradeBase: strEnv(env, "GEMINI_TRADE_BASE", "https://api.sandbox.gemini.com"),
    geminiApiKey,
    geminiApiSecret,
    mock: geminiApiKey === "",
    marketCount: intEnv(env, "KEEPER_MARKET_COUNT", 8, 1),
    pollMs,
    heartbeatMs,
    scanEvents: intEnv(env, "KEEPER_SCAN_EVENTS", 100, 1),
    appUrl: strEnv(env, "VECTIS_APP_URL", ""),
    streamPollMs: intEnv(env, "KEEPER_STREAM_POLL_MS", 1500, 200),
    comboPollMs: intEnv(env, "KEEPER_COMBO_POLL_MS", 10_000, 1000),
    comboCount: intEnv(env, "KEEPER_COMBO_COUNT", 6, 0),
    symbols: (env.KEEPER_SYMBOLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    addressesFile,
    stateFile: resolve(PACKAGE_ROOT, ".keeper-state.json"),
    addresses,
  };
}
