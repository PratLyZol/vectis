import { describe, expect, it } from "vitest";
import type { GeminiContract, GeminiEvent } from "../src/gemini/public.js";
import { topOfBook } from "../src/gemini/public.js";
import { findSymbols, isEligible, selectMarkets } from "../src/markets.js";
import { needsPost } from "../src/oracle.js";

const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

function contract(symbol: string, bid: string | undefined, ask: string | undefined, over: Partial<GeminiContract> = {}): GeminiContract {
  return {
    instrumentSymbol: symbol,
    label: symbol,
    marketState: "open",
    status: "active",
    expiryDate: iso(NOW + 24 * HOUR),
    prices: { bestBid: bid, bestAsk: ask },
    ...over,
  };
}

function event(ticker: string, volume24h: string | undefined, contracts: GeminiContract[], over: Partial<GeminiEvent> = {}): GeminiEvent {
  return { ticker, title: ticker, status: "active", volume24h, contracts, ...over };
}

const opts = { count: 8, nowMs: NOW };

describe("isEligible", () => {
  const ev = event("E", "1", []);
  it("accepts an open two-sided mid-priced contract", () => {
    expect(isEligible(ev, contract("A", "0.5", "0.52"), opts)).toBe(true);
    expect(isEligible(ev, contract("A", "0.15", "0.2"), opts)).toBe(true);
    expect(isEligible(ev, contract("A", "0.85", "0.9"), opts)).toBe(true);
  });
  it("rejects closed, one-sided, out-of-band and near-expiry contracts", () => {
    expect(isEligible(ev, contract("A", "0.5", "0.52", { marketState: "closed" }), opts)).toBe(false);
    expect(isEligible(ev, contract("A", undefined, "0.52"), opts)).toBe(false);
    expect(isEligible(ev, contract("A", "0.5", undefined), opts)).toBe(false);
    expect(isEligible(ev, contract("A", "0.14", "0.2"), opts)).toBe(false);
    expect(isEligible(ev, contract("A", "0.86", "0.9"), opts)).toBe(false);
    expect(isEligible(ev, contract("A", "0.5", "0.52", { expiryDate: iso(NOW + 3 * HOUR) }), opts)).toBe(false);
    expect(isEligible(ev, contract("A", "0.5", "0.52", { expiryDate: iso(NOW - HOUR) }), opts)).toBe(false);
    expect(isEligible(ev, contract("A", "0.5", "0.52", { expiryDate: undefined }), opts)).toBe(false);
    expect(isEligible(ev, { ...contract("A", "0.5", "0.52"), prices: undefined }, opts)).toBe(false);
  });
  it("falls back to the event expiry when the contract has none", () => {
    const withExpiry = event("E", "1", [], { expiryDate: iso(NOW + 5 * HOUR) });
    expect(isEligible(withExpiry, contract("A", "0.5", "0.52", { expiryDate: undefined }), opts)).toBe(true);
  });
});

describe("selectMarkets", () => {
  const events: GeminiEvent[] = [
    event("LOW", "10", [contract("LOW-1", "0.5", "0.55")]),
    event("HIGH", "5000", [
      contract("HIGH-FAR", "0.2", "0.25"),
      contract("HIGH-MID", "0.48", "0.5"),
      contract("HIGH-NEAR", "0.6", "0.62"),
      contract("HIGH-CLOSED", "0.5", "0.52", { marketState: "closed" }),
    ]),
    event("FALLBACK", undefined, [contract("FB-1", "0.4", "0.45")], { volume: "900" }),
    event("NONE", "99999", [contract("NONE-1", "0.95", "0.97"), contract("NONE-2", undefined, "0.1")]),
    event("MID", "300", [contract("MID-1", "0.3", "0.33", { expiryDate: iso(NOW + 4 * HOUR) })]),
  ];

  it("ranks by event volume24h (fallback volume) with at most two per event", () => {
    const picked = selectMarkets(events, opts).map((m) => m.symbol);
    expect(picked).toEqual(["HIGH-MID", "HIGH-NEAR", "FB-1", "MID-1", "LOW-1"]);
  });
  it("respects the requested count", () => {
    expect(selectMarkets(events, { ...opts, count: 3 }).map((m) => m.symbol)).toEqual(["HIGH-MID", "HIGH-NEAR", "FB-1"]);
    expect(selectMarkets(events, { ...opts, count: 1 }).map((m) => m.symbol)).toEqual(["HIGH-MID"]);
  });
  it("sets closeTime from the contract expiry in unix seconds", () => {
    const m = selectMarkets(events, opts).find((x) => x.symbol === "MID-1")!;
    expect(m.closeTime).toBe(Math.floor((NOW + 4 * HOUR) / 1000));
    expect(m.eventTicker).toBe("MID");
  });
  it("does not return the same symbol twice", () => {
    const dup = [events[0]!, events[0]!];
    expect(selectMarkets(dup, opts).map((m) => m.symbol)).toEqual(["LOW-1"]);
  });
  it("handles empty and malformed events", () => {
    expect(selectMarkets([], opts)).toEqual([]);
    expect(selectMarkets([{ ticker: "X" }, { contracts: [{}] }], opts)).toEqual([]);
  });
});

describe("findSymbols", () => {
  it("finds requested symbols regardless of eligibility", () => {
    const events = [event("E", "1", [contract("A", "0.99", "1"), contract("B", "0.5", "0.6")])];
    const found = findSymbols(events, ["A", "ZZZ"]);
    expect([...found.keys()]).toEqual(["A"]);
    expect(found.get("A")!.eventTicker).toBe("E");
  });
});

describe("topOfBook", () => {
  it("takes the highest bid and lowest ask whatever the order", () => {
    const book = {
      bids: [{ price: "0.85", amount: "1" }, { price: "0.87", amount: "1" }, { price: "0.86", amount: "1" }],
      asks: [{ price: "0.92", amount: "1" }, { price: "0.9", amount: "1" }],
    };
    expect(topOfBook(book)).toEqual({ bid: "0.87", ask: "0.9" });
  });
  it("reports empty sides as undefined", () => {
    expect(topOfBook({ bids: [], asks: [{ price: "0.4", amount: "2" }] })).toEqual({ bid: undefined, ask: "0.4" });
  });
});

describe("needsPost", () => {
  const q = { bid: 500_000n, ask: 520_000n };
  it("posts when never posted or when the quote changed", () => {
    expect(needsPost(undefined, q, 0, 45_000, 10_000)).toBe(true);
    expect(needsPost({ quote: q, at: 1000 }, { bid: 500_000n, ask: 530_000n }, 2000, 45_000, 10_000)).toBe(true);
    expect(needsPost({ quote: q, at: 1000 }, { bid: 490_000n, ask: 520_000n }, 2000, 45_000, 10_000)).toBe(true);
  });
  it("skips unchanged quotes until the heartbeat would lapse before the next cycle", () => {
    expect(needsPost({ quote: q, at: 0 }, q, 10_000, 45_000, 10_000)).toBe(false);
    expect(needsPost({ quote: q, at: 0 }, q, 34_999, 45_000, 10_000)).toBe(false);
    expect(needsPost({ quote: q, at: 0 }, q, 35_000, 45_000, 10_000)).toBe(true);
  });
});
