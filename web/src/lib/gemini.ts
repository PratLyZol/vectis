// Server-side access to Gemini's public prediction-market data. No key or secret is involved.
import type { BookLevel, BookResponse, EventResponse, MarketContract, MarketEvent, MarketsResponse } from "./types";
import { fixtureBook, fixtureEvent, fixtureEvents } from "./fixtures";

const BASE = (process.env.GEMINI_PUBLIC_BASE || "https://api.gemini.com").replace(/\/+$/, "");
const TIMEOUT_MS = 6000;
const LIST_TIMEOUT_MS = 12_000;
const LIST_CONTRACTS = 3;

type Raw = Record<string, unknown>;

export const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
export const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseFloat(v) : Number.NaN;
  return Number.isFinite(n) ? n : 0;
};

/** Decimal-dollar string in [0, 1] to a 1e6 integer; null when missing or out of range. */
export function toPrice(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseFloat(v) : Number.NaN;
  if (!Number.isFinite(n) || n < 0 || n > 1) return null;
  return Math.round(n * 1_000_000);
}

function normaliseContract(raw: unknown): MarketContract | null {
  if (!isObj(raw)) return null;
  const symbol = str(raw.instrumentSymbol);
  if (!symbol) return null;
  const prices = isObj(raw.prices) ? raw.prices : {};
  const buy = isObj(prices.buy) ? prices.buy : {};
  const sell = isObj(prices.sell) ? prices.sell : {};
  const yesBid = toPrice(prices.bestBid) ?? toPrice(sell.yes);
  const yesAsk = toPrice(prices.bestAsk) ?? toPrice(buy.yes);
  const state = str(raw.marketState);
  return {
    symbol,
    label: str(raw.label) || str(raw.abbreviatedName) || str(raw.ticker) || symbol,
    ticker: str(raw.ticker),
    open: str(raw.status) === "active" && (state === "" || state === "open"),
    expiry: str(raw.expiryDate) || null,
    yesBid,
    yesAsk,
    last: toPrice(prices.lastTradePrice),
  };
}

const leadScore = (c: MarketContract) => (c.open ? 2_000_000 : 0) + (c.yesBid ?? c.last ?? -1);

export function normaliseEvent(raw: unknown, maxContracts?: number): MarketEvent | null {
  if (!isObj(raw)) return null;
  const ticker = str(raw.ticker);
  if (!ticker) return null;
  const all = (Array.isArray(raw.contracts) ? raw.contracts : [])
    .map(normaliseContract)
    .filter((c): c is MarketContract => c !== null);
  // Lead contract first: the open contract the market currently favours.
  const lead = all.reduce<MarketContract | null>((best, c) => (!best || leadScore(c) > leadScore(best) ? c : best), null);
  const ordered = lead ? [lead, ...all.filter((c) => c !== lead)] : all;
  const image = str(raw.imageUrl);
  return {
    id: str(raw.id),
    ticker,
    title: str(raw.title) || ticker,
    slug: str(raw.slug),
    category: str(raw.category) || "Other",
    status: str(raw.status),
    expiry: str(raw.expiryDate) || lead?.expiry || null,
    imageUrl: image.startsWith("https://") ? image : null,
    volume: num(raw.volume),
    volume24h: num(raw.volume24h),
    gameId: str(raw.gameId) || null,
    contractCount: all.length,
    contracts: maxContracts ? ordered.slice(0, maxContracts) : ordered,
  };
}

export async function getJson(
  path: string,
  revalidate: number,
  timeoutMs = TIMEOUT_MS,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { accept: "application/json" },
    next: { revalidate },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 404 || res.status === 400) return { status: 404, body: null };
  if (!res.ok) throw new Error(`Gemini responded ${res.status}`);
  return { status: res.status, body: await res.json() };
}

// Gemini's event list is several megabytes, too large for Next's fetch cache, so normalised
// results are also kept in memory per server instance: fresh for `ttl`, shared by concurrent
// callers, and reused for up to five minutes if Gemini stops answering.
type Entry<T> = { at: number; value: T };
const memory = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();
const STALE_OK_MS = 5 * 60_000;
const MAX_ENTRIES = 300;

export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>, fallback: () => T): Promise<T> {
  const hit = memory.get(key) as Entry<T> | undefined;
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const running = inflight.get(key) as Promise<T> | undefined;
  if (running) return running;
  const run = (async () => {
    try {
      const value = await load();
      if (memory.size >= MAX_ENTRIES) memory.clear();
      memory.set(key, { at: Date.now(), value });
      return value;
    } catch {
      if (hit && Date.now() - hit.at < STALE_OK_MS) return hit.value;
      return fallback();
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, run);
  return run;
}

export type MarketsQuery = { category?: string; search?: string; limit?: number; offset?: number };

type FullMarkets = { source: MarketsResponse["source"]; events: MarketEvent[]; total: number };

/** The event list with every contract kept. Cached; getMarkets trims it for the browser. */
async function loadMarkets(q: MarketsQuery = {}): Promise<FullMarkets> {
  const params = new URLSearchParams({ status: "active", limit: String(q.limit ?? 60) });
  if (q.offset) params.set("offset", String(q.offset));
  if (q.category) params.set("category", q.category);
  if (q.search) params.set("search", q.search);
  return cached<FullMarkets>(
    `markets?${params}`,
    15_000,
    async () => {
      // The list is over 10 MB and can take several seconds to arrive, so it gets a longer limit.
      const { body } = await getJson(`/v1/prediction-markets/events?${params}`, 15, LIST_TIMEOUT_MS);
      if (!isObj(body) || !Array.isArray(body.data)) throw new Error("Unexpected events payload");
      const events = body.data.map((e) => normaliseEvent(e)).filter((e): e is MarketEvent => e !== null);
      const total = isObj(body.pagination) ? num(body.pagination.total) : events.length;
      return { source: "gemini", events, total: total || events.length };
    },
    () => {
      const events = fixtureEvents(q);
      return { source: "fixture", events, total: events.length };
    },
  );
}

export async function getMarkets(q: MarketsQuery = {}): Promise<MarketsResponse> {
  const full = await loadMarkets(q);
  return {
    source: full.source,
    total: full.total,
    events: full.events.map((e) => ({ ...e, contracts: e.contracts.slice(0, LIST_CONTRACTS) })),
  };
}

/** Quotes for every contract in the default event list, by instrument symbol. No extra fetch. */
export async function getQuoteIndex(): Promise<Map<string, MarketContract>> {
  const { events } = await loadMarkets();
  const out = new Map<string, MarketContract>();
  for (const e of events) for (const c of e.contracts) out.set(c.symbol, c);
  return out;
}

const SAFE_ID = /^[A-Za-z0-9._-]{1,120}$/;
export const isSafeId = (s: string) => SAFE_ID.test(s);

/** null means the event does not exist. */
export async function getEvent(ticker: string): Promise<EventResponse | null> {
  if (!isSafeId(ticker)) return null;
  return cached<EventResponse | null>(
    `event/${ticker}`,
    15_000,
    async () => {
      const { status, body } = await getJson(`/v1/prediction-markets/events/${encodeURIComponent(ticker)}`, 15);
      if (status === 404) return null;
      const event = normaliseEvent(body);
      if (!event) throw new Error("Unexpected event payload");
      return { source: "gemini", event };
    },
    () => {
      const event = fixtureEvent(ticker);
      return event ? { source: "fixture", event } : null;
    },
  );
}

function normaliseLevels(raw: unknown): BookLevel[] {
  if (!Array.isArray(raw)) return [];
  const out: BookLevel[] = [];
  for (const l of raw) {
    if (!isObj(l)) continue;
    const price = toPrice(l.price);
    const amount = num(l.amount);
    if (price !== null && amount > 0) out.push({ price, amount });
  }
  return out;
}

export async function getBook(symbol: string): Promise<BookResponse | null> {
  if (!isSafeId(symbol)) return null;
  return cached<BookResponse>(
    `book/${symbol}`,
    5_000,
    async () => {
      const { status, body } = await getJson(
        `/v1/book/${encodeURIComponent(symbol)}?limit_bids=12&limit_asks=12`,
        5,
      );
      // Gemini has no such instrument: an empty book, not an outage.
      if (status === 404) return { source: "gemini", bids: [], asks: [] };
      if (!isObj(body)) throw new Error("Unexpected book payload");
      return { source: "gemini", bids: normaliseLevels(body.bids), asks: normaliseLevels(body.asks) };
    },
    () => ({ source: "fixture", ...fixtureBook(symbol) }),
  );
}
