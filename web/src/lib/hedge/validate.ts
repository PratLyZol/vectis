// Turns the hedge agent's raw `propose_hedge` arguments into a HedgeProposal the UI can trust.
// Pure: no fetches. The server passes in freshly fetched events; the browser reuses the figure
// helpers when the user edits a leg. Model-supplied numbers are never trusted: prices, leverage
// limits and every preview figure are recomputed here from market data and lib/math.ts.
import {
  LEVERAGE_STEP,
  LEVERAGE_UNIT,
  MIN_MARGIN,
  ONE,
  SIDE_NO,
  SIDE_YES,
  maxLeverage,
  previewOpen,
  sideAsk,
  type OpenPreview,
} from "../math";
import { unixSeconds } from "../format";
import type {
  DataSource,
  HedgeDirection,
  HedgeExposure,
  HedgeHolderType,
  HedgeInstrumentClass,
  HedgeLeg,
  HedgeProposal,
  HedgeScenario,
  MarketContract,
  MarketEvent,
} from "../types";

export const MAX_LEGS = 6;
export const MAX_SCENARIOS = 4;
const MAX_TEXT = 600;

const HOLDER_TYPES: HedgeHolderType[] = ["individual", "small_business", "fund", "firm", "other"];
const INSTRUMENT_CLASSES: HedgeInstrumentClass[] = [
  "equity",
  "crypto",
  "commodity",
  "rates_or_loan",
  "fx",
  "real_asset",
  "operating_cost",
  "revenue",
  "event",
  "other",
];
const DIRECTIONS: HedgeDirection[] = ["long", "short", "cost", "revenue", "liability"];

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max = MAX_TEXT): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const finite = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[$,\s]/g, "")) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};
const pick = <T extends string>(v: unknown, allowed: T[], fallback: T): T =>
  typeof v === "string" && (allowed as string[]).includes(v) ? (v as T) : fallback;

// ---------------------------------------------------------------------------------------------
// Figures shared by the server and the editor.

export const sideOf = (side: HedgeLeg["side"]) => (side === "yes" ? SIDE_YES : SIDE_NO);

/** Side-space ask for a contract, or null when that side cannot be bought. */
export function contractAsk(c: MarketContract, side: HedgeLeg["side"]): bigint | null {
  if (side === "yes" && c.yesAsk === null) return null;
  if (side === "no" && c.yesBid === null) return null;
  const p = sideAsk(sideOf(side), BigInt(c.yesBid ?? 0), BigInt(c.yesAsk ?? 0));
  return p > 0n && p < ONE ? p : null;
}

/** Leverage in tenths from a multiplier the model picked, rounded down to a 0.5x step, in [1x, max]. */
export function clampLeverage(tenths: bigint, max: bigint): bigint {
  let t = (tenths / LEVERAGE_STEP) * LEVERAGE_STEP;
  if (t > max) t = max;
  if (t < LEVERAGE_UNIT) t = LEVERAGE_UNIT;
  return t;
}

export function legPreview(leg: Pick<HedgeLeg, "margin" | "leverage" | "price">): OpenPreview {
  return previewOpen(BigInt(leg.margin), BigInt(leg.leverage), BigInt(leg.price));
}

/** Held to resolution: a winning leg pays its contracts minus the borrow; a losing leg loses margin + fee. */
export function legPnl(leg: Pick<HedgeLeg, "margin" | "leverage" | "price">, wins: boolean): bigint {
  const p = legPreview(leg);
  return wins ? p.payoutIfWin - p.total : -p.total;
}

export function scenarioPnl(legs: HedgeLeg[], scenario: HedgeScenario): bigint {
  const winners = new Set(scenario.winningSymbols);
  return legs.reduce((sum, l) => sum + legPnl(l, winners.has(l.symbol)), 0n);
}

export function proposalTotals(legs: HedgeLeg[]) {
  let margin = 0n;
  let fees = 0n;
  let borrowed = 0n;
  let payoutIfAllWin = 0n;
  for (const l of legs) {
    const p = legPreview(l);
    margin += p.maxLoss;
    fees += p.fee;
    borrowed += p.borrowed;
    payoutIfAllWin += p.payoutIfWin;
  }
  return { margin, fees, borrowed, total: margin + fees, maxLoss: margin + fees, payoutIfAllWin };
}

// ---------------------------------------------------------------------------------------------
// Building a proposal from the model's arguments.

function findContract(events: MarketEvent[], ticker: string, symbol: string) {
  const byTicker = events.find((e) => e.ticker === ticker);
  const inTicker = byTicker?.contracts.find((c) => c.symbol === symbol);
  if (byTicker && inTicker) return { event: byTicker, contract: inTicker };
  // The model sometimes pairs a symbol with the wrong event; the symbol is the source of truth.
  for (const e of events) {
    const c = e.contracts.find((x) => x.symbol === symbol);
    if (c) return { event: e, contract: c };
  }
  return null;
}

function parseExposure(raw: unknown): HedgeExposure {
  const r = isObj(raw) ? raw : {};
  const notional = finite(r.notional_usd);
  return {
    holderType: pick(r.holder_type, HOLDER_TYPES, "other"),
    description: text(r.description),
    instrumentClass: pick(r.instrument_class, INSTRUMENT_CLASSES, "other"),
    direction: pick(r.direction, DIRECTIONS, "long"),
    notionalUsd: notional !== null && notional > 0 ? notional : null,
    horizon: text(r.horizon, 120) || null,
    adverseMove: text(r.adverse_move, 200),
  };
}

export type BuildInput = {
  raw: unknown; // propose_hedge arguments, already JSON-parsed
  events: MarketEvent[]; // full events (all contracts) for every ticker the legs reference
  nowSeconds: bigint;
  source: DataSource;
  quotedAt?: string;
};

export function buildProposal({ raw, events, nowSeconds, source, quotedAt }: BuildInput): HedgeProposal {
  const r = isObj(raw) ? raw : {};
  const warnings: string[] = Array.isArray(r.warnings)
    ? r.warnings.map((w) => text(w, 300)).filter(Boolean).slice(0, 8)
    : [];
  const legs: HedgeLeg[] = [];
  const seen = new Set<string>();
  const rawLegs = Array.isArray(r.legs) ? r.legs : [];

  for (const item of rawLegs) {
    if (!isObj(item)) continue;
    const symbol = text(item.symbol, 120);
    const ticker = text(item.event_ticker, 120);
    const side: HedgeLeg["side"] = item.side === "no" ? "no" : "yes";
    const name = symbol || "a leg";
    if (legs.length >= MAX_LEGS) {
      warnings.push(`Only ${MAX_LEGS} legs are allowed; ${name} was left out.`);
      continue;
    }
    const found = findContract(events, ticker, symbol);
    if (!found) {
      warnings.push(`${name} is not a listed Gemini contract and was left out.`);
      continue;
    }
    const { event, contract } = found;
    const where = `${event.title}: ${contract.label}`;
    if (!contract.open) {
      warnings.push(`${where} is closed to trading and was left out.`);
      continue;
    }
    const key = `${contract.symbol}:${side}`;
    if (seen.has(key)) continue;
    const price = contractAsk(contract, side);
    if (price === null) {
      warnings.push(`${where} has no ${side === "yes" ? "Yes" : "No"} offer right now and was left out.`);
      continue;
    }
    const marginUsd = finite(item.margin_usdc);
    if (marginUsd === null || marginUsd <= 0) {
      warnings.push(`${where} had no valid margin and was left out.`);
      continue;
    }
    let margin = BigInt(Math.floor(marginUsd * 1e6));
    if (margin < MIN_MARGIN) margin = MIN_MARGIN;

    const closeTime = unixSeconds(contract.expiry ?? event.expiry);
    const max = maxLeverage(price, nowSeconds, closeTime);
    const asked = finite(item.leverage) ?? 1;
    const askedTenths = BigInt(Math.max(0, Math.round(asked * 10)));
    const leverage = clampLeverage(askedTenths, max);
    if (askedTenths > max) {
      warnings.push(`${where}: leverage lowered to the ${Number(max) / 10}x limit for its price and close time.`);
    }

    seen.add(key);
    legs.push({
      eventTicker: event.ticker,
      eventTitle: event.title,
      category: event.category,
      imageUrl: event.imageUrl,
      symbol: contract.symbol,
      label: contract.label,
      expiry: contract.expiry ?? event.expiry,
      side,
      margin: Number(margin),
      leverage: Number(leverage),
      price: Number(price),
      maxLeverage: Number(max),
      rationale: text(item.rationale),
      hedgeMechanism: text(item.hedge_mechanism),
      basisRisk: item.basis_risk === "direct" ? "direct" : "proxy",
      basisRiskNote: text(item.basis_risk_note),
    });
  }

  const symbols = new Set(legs.map((l) => l.symbol));
  const scenarios: HedgeScenario[] = (Array.isArray(r.scenarios) ? r.scenarios : [])
    .filter(isObj)
    .slice(0, MAX_SCENARIOS)
    .map((s) => ({
      name: text(s.name, 80) || "Scenario",
      description: text(s.description, 300),
      winningSymbols: Array.isArray(s.winning_symbols)
        ? s.winning_symbols.filter((x): x is string => typeof x === "string" && symbols.has(x))
        : [],
    }));

  if (legs.length === 0 && rawLegs.length === 0 && warnings.length === 0) {
    warnings.push("No listed market is related closely enough to hedge this exposure.");
  }

  return {
    summary: text(r.summary, 1200),
    exposure: parseExposure(r.exposure),
    horizonNote: text(r.horizon_note, 400),
    legs,
    scenarios,
    warnings,
    quotedAt: quotedAt ?? new Date().toISOString(),
    source,
  };
}
