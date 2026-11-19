import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { batchApproval, firstUnopened, runBatchLegs, type BatchItem, type BatchLeg } from "./useChain";

const item = (margin: bigint, fee: bigint): BatchItem => ({
  args: { marketId: "0x01" as Hex, side: 0, margin, leverage: 20n, refPrice: 500_000n, fee },
  meta: { symbol: "X", eventTicker: "E", title: "T", label: "L", expiry: null },
});

describe("batchApproval", () => {
  it("sums margin plus fee over legs not yet opened", () => {
    const items = [item(10n, 1n), item(20n, 2n), item(30n, 3n)];
    expect(batchApproval(items, [])).toBe(66n);
    expect(batchApproval(items, [{ status: "opened", positionId: 1n }, { status: "failed" }, { status: "pending" }])).toBe(
      55n,
    );
  });
});

describe("firstUnopened", () => {
  it("finds the first leg that is not opened", () => {
    expect(firstUnopened([{ status: "opened" }, { status: "failed" }, { status: "pending" }])).toBe(1);
    expect(firstUnopened([{ status: "opened" }])).toBe(-1);
  });
});

describe("runBatchLegs", () => {
  it("opens every leg in order", async () => {
    const order: number[] = [];
    const legs = await runBatchLegs(
      [item(1n, 0n), item(2n, 0n)],
      [],
      async (_, i) => {
        order.push(i);
        return BigInt(100 + i);
      },
      () => {},
    );
    expect(order).toEqual([0, 1]);
    expect(legs).toEqual([
      { status: "opened", positionId: 100n },
      { status: "opened", positionId: 101n },
    ]);
  });

  it("stops at the first failure and leaves later legs pending", async () => {
    const updates: BatchLeg[][] = [];
    const legs = await runBatchLegs(
      [item(1n, 0n), item(2n, 0n), item(3n, 0n)],
      [],
      async (_, i) => {
        if (i === 1) throw new Error("user rejected");
        return 7n;
      },
      (l) => updates.push(l),
    );
    expect(legs[0]).toEqual({ status: "opened", positionId: 7n });
    expect(legs[1]?.status).toBe("failed");
    expect(legs[1]?.error).toBeTruthy();
    expect(legs[2]).toEqual({ status: "pending" });
    expect(updates.map((u) => u.map((l) => l.status))).toEqual([
      ["opening", "pending", "pending"],
      ["opened", "pending", "pending"],
      ["opened", "opening", "pending"],
      ["opened", "failed", "pending"],
    ]);
  });

  it("skips legs already opened when resuming", async () => {
    const opened: number[] = [];
    const legs = await runBatchLegs(
      [item(1n, 0n), item(2n, 0n)],
      [{ status: "opened", positionId: 5n }, { status: "pending" }],
      async (_, i) => {
        opened.push(i);
        return 6n;
      },
      () => {},
    );
    expect(opened).toEqual([1]);
    expect(legs.map((l) => l.positionId)).toEqual([5n, 6n]);
  });
});
