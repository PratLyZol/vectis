// Leveraged combos (parlays). A combo is just another marketId on the oracle; its price is derived
// from its legs' books (see comboQuote in math.ts) and its fills are always simulated. This module
// owns the definitions: fetching the web app's registry, validating, choosing which to track
// (newest requested, plus anything with an active position) and persisting them.
import { type Hex } from "viem";
import { errText, logger } from "./log.js";
import { marketIdOf } from "./math.js";

const log = logger("combos");

export const COMBO_TIMEOUT_MS = 5000;
export const MIN_LEGS = 2;
export const MAX_LEGS = 6;

export interface ComboLeg {
  symbol: string;
  outcome: "yes" | "no";
  label?: string;
  eventTitle?: string;
  eventTicker?: string;
  expiry?: string;
}

export interface ComboDef {
  marketId: Hex;
  symbol: string;
  origin?: string;
  label: string;
  legs: ComboLeg[];
  /** Unix seconds: the earliest leg expiry. */
  closeTime: number;
}

/** A combo's own symbol; such books are almost always empty and must never be read. */
export function isComboSymbol(symbol: string): boolean {
  return /-CMB(-|$)/i.test(symbol);
}

export type Validation = { ok: true; def: ComboDef } | { ok: false; reason: string };

/**
 * Check a registry row before it is trusted with money: marketId must be keccak256(symbol), 2-6
 * legs with distinct single-contract symbols and yes/no outcomes, and a close time in the future.
 * The close time used is the smaller of the feed's value and the earliest leg expiry.
 */
export function validateCombo(raw: unknown, nowSec: number): Validation {
  const r = (raw ?? {}) as Record<string, unknown>;
  const symbol = typeof r.symbol === "string" ? r.symbol.trim() : "";
  if (!symbol) return { ok: false, reason: "missing symbol" };
  const marketId = typeof r.marketId === "string" ? r.marketId.toLowerCase() : "";
  if (marketId !== marketIdOf(symbol).toLowerCase()) return { ok: false, reason: "marketId is not keccak256(symbol)" };
  if (!Array.isArray(r.legs)) return { ok: false, reason: "missing legs" };
  if (r.legs.length < MIN_LEGS || r.legs.length > MAX_LEGS) {
    return { ok: false, reason: `${r.legs.length} legs (need ${MIN_LEGS}-${MAX_LEGS})` };
  }

  const legs: ComboLeg[] = [];
  const seen = new Set<string>();
  let earliest = Number.POSITIVE_INFINITY;
  for (const rawLeg of r.legs as unknown[]) {
    const l = (rawLeg ?? {}) as Record<string, unknown>;
    const legSymbol = typeof l.symbol === "string" ? l.symbol.trim() : "";
    if (!legSymbol) return { ok: false, reason: "leg without a symbol" };
    if (legSymbol === symbol || isComboSymbol(legSymbol)) return { ok: false, reason: `leg ${legSymbol} is a combo` };
    if (seen.has(legSymbol)) return { ok: false, reason: `duplicate leg ${legSymbol}` };
    seen.add(legSymbol);
    if (l.outcome !== "yes" && l.outcome !== "no") return { ok: false, reason: `leg ${legSymbol} outcome is not yes/no` };
    const leg: ComboLeg = { symbol: legSymbol, outcome: l.outcome };
    for (const key of ["label", "eventTitle", "eventTicker", "expiry"] as const) {
      const v = l[key];
      if (typeof v === "string") leg[key] = v;
    }
    if (leg.expiry) {
      const ms = Date.parse(leg.expiry);
      if (Number.isFinite(ms)) earliest = Math.min(earliest, Math.floor(ms / 1000));
    }
    legs.push(leg);
  }

  const feedClose = typeof r.closeTime === "number" && Number.isFinite(r.closeTime) ? Math.floor(r.closeTime) : Number.POSITIVE_INFINITY;
  const closeTime = Math.min(feedClose, earliest);
  if (!Number.isFinite(closeTime)) return { ok: false, reason: "no close time" };
  if (closeTime <= nowSec) return { ok: false, reason: "close time is not in the future" };

  return {
    ok: true,
    def: {
      marketId: marketId as Hex,
      symbol,
      origin: typeof r.origin === "string" ? r.origin : undefined,
      label: typeof r.label === "string" ? r.label : symbol,
      legs,
      closeTime,
    },
  };
}

export interface ComboSelection {
  tracked: ComboDef[];
  /** Requested combos left out because their leg books would not fit the price-loop budget. */
  overBudget: ComboDef[];
  /** Distinct books the price loop must refresh (single markets + tracked combo legs). */
  books: number;
}

/**
 * Choose what to track. Combos with an active position are always kept (even past `count` and past
 * the book budget: dropping them would strand the position). The rest are the newest requested
 * ones, up to `count` in total, skipping any whose legs would push the distinct-book total over
 * `maxBooks` (legs shared with tracked markets or other combos cost nothing extra).
 */
export function selectCombos(opts: {
  /** Valid registry rows, newest first. */
  requested: ComboDef[];
  /** Definitions saved from earlier polls (used for carried combos the registry no longer lists). */
  saved: ComboDef[];
  /** Market ids (lowercase) that currently have an active position. */
  carried: ReadonlySet<string>;
  count: number;
  baseSymbols: Iterable<string>;
  maxBooks: number;
}): ComboSelection {
  const books = new Set(opts.baseSymbols);
  const tracked = new Map<string, ComboDef>();
  const add = (def: ComboDef) => {
    tracked.set(def.marketId.toLowerCase(), def);
    for (const leg of def.legs) books.add(leg.symbol);
  };

  for (const def of [...opts.requested, ...opts.saved]) {
    const key = def.marketId.toLowerCase();
    if (opts.carried.has(key) && !tracked.has(key)) add(def);
  }

  const overBudget: ComboDef[] = [];
  for (const def of opts.requested) {
    if (tracked.size >= opts.count) break;
    if (tracked.has(def.marketId.toLowerCase())) continue;
    const extra = def.legs.filter((leg) => !books.has(leg.symbol)).length;
    if (books.size + extra > opts.maxBooks) {
      overBudget.push(def);
      continue;
    }
    add(def);
  }
  return { tracked: [...tracked.values()], overBudget, books: books.size };
}

export interface ComboStore {
  getCombos(): ComboDef[];
  setCombos(defs: ComboDef[]): void;
}

export interface ComboSink {
  /** Symbols of the single markets the price loop already tracks. */
  marketSymbols(): string[];
  /** Replace the set of priced combos (registers new ones on the oracle). */
  syncCombos(defs: ComboDef[]): Promise<void>;
}

export class ComboRegistry {
  private available: boolean | null = null;
  private readonly rejected = new Set<string>();
  private lastSummary = "";
  private lastBudgetWarning = "";

  constructor(
    /** Web app base URL, or null: then only combos with active positions (from saved state) are priced. */
    private readonly baseUrl: string | null,
    private readonly count: number,
    private readonly maxBooks: number,
    private readonly store: ComboStore,
    private readonly sink: ComboSink,
    private readonly activeMarketIds: () => Iterable<string>,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  get tracked(): ComboDef[] {
    return this.store.getCombos();
  }

  /** Valid requested combos, newest first; null when the registry is unavailable. */
  private async fetchRequested(): Promise<ComboDef[] | null> {
    if (!this.baseUrl) return null;
    let body: { source?: unknown; combos?: unknown };
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/combos?requested=1`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(COMBO_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = (await res.json()) as typeof body;
      if (!body || !Array.isArray(body.combos)) throw new Error("malformed registry response");
      if (body.source === "none" && body.combos.length === 0) throw new Error('registry source is "none"');
    } catch (err) {
      if (this.available !== false) {
        log.warn("combo registry unavailable; keeping the combos already tracked", { why: errText(err, 120) });
      }
      this.available = false;
      return null;
    }
    if (this.available !== true) log.info("combo registry live");
    this.available = true;

    const nowSec = Math.floor(this.now() / 1000);
    const out: ComboDef[] = [];
    const seen = new Set<string>();
    for (const raw of (body.combos as unknown[]).slice(0, 50)) {
      if ((raw as { requested?: unknown } | null)?.requested === false) continue;
      const v = validateCombo(raw, nowSec);
      if (!v.ok) {
        const r = (raw ?? {}) as { symbol?: unknown; marketId?: unknown };
        const key = `${String(r.symbol ?? r.marketId ?? "?")}|${v.reason}`;
        if (!this.rejected.has(key)) {
          this.rejected.add(key);
          log.warn("skipping invalid combo", { symbol: String(r.symbol ?? "?"), reason: v.reason });
        }
        continue;
      }
      if (seen.has(v.def.marketId)) continue;
      seen.add(v.def.marketId);
      out.push(v.def);
    }
    return out;
  }

  /** One registry poll: refresh the tracked set, persist it and hand it to the price loop. Never throws. */
  async tick(): Promise<void> {
    try {
      const requested = await this.fetchRequested();
      const saved = this.store.getCombos();
      const carried = new Set([...this.activeMarketIds()].map((id) => id.toLowerCase()));
      const nowSec = Math.floor(this.now() / 1000);

      let tracked: ComboDef[];
      if (requested === null) {
        // Registry down (or not configured): keep what we had. Without a registry only combos
        // with positions matter; with one, keep unexpired ones so pricing survives the outage.
        tracked = saved.filter(
          (def) => carried.has(def.marketId.toLowerCase()) || (this.baseUrl !== null && def.closeTime > nowSec),
        );
      } else {
        const selection = selectCombos({
          requested,
          saved,
          carried,
          count: this.count,
          baseSymbols: this.sink.marketSymbols(),
          maxBooks: this.maxBooks,
        });
        tracked = selection.tracked;
        const warning = selection.overBudget.map((d) => d.symbol).join(",");
        if (warning && warning !== this.lastBudgetWarning) {
          log.warn("book budget reached: not tracking some requested combos (prices would go stale otherwise)", {
            notTracked: selection.overBudget.length,
            books: selection.books,
            maxBooks: this.maxBooks,
            symbols: warning,
          });
        }
        this.lastBudgetWarning = warning;
      }

      this.store.setCombos(tracked);
      await this.sink.syncCombos(tracked);
      const summary = tracked.map((d) => d.symbol).join(",");
      if (summary !== this.lastSummary) {
        this.lastSummary = summary;
        log.info(`tracking ${tracked.length} combo${tracked.length === 1 ? "" : "s"}`, {
          combos: tracked.map((d) => `${d.symbol}(${d.legs.length} legs)`).join(" ") || undefined,
        });
      }
    } catch (err) {
      log.error("combo poll failed", { err: errText(err) });
    }
  }
}
