import { describe, expect, it } from "vitest";
import { UnauthorizedProviderError, type Address, type Hex } from "viem";
import { WALLET_ACCESS_MESSAGE, walletSession } from "@/lib/walletAccess";
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

// The live batch hook: one wallet session per run, approve first, then each leg through it.
describe("batch open with wallet re-authorisation", () => {
  const A = "0x00000000000000000000000000000000000000aA" as Address;
  const deny = () => ({ name: "ContractFunctionExecutionError", cause: new UnauthorizedProviderError(new Error("x")) });

  function harness(failAt: number[]) {
    const sent: number[] = [];
    let approvals = 0;
    let reauths = 0;
    const session = () =>
      walletSession({
        account: () => A,
        reauthorize: async () => {
          reauths++;
          return A;
        },
      });
    const runOnce = async (items: BatchItem[], start: BatchLeg[]) => {
      const run = session();
      await run(async () => {
        approvals++;
      });
      return runBatchLegs(items, start, (_, i) =>
        run(async () => {
          sent.push(i);
          if (failAt[0] === sent.length - 1) {
            failAt.shift();
            throw deny();
          }
          return BigInt(100 + i);
        }),
        () => {},
      );
    };
    return { runOnce, sent, approvals: () => approvals, reauths: () => reauths };
  }
  const items = [item(1n, 0n), item(2n, 0n), item(3n, 0n)];

  it("re-authorises once and resumes at the leg that failed, without resending earlier legs or approving again", async () => {
    const h = harness([1]); // the second send (leg 1) is refused once
    const legs = await h.runOnce(items, []);
    expect(h.sent).toEqual([0, 1, 1, 2]);
    expect(h.reauths()).toBe(1);
    expect(h.approvals()).toBe(1);
    expect(legs.map((l) => l.status)).toEqual(["opened", "opened", "opened"]);
  });

  it("stops with the plain message on a second refusal, and a retry starts at that leg", async () => {
    const h = harness([1, 3]); // leg 1 refused, re-authorised; leg 2 refused again
    const legs = await h.runOnce(items, []);
    expect(legs.map((l) => l.status)).toEqual(["opened", "opened", "failed"]);
    expect(legs[2]!.error).toBe(WALLET_ACCESS_MESSAGE);
    expect(h.reauths()).toBe(1);
    const resumed = await h.runOnce(
      items,
      legs.map((l) => (l.status === "opened" ? l : { status: "pending" })),
    );
    expect(h.sent.slice(4)).toEqual([2]);
    expect(resumed.map((l) => l.status)).toEqual(["opened", "opened", "opened"]);
  });
});
