import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventResponse } from "./types";

const future = new Date(Date.now() + 86_400_000).toISOString();
const event = (source: "gemini" | "fixture"): EventResponse => ({
  source,
  event: {
    id: "1",
    ticker: "NGAS",
    title: "Natural Gas price?",
    slug: "ngas",
    category: "Commodities",
    status: "active",
    expiry: future,
    imageUrl: null,
    volume: 0,
    volume24h: 0,
    contractCount: 2,
    contracts: [
      { symbol: "NG-4", label: "$4 or above", ticker: "4", open: true, expiry: future, yesBid: 300_000, yesAsk: 330_000, last: null },
      { symbol: "NG-5", label: "$5 or above", ticker: "5", open: false, expiry: future, yesBid: null, yesAsk: null, last: null },
    ],
  },
});

const getEvent = vi.fn<(t: string) => Promise<EventResponse | null>>();
vi.mock("./gemini", () => ({ getEvent: (t: string) => getEvent(t), isSafeId: (s: string) => /^[A-Za-z0-9._-]{1,120}$/.test(s) }));

const load = async () => {
  vi.resetModules();
  return import("./marketRequests.server");
};

describe("market requests (memory store)", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("NODE_ENV", "development");
    getEvent.mockReset();
  });

  it("stores open contracts and rejects closed or unknown ones", async () => {
    getEvent.mockResolvedValue(event("gemini"));
    const { requestMarkets, listMarketRequests } = await load();
    const r = await requestMarkets({
      markets: [
        { eventTicker: "NGAS", symbol: "NG-4" },
        { eventTicker: "NGAS", symbol: "NG-5" },
        { eventTicker: "NGAS", symbol: "NG-9" },
        { eventTicker: "NGAS", symbol: "X-CMB-1" },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      requested: ["NG-4"],
      rejected: [
        { symbol: "NG-5", reason: "closed to trading" },
        { symbol: "NG-9", reason: "not a contract of this event" },
        { symbol: "X-CMB-1", reason: "combos are requested through /api/combos" },
      ],
    });
    const list = await listMarketRequests();
    expect(list.source).toBe("memory");
    expect(list.markets.map((m) => m.symbol)).toEqual(["NG-4"]);
  });

  it("rejects requests checked against a saved snapshot", async () => {
    getEvent.mockResolvedValue(event("fixture"));
    const { requestMarkets } = await load();
    const r = await requestMarkets({ markets: [{ eventTicker: "NGAS", symbol: "NG-4" }] });
    expect(r.body).toMatchObject({ requested: [], rejected: [{ reason: "Gemini is unreachable" }] });
  });

  it("validates the body shape", async () => {
    const { requestMarkets } = await load();
    expect((await requestMarkets({})).status).toBe(400);
    expect((await requestMarkets({ markets: Array(7).fill({ eventTicker: "A", symbol: "B" }) })).status).toBe(400);
  });

  it("is unavailable in production without a database", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { requestMarkets, listMarketRequests } = await load();
    expect((await requestMarkets({ markets: [{ eventTicker: "NGAS", symbol: "NG-4" }] })).status).toBe(503);
    expect((await listMarketRequests()).source).toBe("none");
  });
});
