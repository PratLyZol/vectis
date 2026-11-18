import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, erc4626Abi, keccak256, toBytes } from "viem";
import { lendingVaultAbi, marginManagerAbi } from "@/config/abis";
import { decodeStreamLog, extractLogs, jsonArgs, signStreamPayload, verifyStreamSignature, type RawLog } from "./stream";

const token = "test-token-123";
const nonce = "abc123nonce";
const timestamp = "1700000000";
const rawBody = '{"logs":[]}';
// Computed independently with `openssl dgst -sha256 -hmac`: HMAC-SHA256(key = token, message = nonce + timestamp + rawBody), hex.
const KNOWN_SIGNATURE = "f72161f382d94a7715c94ba43700a21dd2a89eb66122732d41b4c8a980bce129";

describe("stream signature", () => {
  const signature = signStreamPayload(nonce, timestamp, rawBody, token);
  const base = { nonce, timestamp, signature, rawBody, token, nowSeconds: 1_700_000_030 };

  it("matches a known vector", () => {
    expect(signature).toBe(KNOWN_SIGNATURE);
  });
  it("accepts a correct signature inside the time window", () => {
    expect(verifyStreamSignature(base)).toEqual({ ok: true });
    expect(verifyStreamSignature({ ...base, signature: signature.toUpperCase() })).toEqual({ ok: true });
  });
  it("rejects a tampered body, nonce or token", () => {
    expect(verifyStreamSignature({ ...base, rawBody: '{"logs":[1]}' }).ok).toBe(false);
    expect(verifyStreamSignature({ ...base, nonce: "other" }).ok).toBe(false);
    expect(verifyStreamSignature({ ...base, token: "wrong" }).ok).toBe(false);
  });
  it("rejects a wrong or malformed signature", () => {
    expect(verifyStreamSignature({ ...base, signature: "00".repeat(32) }).ok).toBe(false);
    expect(verifyStreamSignature({ ...base, signature: "short" }).ok).toBe(false);
  });
  it("rejects missing headers", () => {
    expect(verifyStreamSignature({ ...base, nonce: null }).ok).toBe(false);
    expect(verifyStreamSignature({ ...base, timestamp: null }).ok).toBe(false);
    expect(verifyStreamSignature({ ...base, signature: null }).ok).toBe(false);
  });
  it("rejects timestamps more than 10 minutes off, either way", () => {
    expect(verifyStreamSignature({ ...base, nowSeconds: 1_700_000_000 + 600 }).ok).toBe(true);
    expect(verifyStreamSignature({ ...base, nowSeconds: 1_700_000_000 + 601 }).ok).toBe(false);
    expect(verifyStreamSignature({ ...base, nowSeconds: 1_700_000_000 - 601 }).ok).toBe(false);
  });
  it("rejects a non-numeric timestamp", () => {
    const ts = "yesterday";
    const sig = signStreamPayload(nonce, ts, rawBody, token);
    expect(verifyStreamSignature({ ...base, timestamp: ts, signature: sig }).ok).toBe(false);
  });
});

const log = (n: number): RawLog => ({
  address: "0x00000000000000000000000000000000000000aa",
  topics: ["0x" + "11".repeat(32)],
  data: "0x",
  blockNumber: "0x10",
  transactionHash: "0x" + n.toString(16).padStart(64, "0"),
  logIndex: "0x0",
});

describe("extractLogs", () => {
  it("reads the filter's own shape", () => {
    expect(extractLogs({ logs: [log(1), log(2)], network: "arc-testnet" })).toHaveLength(2);
  });
  it("reads a data/metadata wrapper", () => {
    const got = extractLogs({ data: { logs: [log(1)] }, metadata: { batch_start_range: 5, network: "arc-testnet" } });
    expect(got.map((l) => l.transactionHash)).toEqual([log(1).transactionHash]);
  });
  it("reads nested arrays from an unfiltered logs dataset", () => {
    expect(extractLogs({ data: [[log(1), log(2)], [], [log(3)]] })).toHaveLength(3);
    expect(extractLogs([[[log(4)]]])).toHaveLength(1);
  });
  it("reads logs inside receipts without descending into a matched log", () => {
    const receipt = { transactionHash: "0x" + "ab".repeat(32), status: "0x1", logs: [log(1), log(2)] };
    expect(extractLogs([{ receipts: [receipt] }])).toHaveLength(2);
  });
  it("ignores things that are not logs", () => {
    expect(extractLogs(null)).toEqual([]);
    expect(extractLogs("logs")).toEqual([]);
    expect(extractLogs({ logs: [{ address: "0x1", topics: "nope", transactionHash: "0x2" }, 7, null] })).toEqual([]);
    expect(extractLogs({ logs: [{ address: "0x1", topics: [] }] })).toEqual([]);
  });
  it("defaults missing data to 0x", () => {
    const noData: Partial<RawLog> = log(1);
    delete noData.data;
    expect(extractLogs([noData])[0]?.data).toBe("0x");
  });
});

describe("decodeStreamLog", () => {
  const target = {
    chainId: 5042002,
    marginManager: "0x1111111111111111111111111111111111111111",
    lendingVault: "0x2222222222222222222222222222222222222222",
  };
  const owner = "0xabcdef0123456789abcdef0123456789abcdef01";
  const marketId = keccak256(toBytes("GEMI-BTC2611152200-HI61750"));
  const txHash = "0x" + "cd".repeat(32);

  const opened: RawLog = {
    address: "0x1111111111111111111111111111111111111111".toUpperCase().replace("0X", "0x"),
    topics: encodeEventTopics({
      abi: marginManagerAbi,
      eventName: "PositionOpened",
      args: { id: 7n, owner, marketId },
    }) as string[],
    data: encodeAbiParameters(
      [{ type: "uint8" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [1, 100_000_000n, 30n, 200_000_000n, 420_000n],
    ),
    blockNumber: "0x2a",
    transactionHash: txHash,
    logIndex: "0x3",
  };

  it("decodes a PositionOpened log into a row", () => {
    const row = decodeStreamLog(opened, target);
    expect(row).toMatchObject({
      id: `5042002:${txHash}:3`,
      chainId: 5042002,
      blockNumber: 42,
      logIndex: 3,
      address: target.marginManager,
      eventName: "PositionOpened",
      positionId: "7",
      owner: owner.toLowerCase(),
      marketId,
    });
    expect(row?.args).toMatchObject({ side: 1, margin: "100000000", leverage: "30", borrowed: "200000000", refPrice: "420000" });
  });

  it("decodes a vault Deposit and takes the owner from it", () => {
    const deposit: RawLog = {
      address: target.lendingVault,
      topics: encodeEventTopics({ abi: erc4626Abi, eventName: "Deposit", args: { sender: owner, receiver: owner } }) as string[],
      data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [50_000_000n, 50_000_000_000_000n]),
      blockNumber: 43,
      transactionHash: txHash,
      logIndex: 0,
    };
    const row = decodeStreamLog(deposit, target);
    expect(row).toMatchObject({ eventName: "Deposit", owner: owner.toLowerCase(), positionId: null, marketId: null });
    expect(row?.args).toMatchObject({ assets: "50000000", shares: "50000000000000" });
  });

  it("skips logs from other contracts", () => {
    expect(decodeStreamLog({ ...opened, address: "0x3333333333333333333333333333333333333333" }, target)).toBeNull();
  });
  it("decodes OpenFeePaid with its position and owner", () => {
    const paid: RawLog = {
      address: target.marginManager,
      topics: encodeEventTopics({ abi: marginManagerAbi, eventName: "OpenFeePaid", args: { id: 7n, owner } }) as string[],
      data: encodeAbiParameters([{ type: "uint256" }], [2_000_000n]),
      blockNumber: "0x2a",
      transactionHash: txHash,
      logIndex: "0x4",
    };
    const row = decodeStreamLog(paid, target);
    expect(row).toMatchObject({ eventName: "OpenFeePaid", positionId: "7", owner: owner.toLowerCase(), marketId: null });
    expect(row?.args).toMatchObject({ fee: "2000000" });
  });

  it("decodes the vault's FeeCollected", () => {
    const collected: RawLog = {
      address: target.lendingVault,
      topics: encodeEventTopics({ abi: lendingVaultAbi, eventName: "FeeCollected" }) as string[],
      data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [2_000_000n, 5_000_000n]),
      blockNumber: 43,
      transactionHash: txHash,
      logIndex: 5,
    };
    const row = decodeStreamLog(collected, target);
    expect(row).toMatchObject({ eventName: "FeeCollected", positionId: null, owner: null });
    expect(row?.args).toMatchObject({ amount: "2000000", totalFeesCollected: "5000000" });
  });

  it("skips events that are not stored", () => {
    const executorUpdated: RawLog = {
      ...opened,
      topics: encodeEventTopics({ abi: marginManagerAbi, eventName: "ExecutorUpdated", args: { executor: owner } }) as string[],
      data: "0x",
    };
    expect(decodeStreamLog(executorUpdated, target)).toBeNull();
  });
  it("skips logs that do not decode or lack a position in the block", () => {
    expect(decodeStreamLog({ ...opened, topics: ["0x" + "99".repeat(32)] }, target)).toBeNull();
    expect(decodeStreamLog({ ...opened, data: "0x1234" }, target)).toBeNull();
    expect(decodeStreamLog({ ...opened, logIndex: undefined }, target)).toBeNull();
    expect(decodeStreamLog({ ...opened, transactionHash: "0x12" }, target)).toBeNull();
  });
  it("matches nothing while the contracts are undeployed (zero addresses)", () => {
    const zero = "0x0000000000000000000000000000000000000000";
    expect(decodeStreamLog(opened, { chainId: 5042002, marginManager: zero, lendingVault: zero })).toBeNull();
  });
});

describe("jsonArgs", () => {
  it("turns bigints into decimal strings at any depth", () => {
    expect(jsonArgs({ a: 1n, b: [2n, { c: 3n }], d: "x", e: 4, f: true })).toEqual({
      a: "1",
      b: ["2", { c: "3" }],
      d: "x",
      e: 4,
      f: true,
    });
  });
});
