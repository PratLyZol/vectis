import { keccak256, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { SEND_RETRIES, TxQueue, broadcastSigned, isAlreadyKnown, isMethodUnavailable } from "../src/chain.js";

// What the Arc RPC returned on Railway, as viem surfaces it (message on the outer error, RPC detail in cause).
const unavailable = () =>
  Object.assign(new Error('The method "eth_sendRawTransaction" does not exist / is not available.'), {
    cause: { code: -32601, message: "the method eth_sendRawTransaction does not exist/is not available" },
  });
const nested = (msg: string) => Object.assign(new Error("Transaction creation failed."), { cause: new Error(msg) });
const noSleep = async () => undefined;
const HASH = `0x${"ab".repeat(32)}` as Hex;

describe("send error classification", () => {
  it("recognises the method-unavailable class, including nested causes and the -32601 code", () => {
    expect(isMethodUnavailable(unavailable())).toBe(true);
    expect(isMethodUnavailable(nested("Method not found"))).toBe(true);
    expect(isMethodUnavailable({ shortMessage: "RPC error", cause: { details: "code -32601" } })).toBe(true);
  });

  it("does not treat reverts, fee or nonce errors as method-unavailable", () => {
    for (const msg of ["execution reverted", "max fee per gas less than block base fee", "nonce too low", "insufficient funds"]) {
      expect(isMethodUnavailable(nested(msg))).toBe(false);
    }
  });

  it("recognises already-known / nonce-too-low answers", () => {
    expect(isAlreadyKnown(nested("already known"))).toBe(true);
    expect(isAlreadyKnown(nested("nonce too low: next nonce 5, tx nonce 4"))).toBe(true);
    expect(isAlreadyKnown(nested("Known transaction: 0xabc"))).toBe(true);
    expect(isAlreadyKnown(unavailable())).toBe(false);
  });
});

describe("broadcastSigned", () => {
  it("resends the same bytes after method-unavailable and returns the local hash", async () => {
    let calls = 0;
    const hash = await broadcastSigned(
      async () => {
        calls++;
        if (calls < 3) throw unavailable();
      },
      HASH,
      { sleep: noSleep },
    );
    expect(hash).toBe(HASH);
    expect(calls).toBe(3);
  });

  it("treats already-known on a resend as the earlier attempt having landed", async () => {
    let calls = 0;
    const hash = await broadcastSigned(
      async () => {
        calls++;
        throw calls === 1 ? unavailable() : nested("already known");
      },
      HASH,
      { sleep: noSleep },
    );
    expect(hash).toBe(HASH);
    expect(calls).toBe(2);
  });

  it("treats nonce-too-low on a resend as landed, but not on the first send", async () => {
    let calls = 0;
    await expect(
      broadcastSigned(
        async () => {
          calls++;
          throw calls === 1 ? unavailable() : nested("nonce too low");
        },
        HASH,
        { sleep: noSleep },
      ),
    ).resolves.toBe(HASH);
    // First send: a nonce error is a real desync, so it is surfaced (the queue then resyncs its nonce).
    await expect(broadcastSigned(async () => Promise.reject(nested("nonce too low")), HASH, { sleep: noSleep })).rejects.toThrow(
      "Transaction creation failed.",
    );
  });

  it("gives up after SEND_RETRIES resends and does not retry other errors", async () => {
    let calls = 0;
    await expect(
      broadcastSigned(
        async () => {
          calls++;
          throw unavailable();
        },
        HASH,
        { sleep: noSleep },
      ),
    ).rejects.toThrow(/does not exist/);
    expect(calls).toBe(SEND_RETRIES + 1);

    calls = 0;
    await expect(
      broadcastSigned(
        async () => {
          calls++;
          throw nested("insufficient funds");
        },
        HASH,
        { sleep: noSleep },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe("TxQueue with a flaky send node", () => {
  it("signs once, resends identical bytes, keeps one nonce and waits for the receipt", async () => {
    const signed: Array<{ nonce: number }> = [];
    const raw: Hex[] = [];
    const waited: Hex[] = [];
    const serialized = "0x02f8aa01020304" as Hex;
    let sends = 0;
    const clients = {
      account: { address: "0x0000000000000000000000000000000000000abc" },
      publicClient: {
        estimateGas: async () => 21_000n,
        getTransactionCount: async () => 7,
        getBlock: async () => ({ baseFeePerGas: 1n }),
        sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
          raw.push(serializedTransaction);
          sends++;
          if (sends === 1) throw unavailable();
          if (sends === 2) throw nested("already known");
          return keccak256(serializedTransaction);
        },
        waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
          waited.push(hash);
          return { status: "success", blockNumber: 1n, gasUsed: 21_000n };
        },
      },
      walletClient: {
        signTransaction: async (tx: { nonce: number }) => {
          signed.push({ nonce: tx.nonce });
          return serialized;
        },
      },
    };
    const queue = new TxQueue(clients as never);
    // Real backoff is 1 s; keep this test fast by accepting one real wait.
    const hash = await queue.send("recordFill 1", "0x0000000000000000000000000000000000000001", "0x");
    expect(hash).toBe(keccak256(serialized));
    expect(signed).toEqual([{ nonce: 7 }]);
    expect(raw).toEqual([serialized, serialized]);
    expect(waited).toEqual([keccak256(serialized)]);

    // The next transaction takes the next nonce: the retried one consumed exactly one.
    sends = 10;
    await queue.send("liquidate 2", "0x0000000000000000000000000000000000000001", "0x");
    expect(signed).toEqual([{ nonce: 7 }, { nonce: 8 }]);
  });
});
