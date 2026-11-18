import { describe, expect, it } from "vitest";
import {
  ONE,
  SIDE_NO,
  SIDE_YES,
  healthBps,
  isValidLeverage,
  liquidationPrice,
  maxLeverage,
  maxLeverageForPrice,
  notional,
  netPnl,
  openFee,
  positionOpenFee,
  previewOpen,
  settle,
  sideAsk,
  sideBid,
  unrealisedPnl,
} from "./math";

const usd = (n: number) => BigInt(Math.round(n * 1e6));

describe("side prices", () => {
  const bid = usd(0.58);
  const ask = usd(0.6);
  it("YES uses the book as is", () => {
    expect(sideAsk(SIDE_YES, bid, ask)).toBe(usd(0.6));
    expect(sideBid(SIDE_YES, bid, ask)).toBe(usd(0.58));
  });
  it("NO mirrors the book", () => {
    expect(sideAsk(SIDE_NO, bid, ask)).toBe(usd(0.42));
    expect(sideBid(SIDE_NO, bid, ask)).toBe(usd(0.4));
  });
  it("the side ask is never below the side bid", () => {
    expect(sideAsk(SIDE_NO, bid, ask) >= sideBid(SIDE_NO, bid, ask)).toBe(true);
  });
});

describe("maxLeverageForPrice", () => {
  it.each([
    [0.6, 50n],
    [0.5, 40n],
    [0.3, 25n],
    [0.2, 15n],
    [0.1, 10n],
    [0.99, 50n],
    [0.59, 45n],
    [0.24, 20n],
    [0.239999, 15n],
    [0.01, 10n],
    [0, 10n],
  ])("price %f -> %i tenths", (price, expected) => {
    expect(maxLeverageForPrice(usd(price))).toBe(expected);
  });
  it("always returns a multiple of 5 between 10 and 50", () => {
    for (let p = 0n; p <= ONE; p += 7_919n) {
      const l = maxLeverageForPrice(p);
      expect(l % 5n).toBe(0n);
      expect(l >= 10n && l <= 50n).toBe(true);
    }
  });
});

describe("maxLeverage with time", () => {
  const close = 1_800_000_000n;
  it("uses the price rule before the final hour", () => {
    expect(maxLeverage(usd(0.6), close - 3601n, close)).toBe(50n);
  });
  it("is 1x inside the final hour", () => {
    expect(maxLeverage(usd(0.6), close - 3600n, close)).toBe(10n);
    expect(maxLeverage(usd(0.6), close - 1n, close)).toBe(10n);
  });
  it("ignores time when the close time is unknown", () => {
    expect(maxLeverage(usd(0.5), close, 0n)).toBe(40n);
  });
});

describe("isValidLeverage", () => {
  it("accepts steps of 0.5x up to the max", () => {
    expect(isValidLeverage(10n, 40n)).toBe(true);
    expect(isValidLeverage(35n, 40n)).toBe(true);
    expect(isValidLeverage(40n, 40n)).toBe(true);
  });
  it("rejects off-step, low and high values", () => {
    expect(isValidLeverage(12n, 40n)).toBe(false);
    expect(isValidLeverage(5n, 40n)).toBe(false);
    expect(isValidLeverage(45n, 40n)).toBe(false);
  });
});

describe("previewOpen", () => {
  it("100 USDC at 3x on a 0.60 ask", () => {
    const p = previewOpen(usd(100), 30n, usd(0.6));
    expect(p.size).toBe(usd(300));
    expect(p.borrowed).toBe(usd(200));
    expect(p.contracts).toBe(usd(500));
    // 200 / 500 = 0.40, plus the 0.04 buffer
    expect(p.liqPrice).toBe(usd(0.44));
    expect(p.payoutIfWin).toBe(usd(300));
    expect(p.maxLoss).toBe(usd(100));
  });
  it("1x borrows nothing and has no liquidation price", () => {
    const p = previewOpen(usd(50), 10n, usd(0.25));
    expect(p.borrowed).toBe(0n);
    expect(p.contracts).toBe(usd(200));
    expect(p.liqPrice).toBe(0n);
    expect(p.payoutIfWin).toBe(usd(200));
  });
  it("supports half steps", () => {
    const p = previewOpen(usd(10), 25n, usd(0.3));
    expect(p.size).toBe(usd(25));
    expect(p.borrowed).toBe(usd(15));
    expect(p.contracts).toBe(83_333_333n); // floor(25e6 * 1e6 / 300000)
  });
  it("a zero price yields no contracts instead of dividing by zero", () => {
    expect(previewOpen(usd(10), 20n, 0n).contracts).toBe(0n);
  });
});

describe("openFee", () => {
  it("is 1% of the amount borrowed", () => {
    expect(openFee(usd(200))).toBe(usd(2));
    expect(openFee(usd(1))).toBe(usd(0.01));
  });
  it("rounds up to the next micro-dollar", () => {
    // 1 micro-dollar borrowed: 0.01 micro-dollars of fee rounds up to 1.
    expect(openFee(1n)).toBe(1n);
    expect(openFee(99n)).toBe(1n);
    expect(openFee(100n)).toBe(1n);
    expect(openFee(101n)).toBe(2n);
    // 15.000001 borrowed -> 0.15000001 -> 0.150001
    expect(openFee(15_000_001n)).toBe(150_001n);
  });
  it("is zero when nothing is borrowed", () => {
    expect(openFee(0n)).toBe(0n);
  });
  it("is recomputed for a position from its margin and leverage", () => {
    expect(positionOpenFee(usd(100), 30n)).toBe(usd(2));
    expect(positionOpenFee(usd(100), 15n)).toBe(usd(0.5));
    expect(positionOpenFee(usd(100), 10n)).toBe(0n);
  });
  it("comes off position PnL, using the requested borrow and not the filled one", () => {
    // 100 margin at 3x requested a 200 borrow: fee 2, whatever the fill later used.
    expect(netPnl(usd(50), usd(100), 30n)).toBe(usd(48));
    expect(netPnl(usd(-50), usd(100), 30n)).toBe(usd(-52));
    expect(netPnl(0n, usd(100), 30n)).toBe(usd(-2));
    // 1x positions pay no fee.
    expect(netPnl(usd(50), usd(100), 10n)).toBe(usd(50));
    // The fee rounds up: 1.000001 margin at 1.5x borrows 0.5, fee 0.005.
    expect(netPnl(0n, 1_000_001n, 15n)).toBe(-5_000n);
    expect(netPnl(0n, 1_000_003n, 15n)).toBe(-5_001n);
  });
  it("previewOpen adds it to what the trader pays", () => {
    const p = previewOpen(usd(100), 30n, usd(0.6));
    expect(p.fee).toBe(usd(2));
    expect(p.total).toBe(usd(102));
    // The fee is paid on top: size, borrowed, contracts and payout are unchanged by it.
    expect(p.size).toBe(usd(300));
    expect(p.borrowed).toBe(usd(200));
    expect(p.payoutIfWin).toBe(usd(300));
  });
  it("a 1x position pays no fee", () => {
    const p = previewOpen(usd(50), 10n, usd(0.25));
    expect(p.fee).toBe(0n);
    expect(p.total).toBe(usd(50));
  });
});

describe("liquidationPrice", () => {
  it("rounds the debt per contract up before adding the buffer", () => {
    // 15e6 * 1e6 / 83_333_333 = 180000.0007 -> 180001
    expect(liquidationPrice(usd(15), 83_333_333n)).toBe(180_001n + 40_000n);
  });
  it("is zero when nothing is borrowed", () => {
    expect(liquidationPrice(0n, usd(10))).toBe(0n);
  });
  it("exact division does not round up", () => {
    expect(liquidationPrice(usd(200), usd(500))).toBe(440_000n);
  });
});

describe("healthBps", () => {
  const entry = usd(0.6);
  const liq = usd(0.44);
  const borrowed = usd(200);
  it("is 10000 at entry and above", () => {
    expect(healthBps(entry, entry, liq, borrowed)).toBe(10_000n);
    expect(healthBps(usd(0.9), entry, liq, borrowed)).toBe(10_000n);
  });
  it("is linear between the liquidation price and entry", () => {
    expect(healthBps(usd(0.52), entry, liq, borrowed)).toBe(5_000n);
    expect(healthBps(usd(0.48), entry, liq, borrowed)).toBe(2_500n);
  });
  it("is 0 at or below the liquidation price", () => {
    expect(healthBps(liq, entry, liq, borrowed)).toBe(0n);
    expect(healthBps(usd(0.1), entry, liq, borrowed)).toBe(0n);
  });
  it("is 10000 for an unborrowed position", () => {
    expect(healthBps(usd(0.01), entry, 0n, 0n)).toBe(10_000n);
  });
});

describe("pnl and settlement", () => {
  it("notional is contracts x price", () => {
    expect(notional(usd(500), usd(0.6))).toBe(usd(300));
  });
  it("unrealised PnL is value at the bid minus cost", () => {
    expect(unrealisedPnl(usd(500), usd(0.7), usd(300))).toBe(usd(50));
    expect(unrealisedPnl(usd(500), usd(0.5), usd(300))).toBe(usd(-50));
  });
  it("a close repays the vault first", () => {
    expect(settle(usd(500), usd(0.7), usd(200))).toEqual({
      proceeds: usd(350),
      repaid: usd(200),
      loss: 0n,
      payout: usd(150),
    });
  });
  it("a shortfall is a vault loss and the owner gets nothing", () => {
    expect(settle(usd(500), usd(0.3), usd(200))).toEqual({
      proceeds: usd(150),
      repaid: usd(150),
      loss: usd(50),
      payout: 0n,
    });
  });
});
