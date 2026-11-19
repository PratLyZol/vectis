// Market requests: single Gemini contracts someone wants to trade that the keeper may not be
// pricing yet (the hedge agent proposes them). The browser posts them here; the keeper polls the
// list, registers each market on the oracle and prices it while the request is recent.
// Imported by route handlers only.
import { neon } from "@neondatabase/serverless";
import { keccak256, toBytes, type Hex } from "viem";
import { getEvent, isSafeId } from "./gemini";
import { unixSeconds } from "./format";

/** A request keeps the market priced this long after it was last made. */
export const REQUEST_TTL_SECONDS = 2 * 60 * 60;
export const MAX_PER_REQUEST = 6;
const LIST_LIMIT = 50;
const MAX_LIVE_ROWS = 200;

export type MarketRequest = {
  marketId: Hex;
  symbol: string;
  eventTicker: string;
  title: string;
  label: string;
  closeTime: number; // unix seconds
  requestedAt: number; // unix seconds
};

export type MarketRequestsResponse = { source: "database" | "memory" | "none"; markets: MarketRequest[] };

type Store = {
  source: "database" | "memory";
  upsert(rows: MarketRequest[]): Promise<void>;
  live(now: number): Promise<MarketRequest[]>;
  countLive(now: number): Promise<number>;
};

const nowSeconds = () => Math.floor(Date.now() / 1000);
const isLive = (r: MarketRequest, now: number) => r.closeTime > now && r.requestedAt > now - REQUEST_TTL_SECONDS;

// Neon in production. The table is created on first use, so no migration step is needed.
function databaseStore(url: string): Store {
  const sql = neon(url);
  let ready: Promise<unknown> | null = null;
  const ensure = () =>
    (ready ??= sql`
      CREATE TABLE IF NOT EXISTS market_requests (
        market_id    text PRIMARY KEY,
        symbol       text NOT NULL UNIQUE,
        event_ticker text NOT NULL,
        title        text NOT NULL,
        label        text NOT NULL,
        close_time   bigint NOT NULL,
        requested_at bigint NOT NULL
      )`.catch((e) => {
      ready = null; // retry on the next call
      throw e;
    }));
  type Row = { market_id: string; symbol: string; event_ticker: string; title: string; label: string; close_time: string | number; requested_at: string | number };
  const toRequest = (r: Row): MarketRequest => ({
    marketId: r.market_id as Hex,
    symbol: r.symbol,
    eventTicker: r.event_ticker,
    title: r.title,
    label: r.label,
    closeTime: Number(r.close_time),
    requestedAt: Number(r.requested_at),
  });
  return {
    source: "database",
    async upsert(rows) {
      await ensure();
      for (const r of rows) {
        await sql`
          INSERT INTO market_requests (market_id, symbol, event_ticker, title, label, close_time, requested_at)
          VALUES (${r.marketId}, ${r.symbol}, ${r.eventTicker}, ${r.title}, ${r.label}, ${r.closeTime}, ${r.requestedAt})
          ON CONFLICT (market_id) DO UPDATE SET requested_at = EXCLUDED.requested_at, close_time = EXCLUDED.close_time`;
      }
    },
    async live(now) {
      await ensure();
      const rows = (await sql`
        SELECT market_id, symbol, event_ticker, title, label, close_time, requested_at
        FROM market_requests
        WHERE close_time > ${now} AND requested_at > ${now - REQUEST_TTL_SECONDS}
        ORDER BY requested_at DESC
        LIMIT ${LIST_LIMIT}`) as Row[];
      return rows.map(toRequest);
    },
    async countLive(now) {
      await ensure();
      const rows = (await sql`
        SELECT count(*)::int AS n FROM market_requests
        WHERE close_time > ${now} AND requested_at > ${now - REQUEST_TTL_SECONDS}`) as { n: number }[];
      return rows[0]?.n ?? 0;
    },
  };
}

// Development without DATABASE_URL: one process, so memory is enough to exercise the flow.
const memory = new Map<string, MarketRequest>();
const memoryStore: Store = {
  source: "memory",
  async upsert(rows) {
    for (const r of rows) memory.set(r.marketId, r);
  },
  async live(now) {
    return [...memory.values()].filter((r) => isLive(r, now)).sort((a, b) => b.requestedAt - a.requestedAt).slice(0, LIST_LIMIT);
  },
  async countLive(now) {
    return [...memory.values()].filter((r) => isLive(r, now)).length;
  },
};

let store: Store | null | undefined;
function getStore(): Store | null {
  if (store !== undefined) return store;
  const url = process.env.DATABASE_URL;
  store = url ? databaseStore(url) : process.env.NODE_ENV === "production" ? null : memoryStore;
  return store;
}

/** Live requests, newest first: the keeper's poll. */
export async function listMarketRequests(): Promise<MarketRequestsResponse> {
  const s = getStore();
  if (!s) return { source: "none", markets: [] };
  try {
    return { source: s.source, markets: await s.live(nowSeconds()) };
  } catch (e) {
    console.error("market requests: list failed", e);
    return { source: "none", markets: [] };
  }
}

export type RequestResult = { status: number; body: { requested: string[]; rejected: { symbol: string; reason: string }[] } | { error: string } };

/**
 * Validate each `{eventTicker, symbol}` against live Gemini data (listed, open, closes in the
 * future) and record it, or refresh its time if it is already requested.
 */
export async function requestMarkets(body: unknown): Promise<RequestResult> {
  const s = getStore();
  if (!s) return { status: 503, body: { error: "Market requests cannot be stored right now." } };
  const input = typeof body === "object" && body !== null ? (body as { markets?: unknown }).markets : undefined;
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_PER_REQUEST)
    return { status: 400, body: { error: `Send 1-${MAX_PER_REQUEST} markets as {eventTicker, symbol}.` } };

  const now = nowSeconds();
  const rows: MarketRequest[] = [];
  const rejected: { symbol: string; reason: string }[] = [];
  for (const raw of input) {
    const m = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const symbol = typeof m.symbol === "string" ? m.symbol : "";
    const ticker = typeof m.eventTicker === "string" ? m.eventTicker : "";
    const reject = (reason: string) => rejected.push({ symbol: symbol.slice(0, 120), reason });
    if (!isSafeId(symbol) || !isSafeId(ticker)) {
      reject("invalid symbol or event ticker");
      continue;
    }
    if (/-CMB(-|$)/i.test(symbol)) {
      reject("combos are requested through /api/combos");
      continue;
    }
    const found = await getEvent(ticker);
    // Only live Gemini data: a saved snapshot could describe a market that has since closed.
    if (!found || found.source !== "gemini") {
      reject(found ? "Gemini is unreachable" : "unknown event");
      continue;
    }
    const contract = found.event.contracts.find((c) => c.symbol === symbol);
    const closeTime = contract ? unixSeconds(contract.expiry ?? found.event.expiry) : 0n;
    if (!contract) reject("not a contract of this event");
    else if (!contract.open) reject("closed to trading");
    else if (closeTime <= BigInt(now)) reject("no future close time");
    else
      rows.push({
        marketId: keccak256(toBytes(symbol)),
        symbol,
        eventTicker: found.event.ticker,
        title: found.event.title.slice(0, 200),
        label: contract.label.slice(0, 200),
        closeTime: Number(closeTime),
        requestedAt: now,
      });
  }

  try {
    if (rows.length) {
      if ((await s.countLive(now)) + rows.length > MAX_LIVE_ROWS)
        return { status: 429, body: { error: "Too many markets are requested right now. Try again later." } };
      await s.upsert(rows);
    }
  } catch (e) {
    console.error("market requests: store failed", e);
    return { status: 503, body: { error: "Market requests cannot be stored right now." } };
  }
  return { status: 200, body: { requested: rows.map((r) => r.symbol), rejected } };
}
