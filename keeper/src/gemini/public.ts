// Gemini public market data (no auth). All prices are decimal-dollar strings, 0-1, YES space.
import { errText, logger } from "../log.js";

const log = logger("gemini");

export interface GeminiPrices {
  bestBid?: string | null;
  bestAsk?: string | null;
  lastTradePrice?: string | null;
  buy?: { yes?: string | null; no?: string | null };
  sell?: { yes?: string | null; no?: string | null };
}

export interface GeminiContract {
  instrumentSymbol?: string;
  label?: string;
  ticker?: string;
  status?: string;
  marketState?: string; // "open" | "closed"
  expiryDate?: string;
  isCombo?: boolean;
  prices?: GeminiPrices;
}

export interface GeminiEvent {
  ticker?: string;
  title?: string;
  category?: string;
  status?: string;
  expiryDate?: string;
  volume?: string | number | null;
  volume24h?: string | number | null;
  contracts?: GeminiContract[];
}

export interface EventsPage {
  data: GeminiEvent[];
  pagination?: { limit?: number; offset?: number; total?: number };
}

export interface BookLevel {
  price: string;
  amount: string;
  timestamp?: string | number;
}

export interface OrderBook {
  bids: BookLevel[];
  asks: BookLevel[];
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status}: ${body.slice(0, 200)}`);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Serialises requests with a minimum gap (public limit is 120 req/min; we stay at <= 1 req/s)
 * and backs off on 429 / 5xx.
 */
export class GeminiPublic {
  private chain: Promise<unknown> = Promise.resolve();
  private lastAt = 0;

  constructor(
    private readonly base: string,
    private readonly minGapMs = 1000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const wait = this.lastAt + this.minGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        return await fn();
      } finally {
        this.lastAt = Date.now();
      }
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  private getJson<T>(path: string, timeoutMs = 30_000): Promise<T> {
    return this.schedule(async () => {
      const url = `${this.base}${path}`;
      let backoff = 2000;
      for (let attempt = 1; ; attempt++) {
        let res: Response;
        try {
          res = await this.fetchImpl(url, {
            headers: { accept: "application/json" },
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (err) {
          if (attempt >= 3) throw new Error(`GET ${path} failed: ${errText(err)}`);
          await sleep(backoff);
          backoff *= 2;
          continue;
        }
        if (res.status === 429 || res.status >= 500) {
          const body = await res.text().catch(() => "");
          if (attempt >= 4) throw new HttpError(res.status, body);
          const retryAfter = Number(res.headers.get("retry-after"));
          const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff;
          log.warn("backing off", { status: res.status, path, waitMs: wait });
          await sleep(Math.min(wait, 30_000));
          backoff *= 2;
          continue;
        }
        if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ""));
        return (await res.json()) as T;
      }
    });
  }

  /** One page of active events. Pages are large (about 100 KB per event), so keep `limit` small. */
  async listEvents(limit: number, offset: number): Promise<EventsPage> {
    const page = await this.getJson<EventsPage>(
      `/v1/prediction-markets/events?status=active&limit=${limit}&offset=${offset}`,
      60_000,
    );
    return { data: Array.isArray(page?.data) ? page.data : [], pagination: page?.pagination };
  }

  /** Scan up to `maxEvents` active events, stopping early when `done(events)` says so. */
  async scanEvents(
    maxEvents: number,
    pageSize = 25,
    done?: (events: GeminiEvent[]) => boolean,
  ): Promise<GeminiEvent[]> {
    const events: GeminiEvent[] = [];
    for (let offset = 0; offset < maxEvents; offset += pageSize) {
      const page = await this.listEvents(Math.min(pageSize, maxEvents - offset), offset);
      events.push(...page.data);
      const total = page.pagination?.total;
      if (page.data.length === 0) break;
      if (typeof total === "number" && offset + page.data.length >= total) break;
      if (done?.(events)) break;
    }
    return events;
  }

  async getEvent(eventTicker: string): Promise<GeminiEvent> {
    return this.getJson<GeminiEvent>(`/v1/prediction-markets/events/${encodeURIComponent(eventTicker)}`);
  }

  /** Top of book for one contract (YES space). */
  async getBook(instrumentSymbol: string): Promise<OrderBook> {
    const book = await this.getJson<Partial<OrderBook>>(
      `/v1/book/${encodeURIComponent(instrumentSymbol)}?limit_bids=5&limit_asks=5`,
      15_000,
    );
    return {
      bids: Array.isArray(book?.bids) ? book.bids : [],
      asks: Array.isArray(book?.asks) ? book.asks : [],
    };
  }
}

/** Best (highest) bid and best (lowest) ask price strings; undefined for an empty side. */
export function topOfBook(book: OrderBook): { bid?: string; ask?: string } {
  const pick = (levels: BookLevel[], better: (a: number, b: number) => boolean): string | undefined => {
    let best: string | undefined;
    for (const level of levels) {
      const p = Number(level?.price);
      if (!Number.isFinite(p)) continue;
      if (best === undefined || better(p, Number(best))) best = String(level.price);
    }
    return best;
  };
  return { bid: pick(book.bids, (a, b) => a > b), ask: pick(book.asks, (a, b) => a < b) };
}
