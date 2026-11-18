// Market selection: pure filter + ranking over Gemini event payloads.
import type { GeminiContract, GeminiEvent } from "./gemini/public.js";
import { toMicro } from "./math.js";

export interface TrackedMarket {
  symbol: string;
  eventTicker: string;
  title: string;
  label: string;
  /** Unix seconds. Zero when unknown (market recovered from saved state only). */
  closeTime: number;
}

export interface SelectionOptions {
  count: number;
  nowMs: number;
  minBid?: bigint; // micro-dollars, inclusive
  maxBid?: bigint; // micro-dollars, inclusive
  minTimeToExpiryMs?: number;
  maxPerEvent?: number;
}

const DEFAULTS = {
  minBid: 150_000n,
  maxBid: 850_000n,
  minTimeToExpiryMs: 3 * 60 * 60 * 1000,
  maxPerEvent: 2,
};

export function expiryMs(contract: GeminiContract, event?: GeminiEvent): number | null {
  const raw = contract.expiryDate ?? event?.expiryDate;
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

export function toTracked(event: GeminiEvent, contract: GeminiContract): TrackedMarket | null {
  const ms = expiryMs(contract, event);
  if (!contract.instrumentSymbol || ms === null) return null;
  return {
    symbol: contract.instrumentSymbol,
    eventTicker: event.ticker ?? "",
    title: event.title ?? "",
    label: contract.label ?? contract.ticker ?? "",
    closeTime: Math.floor(ms / 1000),
  };
}

/** True when the contract passes every tradability filter. */
export function isEligible(event: GeminiEvent, contract: GeminiContract, opts: SelectionOptions): boolean {
  const o = { ...DEFAULTS, ...opts };
  if (!contract.instrumentSymbol) return false;
  // Combos are priced from their legs (combos.ts), never tracked as single markets.
  if (contract.isCombo === true || /-CMB(-|$)/i.test(contract.instrumentSymbol)) return false;
  if (contract.marketState !== "open") return false;
  const bid = toMicro(contract.prices?.bestBid, "down");
  const ask = toMicro(contract.prices?.bestAsk, "up");
  if (bid === null || ask === null) return false;
  if (bid < o.minBid || bid > o.maxBid) return false;
  const ms = expiryMs(contract, event);
  if (ms === null || ms - o.nowMs <= o.minTimeToExpiryMs) return false;
  return true;
}

function eventVolume(event: GeminiEvent): number {
  const v24 = Number(event.volume24h);
  if (Number.isFinite(v24) && event.volume24h !== undefined && event.volume24h !== null) return v24;
  const v = Number(event.volume);
  return Number.isFinite(v) ? v : 0;
}

/**
 * Pick up to `count` contracts: eligible, ranked by event 24h volume (fallback total volume),
 * at most `maxPerEvent` per event. Within an event the contracts closest to 50c go first.
 */
export function selectMarkets(events: GeminiEvent[], opts: SelectionOptions): TrackedMarket[] {
  const o = { ...DEFAULTS, ...opts };
  const ranked = events
    .map((event, index) => ({ event, index, volume: eventVolume(event) }))
    .sort((a, b) => b.volume - a.volume || a.index - b.index);

  const picked: TrackedMarket[] = [];
  const seen = new Set<string>();
  for (const { event } of ranked) {
    if (picked.length >= o.count) break;
    const eligible = (event.contracts ?? [])
      .filter((c) => isEligible(event, c, opts))
      .map((c) => ({ c, dist: distanceFromHalf(c) }))
      .sort((a, b) => (a.dist < b.dist ? -1 : a.dist > b.dist ? 1 : 0));
    let fromEvent = 0;
    for (const { c } of eligible) {
      if (picked.length >= o.count || fromEvent >= o.maxPerEvent) break;
      const tracked = toTracked(event, c);
      if (!tracked || seen.has(tracked.symbol)) continue;
      seen.add(tracked.symbol);
      picked.push(tracked);
      fromEvent++;
    }
  }
  return picked;
}

function distanceFromHalf(c: GeminiContract): bigint {
  const bid = toMicro(c.prices?.bestBid, "down") ?? 0n;
  const d = bid - 500_000n;
  return d < 0n ? -d : d;
}

/** Find specific symbols in a set of events (for KEEPER_SYMBOLS and recovered positions). */
export function findSymbols(events: GeminiEvent[], symbols: Iterable<string>): Map<string, TrackedMarket> {
  const wanted = new Set(symbols);
  const found = new Map<string, TrackedMarket>();
  for (const event of events) {
    for (const c of event.contracts ?? []) {
      if (!c.instrumentSymbol || !wanted.has(c.instrumentSymbol) || found.has(c.instrumentSymbol)) continue;
      const tracked = toTracked(event, c);
      if (tracked) found.set(c.instrumentSymbol, tracked);
    }
  }
  return found;
}
