import { describe, expect, it } from "vitest";
import { keccak256, toHex } from "viem";
import {
  ONE,
  QTY_STEP,
  blendPrice,
  buildQuote,
  clampQuote,
  contractsForSize,
  fillCost,
  marketIdOf,
  microToDecimal,
  sideAsk,
  sideBid,
  toMicro,
  toSide,
} from "../src/math.js";

describe("toMicro", () => {
  it("converts decimal-dollar strings exactly", () => {
    expect(toMicro("0.88", "down")).toBe(880_000n);
    expect(toMicro("0.9", "up")).toBe(900_000n);
    expect(toMicro("1", "down")).toBe(ONE);
    expect(toMicro("0", "up")).toBe(0n);
    expect(toMicro(".5", "down")).toBe(500_000n);
    expect(toMicro("0.000001", "down")).toBe(1n);
  });
  it("rounds sub-micro digits in the requested direction", () => {
    expect(toMicro("0.1234567", "down")).toBe(123_456n);
    expect(toMicro("0.1234567", "up")).toBe(123_457n);
    expect(toMicro("0.1234560", "up")).toBe(123_456n);
  });
  it("accepts numbers without float drift", () => {
    expect(toMicro(0.57, "down")).toBe(570_000n);
    expect(toMicro(0.57, "up")).toBe(570_000n);
    expect(toMicro(0.1 + 0.2, "up")).toBe(300_000n);
  });
  it("rejects missing and malformed input", () => {
    for (const bad of [undefined, null, "", ".", "abc", "-0.1", "1e-3", "0.1.2", NaN, -1, Infinity]) {
      expect(toMicro(bad as never, "down")).toBeNull();
    }
  });
});

describe("buildQuote / clampQuote", () => {
  it("rounds bid down and ask up", () => {
    expect(buildQuote("0.5100009", "0.6200001")).toEqual({ bid: 510_000n, ask: 620_001n });
  });
  it("returns null when a side is missing", () => {
    expect(buildQuote(undefined, "0.5")).toBeNull();
    expect(buildQuote("0.5", null)).toBeNull();
  });
  it("clamps to 0 <= bid <= ask <= 1e6", () => {
    expect(buildQuote("0.4", "1.2")).toEqual({ bid: 400_000n, ask: ONE });
    expect(buildQuote("1.5", "1.7")).toEqual({ bid: ONE, ask: ONE });
    expect(clampQuote(-5n, 10n)).toEqual({ bid: 0n, ask: 10n });
    // crossed book: bid is pulled down to the ask
    expect(buildQuote("0.7", "0.6")).toEqual({ bid: 600_000n, ask: 600_000n });
  });
});

describe("side-space conversions", () => {
  const q = { bid: 510_000n, ask: 620_000n };
  it("YES uses the YES book directly", () => {
    expect(sideAsk(q, 0)).toBe(620_000n);
    expect(sideBid(q, 0)).toBe(510_000n);
  });
  it("NO is 1 - the opposite YES price", () => {
    expect(sideAsk(q, 1)).toBe(490_000n); // buy NO = 1 - YES bid
    expect(sideBid(q, 1)).toBe(380_000n); // sell NO = 1 - YES ask
  });
  it("side bid never exceeds side ask", () => {
    for (const side of [0, 1] as const) expect(sideBid(q, side) <= sideAsk(q, side)).toBe(true);
  });
  it("toSide validates", () => {
    expect(toSide(0)).toBe(0);
    expect(toSide(1n)).toBe(1);
    expect(() => toSide(2)).toThrow();
  });
});

describe("contractsForSize", () => {
  it("floors to 0.01 contract", () => {
    // 100 USDC at 0.62 = 161.29032... contracts -> 161.29
    expect(contractsForSize(100_000_000n, 620_000n)).toBe(161_290_000n);
    // 10 USDC at 0.5 = exactly 20 contracts
    expect(contractsForSize(10_000_000n, 500_000n)).toBe(20_000_000n);
  });
  it("returns zero when nothing fits or the price is invalid", () => {
    expect(contractsForSize(5_000n, 900_000n)).toBe(0n);
    expect(contractsForSize(1_000_000n, 0n)).toBe(0n);
    expect(contractsForSize(0n, 500_000n)).toBe(0n);
  });
  it("cost (rounded up) never exceeds size, and one more step would", () => {
    const sizes = [1_000_000n, 1_234_567n, 5_000_001n, 99_999_999n, 250_000_000n, 7n, 10_001n];
    const prices = [1n, 9_999n, 10_000n, 123_457n, 333_333n, 490_000n, 620_001n, 850_000n, 999_999n, ONE];
    for (const size of sizes) {
      for (const price of prices) {
        const c = contractsForSize(size, price);
        expect(c % QTY_STEP).toBe(0n);
        expect(c >= 0n).toBe(true);
        expect(fillCost(c, price) <= size).toBe(true);
        expect(fillCost(c + QTY_STEP, price) > size).toBe(true);
      }
    }
  });
});

describe("misc", () => {
  it("fillCost rounds up", () => {
    expect(fillCost(10_000n, 333_333n)).toBe(3_334n);
    expect(fillCost(1_000_000n, 500_000n)).toBe(500_000n);
  });
  it("microToDecimal trims zeros", () => {
    expect(microToDecimal(161_290_000n)).toBe("161.29");
    expect(microToDecimal(620_000n)).toBe("0.62");
    expect(microToDecimal(ONE)).toBe("1");
    expect(microToDecimal(1n)).toBe("0.000001");
  });
  it("blendPrice weights by quantity and floors", () => {
    expect(blendPrice(1_000_000n, 600_000n, 3_000_000n, 500_000n)).toBe(525_000n);
    expect(blendPrice(5n, 700_000n, 0n, 1n)).toBe(700_000n);
    expect(blendPrice(0n, 1n, 0n, 1n)).toBe(0n);
  });
  it("marketId is keccak256 of the symbol bytes", () => {
    const symbol = "GEMI-BTC2611152200-HI61750";
    expect(marketIdOf(symbol)).toBe(keccak256(toHex(symbol)));
  });
});
