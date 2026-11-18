// Market registration and the price loop: Gemini top of book -> PriceOracle.postPrices.
// Single markets are priced from their own book. Combos are priced from their legs' books and the
// combo's own book is never read. Books are cached per symbol and shared, so a leg that is also a
// tracked market (or a leg of two combos) is fetched once.
import { encodeFunctionData, type Address, type Hex } from "viem";
import { priceOracleAbi } from "./abis.js";
import { type Clients, type TxQueue } from "./chain.js";
import { type ComboDef } from "./combos.js";
import { topOfBook, type GeminiEvent, type GeminiPublic } from "./gemini/public.js";
import { errText, logger } from "./log.js";
import { type TrackedMarket } from "./markets.js";
import { buildQuote, comboQuote, marketIdOf, microToDecimal, toMicro, type Quote, type Top } from "./math.js";

const log = logger("oracle");

/** Minimum spacing of Gemini public requests (the limit is 120/min; we stay at <= 1/s). */
export const PUBLIC_MIN_GAP_MS = 1000;

interface Priced {
  marketId: Hex;
  /** Instrument symbol (single market) or combo symbol; used for logs only on combos. */
  symbol: string;
  registered: boolean;
  /** Latest derived quote, posted or not; `at` is the age of the oldest book it was built from. */
  latest?: { quote: Quote; at: number };
  posted?: { quote: Quote; at: number };
  /** Do not include in a batch before this time (set after an individual post failure). */
  penaltyUntil: number;
  lastWarnAt: number;
}

interface MarketState extends TrackedMarket, Priced {}

interface ComboState extends Priced {
  def: ComboDef;
}

interface BookEntry {
  top: Top;
  at: number;
  /** False when the last fetch failed; such a book prices nothing until it is fetched again. */
  ok: boolean;
}

/** True when the market must be (re)posted: quote changed, or the heartbeat would lapse before the next cycle. */
export function needsPost(
  posted: { quote: Quote; at: number } | undefined,
  quote: Quote,
  now: number,
  heartbeatMs: number,
  pollMs: number,
): boolean {
  if (!posted) return true;
  if (posted.quote.bid !== quote.bid || posted.quote.ask !== quote.ask) return true;
  return now - posted.at + pollMs >= heartbeatMs;
}

/** Books one price cycle may fetch at <= 1 request/s, leaving a slot for execution and fallbacks. */
export function booksPerCycle(pollMs: number, minGapMs = PUBLIC_MIN_GAP_MS): number {
  return Math.max(1, Math.floor(pollMs / minGapMs) - 1);
}

/**
 * Most distinct books that can be rotated through while every quote is still refreshed, and so
 * every market and combo re-posted, inside the heartbeat (which sits inside the oracle's 60 s).
 */
export function maxDistinctBooks(pollMs: number, heartbeatMs: number, minGapMs = PUBLIC_MIN_GAP_MS): number {
  const cycles = Math.max(1, Math.floor((heartbeatMs - pollMs) / pollMs));
  return booksPerCycle(pollMs, minGapMs) * cycles;
}

/** The `budget` symbols whose books are oldest (never-fetched first), in a stable order. */
export function pickBooksToRefresh(symbols: string[], fetchedAt: (symbol: string) => number, budget: number): string[] {
  return symbols
    .map((symbol, index) => ({ symbol, index, at: fetchedAt(symbol) }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .slice(0, Math.max(0, budget))
    .map((x) => x.symbol);
}

function clampUnit(v: bigint | null): bigint | null {
  if (v === null) return null;
  return v < 0n ? 0n : v > 1_000_000n ? 1_000_000n : v;
}

export class OracleFeed {
  private readonly markets = new Map<Hex, MarketState>();
  private readonly combos = new Map<Hex, ComboState>();
  private readonly books = new Map<string, BookEntry>();
  private readonly bookWarnAt = new Map<string, number>();
  private readonly eventCache = new Map<string, { at: number; event: GeminiEvent }>();
  private readonly budget: number;
  /** A book older than this prices nothing (the rotation keeps books well inside it). */
  private readonly maxBookAgeMs: number;

  constructor(
    private readonly clients: Clients,
    private readonly queue: TxQueue,
    private readonly gemini: GeminiPublic,
    private readonly oracle: Address,
    private readonly pollMs: number,
    private readonly heartbeatMs: number,
  ) {
    this.budget = booksPerCycle(pollMs);
    this.maxBookAgeMs = Math.max(heartbeatMs, pollMs * 2);
  }

  get tracked(): MarketState[] {
    return [...this.markets.values()];
  }

  get trackedCombos(): ComboDef[] {
    return [...this.combos.values()].map((c) => c.def);
  }

  marketSymbols(): string[] {
    return [...this.markets.values()].map((m) => m.symbol);
  }

  symbolOf(marketId: Hex): string | undefined {
    return this.markets.get(marketId.toLowerCase() as Hex)?.symbol;
  }

  comboOf(marketId: Hex): ComboDef | undefined {
    return this.combos.get(marketId.toLowerCase() as Hex)?.def;
  }

  /** Register on the oracle when new or when the close time changed. Sets `registered`. */
  private async ensureRegistered(p: Priced, closeTime: number): Promise<void> {
    try {
      const [isRegistered, onChainClose] = await Promise.all([
        this.clients.publicClient.readContract({
          address: this.oracle,
          abi: priceOracleAbi,
          functionName: "isRegistered",
          args: [p.marketId],
        }),
        this.clients.publicClient.readContract({
          address: this.oracle,
          abi: priceOracleAbi,
          functionName: "closeTime",
          args: [p.marketId],
        }),
      ]);
      p.registered = isRegistered;
      // The oracle rejects a close time that is not in the future, so never try with one.
      const future = closeTime > Math.floor(Date.now() / 1000);
      if (future && (!isRegistered || onChainClose !== BigInt(closeTime))) {
        await this.queue.send(
          `registerMarket ${p.symbol}`,
          this.oracle,
          encodeFunctionData({
            abi: priceOracleAbi,
            functionName: "registerMarket",
            args: [p.marketId, BigInt(closeTime)],
          }),
        );
        p.registered = true;
      }
      if (!p.registered) {
        log.warn("market is not registered and has no future close time; it will not be priced", { symbol: p.symbol });
      }
    } catch (err) {
      log.error("market registration failed", { symbol: p.symbol, err: errText(err) });
    }
  }

  /** Track the markets and register any that are new or whose close time changed. */
  async addMarkets(list: TrackedMarket[]): Promise<void> {
    for (const m of list) {
      const marketId = marketIdOf(m.symbol);
      if (this.markets.has(marketId)) continue;
      const state: MarketState = { ...m, marketId, registered: false, penaltyUntil: 0, lastWarnAt: 0 };
      this.markets.set(marketId, state);
      await this.ensureRegistered(state, m.closeTime);
    }
  }

  /** Replace the set of priced combos: drop the ones gone, register the new or changed ones. */
  async syncCombos(defs: ComboDef[]): Promise<void> {
    const wanted = new Map<Hex, ComboDef>();
    for (const def of defs) wanted.set(def.marketId.toLowerCase() as Hex, def);
    for (const id of [...this.combos.keys()]) if (!wanted.has(id)) this.combos.delete(id);
    for (const [id, def] of wanted) {
      if (this.markets.has(id)) continue; // a single market can never double as a combo
      let state = this.combos.get(id);
      const changed = !state || state.def.closeTime !== def.closeTime;
      if (!state) {
        state = { marketId: id, symbol: def.symbol, def, registered: false, penaltyUntil: 0, lastWarnAt: 0 };
        this.combos.set(id, state);
      } else {
        state.def = def;
      }
      if (changed || !state.registered) await this.ensureRegistered(state, def.closeTime);
    }
  }

  /** Every book the price loop needs: tracked markets plus the legs of tracked combos. Never a combo's own book. */
  private neededSymbols(): string[] {
    const out = new Set<string>();
    for (const m of this.markets.values()) if (m.registered) out.add(m.symbol);
    for (const c of this.combos.values()) if (c.registered) for (const leg of c.def.legs) out.add(leg.symbol);
    return [...out];
  }

  /** Fetch one book into the shared cache. Never throws; a failure is recorded so nothing prices off it. */
  private async refreshBook(symbol: string): Promise<BookEntry> {
    let entry: BookEntry;
    try {
      const top = topOfBook(await this.gemini.getBook(symbol));
      entry = {
        top: { bid: clampUnit(toMicro(top.bid, "down")), ask: clampUnit(toMicro(top.ask, "up")) },
        at: Date.now(),
        ok: true,
      };
    } catch (err) {
      entry = { top: { bid: null, ask: null }, at: Date.now(), ok: false };
      const last = this.bookWarnAt.get(symbol) ?? 0;
      if (Date.now() - last >= 60_000) {
        this.bookWarnAt.set(symbol, Date.now());
        log.warn("book fetch failed", { symbol, err: errText(err) });
      }
    }
    this.books.set(symbol, entry);
    return entry;
  }

  private usable(symbol: string, now: number): BookEntry | null {
    const entry = this.books.get(symbol);
    return entry && entry.ok && now - entry.at <= this.maxBookAgeMs ? entry : null;
  }

  /** Single-market quote from its cached book; an empty side falls back to the event's summary prices. */
  private async deriveMarket(m: MarketState): Promise<Quote | null> {
    const entry = this.usable(m.symbol, Date.now());
    if (!entry) return null;
    let bid: string | bigint | null | undefined = entry.top.bid;
    let ask: string | bigint | null | undefined = entry.top.ask;
    if ((bid === null || ask === null) && m.eventTicker) {
      const prices = await this.eventPrices(m);
      bid ??= prices?.bestBid;
      ask ??= prices?.bestAsk;
    }
    const quote = buildQuote(
      typeof bid === "bigint" ? microToDecimal(bid) : bid,
      typeof ask === "bigint" ? microToDecimal(ask) : ask,
    );
    if (quote) m.latest = { quote, at: entry.at };
    return quote;
  }

  /** Leg-derived combo quote; null when a leg book is missing, failed, stale, or has no side ask. */
  private deriveCombo(c: ComboState): Quote | null {
    const now = Date.now();
    const legs = [];
    let oldest = now;
    for (const leg of c.def.legs) {
      const entry = this.usable(leg.symbol, now);
      if (!entry) return null;
      oldest = Math.min(oldest, entry.at);
      legs.push({ outcome: leg.outcome, bid: entry.top.bid, ask: entry.top.ask });
    }
    const quote = comboQuote(legs);
    if (quote) c.latest = { quote, at: oldest };
    return quote;
  }

  private async eventPrices(m: MarketState) {
    try {
      let cached = this.eventCache.get(m.eventTicker);
      if (!cached || Date.now() - cached.at > 30_000) {
        cached = { at: Date.now(), event: await this.gemini.getEvent(m.eventTicker) };
        this.eventCache.set(m.eventTicker, cached);
      }
      return cached.event.contracts?.find((c) => c.instrumentSymbol === m.symbol)?.prices;
    } catch (err) {
      log.warn("event price fallback failed", { symbol: m.symbol, err: errText(err) });
      return undefined;
    }
  }

  /**
   * Quote for execution. Single market: cached quote if fresh, else a live book fetch. Combo:
   * derived from its legs, refetching only the leg books that are missing or older than `maxAgeMs`.
   * Null when it cannot be priced (the executor then falls back to the on-chain price).
   */
  async quoteFor(marketId: Hex, maxAgeMs = 15_000): Promise<Quote | null> {
    const id = marketId.toLowerCase() as Hex;
    const m = this.markets.get(id);
    if (m) {
      if (m.latest && Date.now() - m.latest.at <= maxAgeMs) return m.latest.quote;
      await this.refreshBook(m.symbol);
      return (await this.deriveMarket(m)) ?? m.latest?.quote ?? null;
    }
    const c = this.combos.get(id);
    if (!c) return null;
    const now = Date.now();
    for (const leg of c.def.legs) {
      const entry = this.books.get(leg.symbol);
      if (!entry || !entry.ok || now - entry.at > Math.max(maxAgeMs, this.maxBookAgeMs)) await this.refreshBook(leg.symbol);
    }
    return this.deriveCombo(c);
  }

  /** Startup: run cycles back to back until every needed book has been fetched once. */
  async prime(): Promise<void> {
    for (let i = 0; i < 6; i++) {
      await this.cycle();
      if (this.neededSymbols().every((symbol) => this.books.has(symbol))) return;
    }
  }

  /**
   * One price cycle: refresh the oldest books within the request budget, then post every market
   * and combo whose quote changed or whose heartbeat is due, in one batch.
   */
  async cycle(): Promise<void> {
    const needed = this.neededSymbols();
    for (const symbol of pickBooksToRefresh(needed, (s) => this.books.get(s)?.at ?? 0, this.budget)) {
      await this.refreshBook(symbol);
    }
    const keep = new Set(needed);
    for (const symbol of [...this.books.keys()]) if (!keep.has(symbol)) this.books.delete(symbol);

    const due: Array<{ p: Priced; quote: Quote }> = [];
    const consider = (p: Priced, quote: Quote | null, why: string) => {
      if (!quote) {
        this.warn(p, why);
        return;
      }
      const now = Date.now();
      if (now < p.penaltyUntil) return;
      if (needsPost(p.posted, quote, now, this.heartbeatMs, this.pollMs)) due.push({ p, quote });
    };
    for (const m of this.markets.values()) {
      if (m.registered) consider(m, await this.deriveMarket(m), "no bid/ask available; skipping");
    }
    for (const c of this.combos.values()) {
      if (c.registered) consider(c, this.deriveCombo(c), "combo not priceable from its legs this round; not posting");
    }
    if (due.length === 0) return;

    try {
      await this.post(due);
    } catch (err) {
      log.error("postPrices batch failed", { markets: due.length, err: errText(err) });
      if (due.length === 1) {
        due[0]!.p.penaltyUntil = Date.now() + 60_000;
        return;
      }
      // One bad market must not starve the rest: retry one by one and bench the offender.
      for (const entry of due) {
        try {
          await this.post([entry]);
        } catch (inner) {
          entry.p.penaltyUntil = Date.now() + 60_000;
          log.error("postPrices failed; pausing market for 60s", { symbol: entry.p.symbol, err: errText(inner) });
        }
      }
    }
  }

  private async post(entries: Array<{ p: Priced; quote: Quote }>): Promise<void> {
    await this.queue.send(
      `postPrices x${entries.length}`,
      this.oracle,
      encodeFunctionData({
        abi: priceOracleAbi,
        functionName: "postPrices",
        args: [entries.map((e) => e.p.marketId), entries.map((e) => e.quote.bid), entries.map((e) => e.quote.ask)],
      }),
    );
    const at = Date.now();
    for (const { p, quote } of entries) p.posted = { quote, at };
    log.info("posted", {
      prices: entries.map((e) => `${e.p.symbol}:${microToDecimal(e.quote.bid)}/${microToDecimal(e.quote.ask)}`).join(" "),
    });
  }

  private warn(p: Priced, message: string): void {
    const now = Date.now();
    if (now - p.lastWarnAt < 60_000) return;
    p.lastWarnAt = now;
    log.warn(message, { symbol: p.symbol });
  }
}
