// Market requests: single contracts the web app asks the keeper to price (the hedge agent proposes
// markets the startup selection may not cover). This module fetches the web app's list, validates
// it, chooses what fits the price-loop budget and hands it to the oracle feed. A request lapses
// REQUEST_TTL_S after it was last made, unless the market still carries a position.
import { type Hex } from "viem";
import { isComboSymbol } from "./combos.js";
import { errText, logger } from "./log.js";
import type { TrackedMarket } from "./markets.js";
import { marketIdOf } from "./math.js";

const log = logger("requests");

export const REQUEST_TIMEOUT_MS = 5000;
/** Matches the web app's REQUEST_TTL_SECONDS. */
export const REQUEST_TTL_S = 2 * 60 * 60;
const SAFE_SYMBOL = /^[A-Za-z0-9._-]{1,120}$/;

export interface RequestedMarket extends TrackedMarket {
  marketId: Hex;
  /** Unix seconds of the latest request. */
  requestedAt: number;
}

export type RequestValidation = { ok: true; market: RequestedMarket } | { ok: false; reason: string };

/** Check one row from the web app before it costs a registration transaction and a book slot. */
export function validateRequest(raw: unknown, nowSec: number): RequestValidation {
  const r = (raw ?? {}) as Record<string, unknown>;
  const symbol = typeof r.symbol === "string" ? r.symbol.trim() : "";
  if (!SAFE_SYMBOL.test(symbol)) return { ok: false, reason: "invalid symbol" };
  if (isComboSymbol(symbol)) return { ok: false, reason: "combo symbol" };
  const marketId = typeof r.marketId === "string" ? r.marketId.toLowerCase() : "";
  if (marketId !== marketIdOf(symbol).toLowerCase()) return { ok: false, reason: "marketId is not keccak256(symbol)" };
  const closeTime = typeof r.closeTime === "number" && Number.isFinite(r.closeTime) ? Math.floor(r.closeTime) : 0;
  if (closeTime <= nowSec) return { ok: false, reason: "close time is not in the future" };
  const requestedAt = typeof r.requestedAt === "number" && Number.isFinite(r.requestedAt) ? Math.floor(r.requestedAt) : 0;
  if (requestedAt + REQUEST_TTL_S <= nowSec) return { ok: false, reason: "request has lapsed" };
  const text = (v: unknown) => (typeof v === "string" ? v.slice(0, 200) : "");
  return {
    ok: true,
    market: {
      marketId: marketId as Hex,
      symbol,
      eventTicker: text(r.eventTicker),
      title: text(r.title),
      label: text(r.label),
      closeTime,
      requestedAt,
    },
  };
}

export interface RequestSelection {
  tracked: RequestedMarket[];
  /** Requests left out because their books would not fit the price-loop budget. */
  overBudget: RequestedMarket[];
}

/**
 * Choose which requests to price. Markets with an active position are always kept. The rest are
 * the newest requests, up to `count`, while the distinct books (base markets, combo legs and the
 * requests chosen so far) stay within `maxBooks`. A request for a market already priced for
 * another reason costs nothing and is skipped.
 */
export function selectRequests(opts: {
  /** Valid requests, newest first. */
  requested: RequestedMarket[];
  /** Requests tracked before this poll (kept when they carry a position). */
  saved: RequestedMarket[];
  /** Market ids (lowercase) with an active position. */
  carried: ReadonlySet<string>;
  /** Symbols whose books are already refreshed: base markets and combo legs. */
  baseSymbols: Iterable<string>;
  count: number;
  maxBooks: number;
}): RequestSelection {
  const books = new Set(opts.baseSymbols);
  const base = new Set(books);
  const tracked = new Map<string, RequestedMarket>();
  const add = (m: RequestedMarket) => {
    tracked.set(m.marketId.toLowerCase(), m);
    books.add(m.symbol);
  };
  for (const m of [...opts.requested, ...opts.saved]) {
    const key = m.marketId.toLowerCase();
    if (opts.carried.has(key) && !tracked.has(key) && !base.has(m.symbol)) add(m);
  }
  const overBudget: RequestedMarket[] = [];
  for (const m of opts.requested) {
    if (tracked.size >= opts.count) break;
    if (tracked.has(m.marketId.toLowerCase()) || base.has(m.symbol)) continue;
    if (books.size + 1 > opts.maxBooks) {
      overBudget.push(m);
      continue;
    }
    add(m);
  }
  return { tracked: [...tracked.values()], overBudget };
}

export interface RequestSink {
  /** Symbols already priced for other reasons: startup markets and tracked combo legs. */
  baseSymbols(): string[];
  /** Replace the set of requested markets (registers new ones, drops lapsed ones). */
  syncRequested(markets: RequestedMarket[]): Promise<void>;
  /** Persist marketId -> symbol so a position on a requested market survives a restart. */
  remember(markets: RequestedMarket[]): void;
}

export class MarketRequests {
  private available: boolean | null = null;
  private readonly rejected = new Set<string>();
  private lastSummary = "";
  private lastBudgetWarning = "";
  private current: RequestedMarket[] = [];

  constructor(
    /** Web app base URL, or null: requests are disabled. */
    private readonly baseUrl: string | null,
    private readonly count: number,
    private readonly maxBooks: number,
    private readonly sink: RequestSink,
    private readonly activeMarketIds: () => Iterable<string>,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  get tracked(): RequestedMarket[] {
    return this.current;
  }

  /** Valid requests, newest first; null when the list is unavailable. */
  private async fetchRequested(nowSec: number): Promise<RequestedMarket[] | null> {
    if (!this.baseUrl) return null;
    let body: { source?: unknown; markets?: unknown };
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/market-requests`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = (await res.json()) as typeof body;
      if (!body || !Array.isArray(body.markets)) throw new Error("malformed response");
      if (body.source === "none") throw new Error('request store is "none"');
    } catch (err) {
      if (this.available !== false) log.warn("market requests unavailable; keeping the requested markets already priced", { why: errText(err, 120) });
      this.available = false;
      return null;
    }
    if (this.available !== true) log.info("market requests live");
    this.available = true;

    const out: RequestedMarket[] = [];
    const seen = new Set<string>();
    for (const raw of (body.markets as unknown[]).slice(0, 50)) {
      const v = validateRequest(raw, nowSec);
      if (!v.ok) {
        const key = `${String((raw as { symbol?: unknown } | null)?.symbol ?? "?")}|${v.reason}`;
        if (!this.rejected.has(key)) {
          this.rejected.add(key);
          if (v.reason !== "request has lapsed") log.warn("skipping invalid market request", { key });
        }
        continue;
      }
      if (seen.has(v.market.marketId)) continue;
      seen.add(v.market.marketId);
      out.push(v.market);
    }
    return out;
  }

  /** One poll: choose the requested markets, then hand them to the price loop. Never throws. */
  async tick(): Promise<void> {
    if (!this.baseUrl) return;
    try {
      const nowSec = Math.floor(this.now() / 1000);
      const carried = new Set([...this.activeMarketIds()].map((id) => id.toLowerCase()));
      const fetched = await this.fetchRequested(nowSec);
      // List down: keep what is priced while its request is recent (or it carries a position).
      const requested =
        fetched ?? this.current.filter((m) => m.closeTime > nowSec && m.requestedAt + REQUEST_TTL_S > nowSec);
      const selection = selectRequests({
        requested,
        saved: this.current,
        carried,
        baseSymbols: this.sink.baseSymbols(),
        count: this.count,
        maxBooks: this.maxBooks,
      });
      const warning = selection.overBudget.map((m) => m.symbol).join(",");
      if (warning && warning !== this.lastBudgetWarning) {
        log.warn("book budget reached: not pricing some requested markets", { symbols: warning, maxBooks: this.maxBooks });
      }
      this.lastBudgetWarning = warning;

      this.current = selection.tracked;
      this.sink.remember(this.current);
      await this.sink.syncRequested(this.current);
      const summary = this.current.map((m) => m.symbol).join(",");
      if (summary !== this.lastSummary) {
        this.lastSummary = summary;
        log.info(`pricing ${this.current.length} requested market${this.current.length === 1 ? "" : "s"}`, {
          markets: summary || undefined,
        });
      }
    } catch (err) {
      log.error("market request poll failed", { err: errText(err) });
    }
  }
}
