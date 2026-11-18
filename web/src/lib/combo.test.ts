import { describe, expect, it } from "vitest";
import { keccak256, toBytes } from "viem";
import {
  canonicalLegKey,
  comboLabel,
  comboMarketId,
  comboTimes,
  fromDollars,
  toDollars,
  validateLegs,
  vectisComboSymbol,
  type LegFacts,
} from "./combo";
import { comboQuote } from "./math";

const usd = (n: number) => BigInt(Math.round(n * 1e6));
const yes = (bid: number | null, ask: number | null) => ({
  outcome: "yes" as const,
  yesBid: bid === null ? null : usd(bid),
  yesAsk: ask === null ? null : usd(ask),
});
const no = (bid: number | null, ask: number | null) => ({ ...yes(bid, ask), outcome: "no" as const });

describe("comboQuote", () => {
  it("multiplies Yes legs", () => {
    expect(comboQuote([yes(0.5, 0.6), yes(0.4, 0.5)])).toEqual({ bid: usd(0.2), ask: usd(0.3) });
  });
  it("converts No legs to their side: bid = 1 - ask, ask = 1 - bid", () => {
    // No leg of a 0.70 / 0.72 contract is 0.28 / 0.30.
    expect(comboQuote([yes(0.5, 0.6), no(0.7, 0.72)])).toEqual({ bid: usd(0.14), ask: usd(0.18) });
  });
  it("rounds the bid down and the ask up to the micro-dollar", () => {
    // 0.333333 * 0.333333 = 0.111110888889 -> bid 0.111110, ask 0.111111
    const q = comboQuote([yes(0.333333, 0.333333), yes(0.333333, 0.333333)]);
    expect(q).toEqual({ bid: 111_110n, ask: 111_111n });
  });
  it("rounds across three legs without drifting", () => {
    // bid 0.1 * 0.1 * 0.000001 = 1e-8 -> 0; ask 0.11 * 0.11 * 0.000002 = 2.42e-8 -> 0.000001
    const tiny = { outcome: "yes" as const, yesBid: 1n, yesAsk: 2n };
    expect(comboQuote([yes(0.1, 0.11), yes(0.1, 0.11), tiny])).toEqual({ bid: 0n, ask: 1n });
  });
  it("an exact product is not rounded", () => {
    expect(comboQuote([yes(0.25, 0.5), yes(0.5, 0.5), yes(0.5, 0.5)])).toEqual({ bid: usd(0.0625), ask: usd(0.125) });
  });
  it("is not priceable when a leg has no ask on its side", () => {
    expect(comboQuote([yes(0.5, null), yes(0.4, 0.5)])).toBeNull();
    // A No leg's ask is 1 - YES bid, so a missing YES bid leaves it without an ask.
    expect(comboQuote([no(null, 0.7), yes(0.4, 0.5)])).toBeNull();
  });
  it("has a zero bid when a leg has no bid on its side", () => {
    expect(comboQuote([yes(null, 0.6), yes(0.4, 0.5)])).toEqual({ bid: 0n, ask: usd(0.3) });
    // A No leg's bid is 1 - YES ask, so a missing YES ask leaves it without a bid.
    expect(comboQuote([no(0.7, null), yes(0.4, 0.5)])).toEqual({ bid: 0n, ask: usd(0.15) });
  });
  it("keeps 0 <= bid <= ask <= 1e6", () => {
    expect(comboQuote([yes(1, 1), yes(1, 1)])).toEqual({ bid: usd(1), ask: usd(1) });
    // A crossed leg (bid above ask) cannot push the combo bid above its ask.
    const q = comboQuote([yes(0.6, 0.5), yes(0.5, 0.5)]);
    expect(q && q.bid <= q.ask).toBe(true);
    expect(comboQuote([yes(0, 0.01), yes(0.5, 0.5)])).toEqual({ bid: 0n, ask: usd(0.005) });
  });
  it("needs at least one leg", () => {
    expect(comboQuote([])).toBeNull();
  });
  it("never prices a combo above its cheapest leg", () => {
    const q = comboQuote([yes(0.9, 0.92), yes(0.3, 0.33), no(0.2, 0.25)]);
    expect(q && q.ask <= usd(0.33)).toBe(true);
  });
});

describe("combo identity", () => {
  const legs = [
    { symbol: "GEMI-NHL-X-M-CGY", outcome: "no" as const },
    { symbol: "GEMI-BTC2611152200-HI61750", outcome: "yes" as const },
  ];
  it("sorts legs by symbol in the canonical key", () => {
    expect(canonicalLegKey(legs)).toBe("GEMI-BTC2611152200-HI61750:yes|GEMI-NHL-X-M-CGY:no");
    expect(canonicalLegKey([...legs].reverse())).toBe(canonicalLegKey(legs));
  });
  it("the outcome is part of the key", () => {
    const flipped = [{ ...legs[0]!, outcome: "yes" as const }, legs[1]!];
    expect(canonicalLegKey(flipped)).not.toBe(canonicalLegKey(legs));
  });
  it("derives the Vectis symbol from sha256 of the key", () => {
    // sha256("a:yes|b:no") computed with `shasum -a 256`.
    expect(vectisComboSymbol("a:yes|b:no")).toBe("VECTIS-CMB-35704E1A80E8030B");
    expect(vectisComboSymbol(canonicalLegKey(legs))).toMatch(/^VECTIS-CMB-[0-9A-F]{16}$/);
  });
  it("marketId is keccak256 of the symbol bytes", () => {
    expect(comboMarketId("GEMI-CMB-261117-D2C25E954E0E19E0-CMB")).toBe(
      keccak256(toBytes("GEMI-CMB-261117-D2C25E954E0E19E0-CMB")),
    );
  });
});

describe("comboLabel and comboTimes", () => {
  const l = (label: string, outcome: "yes" | "no" = "yes") => ({ label, outcome });
  it("lists up to three legs", () => {
    expect(comboLabel([l("Utah"), l("Arizona", "no")])).toBe("Utah Yes + Arizona No");
    expect(comboLabel([l("A"), l("B"), l("C")])).toBe("A Yes + B Yes + C Yes");
  });
  it("shortens from four legs", () => {
    expect(comboLabel([l("Utah"), l("Arizona", "no"), l("C"), l("D")])).toBe("Utah Yes + Arizona No + 2 more");
  });
  it("keeps angle brackets out of labels", () => {
    expect(comboLabel([l("<b>Utah</b>"), l("B")])).toBe("bUtah/b Yes + B Yes");
  });
  it("closes at the earliest leg and expires at the latest", () => {
    const t = comboTimes([{ expiry: "2026-11-16T03:30:00.000Z" }, { expiry: "2026-11-15T22:00:00.000Z" }]);
    expect(t).toEqual({ closeTime: Date.parse("2026-11-15T22:00:00.000Z") / 1000, expiry: "2026-11-16T03:30:00.000Z" });
    expect(comboTimes([{ expiry: "nope" }])).toBeNull();
  });
});

describe("validateLegs", () => {
  const now = Date.parse("2026-11-14T12:00:00Z") / 1000;
  const leg = (n: number, over: Partial<LegFacts> = {}): LegFacts => ({
    symbol: `GEMI-EV${n}-A`,
    outcome: "yes",
    eventTicker: `EV${n}`,
    gameId: null,
    open: true,
    expiry: "2026-11-15T12:00:00Z",
    ...over,
  });
  const code = (legs: LegFacts[]) => {
    const r = validateLegs(legs, now);
    return r.ok ? "ok" : r.code;
  };

  it("accepts 2 to 6 independent open legs", () => {
    expect(code([leg(1), leg(2)])).toBe("ok");
    expect(code([1, 2, 3, 4, 5, 6].map((n) => leg(n)))).toBe("ok");
  });
  it("rejects too few and too many legs", () => {
    expect(code([leg(1)])).toBe("too_few_legs");
    expect(code([])).toBe("too_few_legs");
    expect(code([1, 2, 3, 4, 5, 6, 7].map((n) => leg(n)))).toBe("too_many_legs");
  });
  it("rejects a repeated contract", () => {
    expect(code([leg(1), leg(1, { outcome: "no" })])).toBe("duplicate_leg");
  });
  it("rejects two legs from the same event", () => {
    expect(code([leg(1), leg(1, { symbol: "GEMI-EV1-B" })])).toBe("same_event");
  });
  it("rejects two legs from the same game even across events", () => {
    expect(code([leg(1, { gameId: "g1" }), leg(2, { gameId: "g1" })])).toBe("same_event");
    expect(code([leg(1, { gameId: "g1" }), leg(2, { gameId: "g2" })])).toBe("ok");
  });
  it("rejects closed legs and combo legs", () => {
    expect(code([leg(1), leg(2, { open: false })])).toBe("leg_closed");
    expect(code([leg(1), leg(2, { symbol: "GEMI-CMB-261117-D2C25E954E0E19E0-CMB" })])).toBe("combo_leg");
  });
  it("rejects a leg that closes within two hours", () => {
    expect(code([leg(1), leg(2, { expiry: "2026-11-14T14:00:00Z" })])).toBe("closes_soon");
    expect(code([leg(1), leg(2, { expiry: "2026-11-14T14:00:01Z" })])).toBe("ok");
    expect(code([leg(1), leg(2, { expiry: null })])).toBe("leg_no_expiry");
  });
});

describe("dollar strings", () => {
  it("round-trip", () => {
    expect(toDollars(412_500n)).toBe("0.412500");
    expect(toDollars(1_000_000n)).toBe("1.000000");
    expect(toDollars(1n)).toBe("0.000001");
    expect(fromDollars("0.412500")).toBe(412_500n);
    expect(fromDollars("0.5")).toBe(500_000n);
    expect(fromDollars(null)).toBeNull();
    expect(fromDollars("abc")).toBeNull();
  });
});
