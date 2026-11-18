// Bundled fallback used when Gemini's public API fails or times out, so pages always load.
// fixtures.json is a snapshot of real Gemini events in the app's normalised shape.
import snapshot from "./fixtures.json";
import comboSnapshot from "./fixtures-combos.json";
import { comboTimes } from "./combo";
import type { ComboDef, LegDef } from "./combos.server";
import type { BookLevel, MarketEvent } from "./types";

const DAY = 86_400_000;
const events = snapshot as MarketEvent[];

/** Shift snapshot dates forward so no fixture market is already past its close. */
function shifted(): MarketEvent[] {
  const times = events.map((e) => (e.expiry ? Date.parse(e.expiry) : Number.NaN)).filter(Number.isFinite);
  if (times.length === 0) return events;
  const earliest = Math.min(...times);
  const target = Date.now() + 2 * DAY;
  const offset = earliest < target ? Math.ceil((target - earliest) / DAY) * DAY : 0;
  if (offset === 0) return events;
  const move = (iso: string | null) => (iso ? new Date(Date.parse(iso) + offset).toISOString() : null);
  return events.map((e) => ({
    ...e,
    expiry: move(e.expiry),
    contracts: e.contracts.map((c) => ({ ...c, expiry: move(c.expiry) })),
  }));
}

export function fixtureEvents(q: { category?: string; search?: string; limit?: number; offset?: number } = {}) {
  const search = q.search?.trim().toLowerCase();
  const category = q.category?.trim().toLowerCase();
  const filtered = shifted().filter(
    (e) =>
      (!category || e.category.toLowerCase() === category) &&
      (!search || e.title.toLowerCase().includes(search) || e.ticker.toLowerCase().includes(search)),
  );
  const offset = q.offset ?? 0;
  return filtered.slice(offset, offset + (q.limit ?? 60));
}

export function fixtureEvent(ticker: string): MarketEvent | null {
  return shifted().find((e) => e.ticker === ticker) ?? null;
}

/** A plain ladder around the snapshot quote for the symbol. */
export function fixtureBook(symbol: string): { bids: BookLevel[]; asks: BookLevel[] } {
  const contract = events.flatMap((e) => e.contracts).find((c) => c.symbol === symbol);
  if (!contract) return { bids: [], asks: [] };
  const bid = contract.yesBid ?? 480_000;
  const ask = contract.yesAsk ?? Math.min(990_000, bid + 20_000);
  const sizes = [420, 650, 900, 1200, 1500, 2100, 2600, 3400];
  const bids: BookLevel[] = [];
  const asks: BookLevel[] = [];
  sizes.forEach((amount, i) => {
    const b = bid - i * 10_000;
    const a = ask + i * 10_000;
    if (b >= 10_000) bids.push({ price: b, amount });
    if (a <= 990_000) asks.push({ price: a, amount });
  });
  return { bids, asks };
}

type ComboSnapshot = { symbol: string; origin: string; label: string; legs: (Omit<LegDef, "outcome"> & { outcome: string })[] };

/** Snapshot of real Gemini combos, with leg dates shifted forward so none has already closed. */
export function fixtureCombos(): ComboDef[] {
  const combos = comboSnapshot as ComboSnapshot[];
  const times = combos.flatMap((c) => c.legs.map((l) => Date.parse(l.expiry))).filter(Number.isFinite);
  if (times.length === 0) return [];
  const target = Date.now() + 2 * DAY;
  const earliest = Math.min(...times);
  const offset = earliest < target ? Math.ceil((target - earliest) / DAY) * DAY : 0;
  const out: ComboDef[] = [];
  for (const c of combos) {
    const legs: LegDef[] = c.legs.map((l) => ({
      ...l,
      outcome: l.outcome === "no" ? "no" : "yes",
      expiry: new Date(Date.parse(l.expiry) + offset).toISOString(),
    }));
    const t = comboTimes(legs);
    if (t) out.push({ symbol: c.symbol, origin: "gemini", label: c.label, legs, ...t });
  }
  return out;
}
