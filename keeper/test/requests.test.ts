import { describe, expect, it } from "vitest";
import { marketIdOf } from "../src/math.js";
import { OracleFeed } from "../src/oracle.js";
import {
  MarketRequests,
  REQUEST_TTL_S,
  selectRequests,
  validateRequest,
  type RequestedMarket,
  type RequestSink,
} from "../src/requests.js";

const NOW = 1_800_000_000;

const row = (symbol: string, over: Record<string, unknown> = {}) => ({
  marketId: marketIdOf(symbol),
  symbol,
  eventTicker: "NGAS",
  title: "Natural Gas price?",
  label: "$4 or above",
  closeTime: NOW + 86_400,
  requestedAt: NOW - 60,
  ...over,
});

const market = (symbol: string, requestedAt = NOW - 60): RequestedMarket => {
  const v = validateRequest(row(symbol, { requestedAt }), NOW);
  if (!v.ok) throw new Error(v.reason);
  return v.market;
};

describe("validateRequest", () => {
  it("accepts a well-formed request", () => {
    const v = validateRequest(row("GEMI-NGAS-HI4"), NOW);
    expect(v).toMatchObject({ ok: true, market: { symbol: "GEMI-NGAS-HI4", closeTime: NOW + 86_400 } });
  });
  it("rejects a marketId that is not keccak256(symbol)", () => {
    expect(validateRequest(row("A", { marketId: marketIdOf("B") }), NOW)).toEqual({ ok: false, reason: "marketId is not keccak256(symbol)" });
  });
  it("rejects combos, past close times, lapsed requests and unsafe symbols", () => {
    expect(validateRequest(row("X-CMB-1"), NOW)).toMatchObject({ ok: false, reason: "combo symbol" });
    expect(validateRequest(row("A", { closeTime: NOW }), NOW)).toMatchObject({ ok: false });
    expect(validateRequest(row("A", { requestedAt: NOW - REQUEST_TTL_S }), NOW)).toMatchObject({ ok: false, reason: "request has lapsed" });
    expect(validateRequest(row("a b"), NOW)).toMatchObject({ ok: false, reason: "invalid symbol" });
  });
});

describe("selectRequests", () => {
  const base = { saved: [], carried: new Set<string>(), baseSymbols: ["BASE-1"], count: 6, maxBooks: 27 };

  it("takes the newest requests up to the count", () => {
    const requested = ["A", "B", "C"].map((s) => market(s));
    expect(selectRequests({ ...base, requested, count: 2 }).tracked.map((m) => m.symbol)).toEqual(["A", "B"]);
  });
  it("skips markets already priced for another reason", () => {
    const requested = [market("BASE-1"), market("A")];
    expect(selectRequests({ ...base, requested }).tracked.map((m) => m.symbol)).toEqual(["A"]);
  });
  it("stops at the book budget and reports what was left out", () => {
    const requested = ["A", "B"].map((s) => market(s));
    const sel = selectRequests({ ...base, requested, maxBooks: 2 });
    expect(sel.tracked.map((m) => m.symbol)).toEqual(["A"]);
    expect(sel.overBudget.map((m) => m.symbol)).toEqual(["B"]);
  });
  it("keeps a market with an active position even when its request is gone or over budget", () => {
    const old = market("OLD");
    const sel = selectRequests({ ...base, requested: [], saved: [old], carried: new Set([old.marketId.toLowerCase()]), maxBooks: 1 });
    expect(sel.tracked.map((m) => m.symbol)).toEqual(["OLD"]);
  });
});

describe("MarketRequests.tick", () => {
  const sink = () => {
    const synced: string[][] = [];
    const remembered: string[] = [];
    const s: RequestSink = {
      baseSymbols: () => ["BASE-1"],
      syncRequested: async (list) => {
        synced.push(list.map((m) => m.symbol));
      },
      remember: (list) => remembered.push(...list.map((m) => m.symbol)),
    };
    return { s, synced, remembered };
  };
  const respond = (body: unknown, ok = true) => (async () => ({ ok, status: ok ? 200 : 500, json: async () => body })) as unknown as typeof fetch;

  it("syncs valid requests to the feed and remembers their symbols", async () => {
    const { s, synced, remembered } = sink();
    const reqs = new MarketRequests("http://app", 6, 27, s, () => [], respond({ source: "database", markets: [row("A"), row("bad sym")] }), () => NOW * 1000);
    await reqs.tick();
    expect(synced).toEqual([["A"]]);
    expect(remembered).toEqual(["A"]);
  });

  it("keeps recent markets when the list is down, and drops lapsed ones", async () => {
    const { s, synced } = sink();
    let fetchImpl = respond({ source: "database", markets: [row("A")] });
    let now = NOW * 1000;
    const reqs = new MarketRequests("http://app", 6, 27, s, () => [], ((...a: Parameters<typeof fetch>) => fetchImpl(...a)) as typeof fetch, () => now);
    await reqs.tick();
    fetchImpl = respond({}, false);
    await reqs.tick();
    now += REQUEST_TTL_S * 1000;
    await reqs.tick();
    expect(synced).toEqual([["A"], ["A"], []]);
  });

  it("does nothing without a web app URL", async () => {
    const { s, synced } = sink();
    await new MarketRequests(null, 6, 27, s, () => []).tick();
    expect(synced).toEqual([]);
  });
});

describe("OracleFeed.syncRequested", () => {
  const makeFeed = () => {
    const sent: string[] = [];
    const clients = { publicClient: { readContract: async ({ functionName }: { functionName: string }) => (functionName === "isRegistered" ? false : 0n) } };
    const queue = { send: async (label: string) => void sent.push(label) };
    const feed = new OracleFeed(clients as never, queue as never, {} as never, "0x0000000000000000000000000000000000000001", 10_000, 45_000);
    return { feed, sent };
  };
  const tracked = (symbol: string) => ({ symbol, eventTicker: "E", title: "t", label: "l", closeTime: Math.floor(Date.now() / 1000) + 3600 });

  it("registers new requests, drops lapsed ones and never touches startup markets", async () => {
    const { feed, sent } = makeFeed();
    await feed.addMarkets([tracked("BASE")]);
    await feed.syncRequested([tracked("A"), tracked("BASE")]);
    expect(feed.marketSymbols().sort()).toEqual(["A", "BASE"]);
    expect(feed.baseSymbols()).toEqual(["BASE"]);
    expect(sent).toEqual(["registerMarket BASE", "registerMarket A"]);
    await feed.syncRequested([]);
    expect(feed.marketSymbols()).toEqual(["BASE"]);
  });
});
