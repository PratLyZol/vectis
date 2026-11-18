// Combos (parlays): shared shapes and the pure rules for identity, labels and leg validation.
// Used by the API routes, the builder and the tests. The keeper implements the same rules.
import { keccak256, sha256, toBytes, type Hex } from "viem";

export type Outcome = "yes" | "no";

export type ComboLeg = {
  symbol: string; // the leg contract's Gemini instrumentSymbol
  outcome: Outcome; // what the leg must resolve to
  label: string;
  eventTitle: string;
  eventTicker: string;
  expiry: string; // ISO
};

/** The API shape shared with the keeper. Field names are a contract; do not rename. */
export type Combo = {
  marketId: Hex;
  symbol: string;
  origin: "gemini" | "vectis";
  label: string;
  legs: ComboLeg[];
  closeTime: number; // unix seconds, earliest leg expiry
  expiry: string; // ISO, latest leg expiry
  requested: boolean;
  indicative: { bid: string | null; ask: string | null }; // decimal dollars
};

export type CombosResponse = { source: "gemini" | "fixture" | "database" | "none"; combos: Combo[] };

export const MIN_LEGS = 2;
export const MAX_LEGS = 6;
export const MIN_LEAD_SECONDS = 2 * 3600;

export const comboMarketId = (symbol: string): Hex => keccak256(toBytes(symbol));

/** Legs sorted by symbol, each `symbol:yes|no`, joined with `|`. */
export function canonicalLegKey(legs: { symbol: string; outcome: Outcome }[]): string {
  return [...legs]
    .sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0))
    .map((l) => `${l.symbol}:${l.outcome}`)
    .join("|");
}

/** Symbol of a combo built on Vectis: "VECTIS-CMB-" + first 16 hex chars of sha256(key), upper case. */
export function vectisComboSymbol(canonicalKey: string): string {
  return `VECTIS-CMB-${sha256(toBytes(canonicalKey)).slice(2, 18).toUpperCase()}`;
}

export const isComboSymbol = (symbol: string) => symbol.includes("-CMB-") || symbol.endsWith("-CMB");

const plain = (s: string) => s.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();

/** Gemini's wording: "Utah Yes + Arizona No", and from four legs "Utah Yes + Arizona No + 2 more". */
export function comboLabel(legs: { label: string; outcome: Outcome }[]): string {
  const part = (l: { label: string; outcome: Outcome }) => `${plain(l.label)} ${l.outcome === "yes" ? "Yes" : "No"}`;
  if (legs.length <= 3) return legs.map(part).join(" + ");
  return `${legs.slice(0, 2).map(part).join(" + ")} + ${legs.length - 2} more`;
}

/** Earliest leg expiry (unix seconds) is when leverage must be gone; the latest is the display expiry. */
export function comboTimes(legs: { expiry: string }[]): { closeTime: number; expiry: string } | null {
  const times = legs.map((l) => Date.parse(l.expiry));
  if (times.length === 0 || times.some(Number.isNaN)) return null;
  return {
    closeTime: Math.floor(Math.min(...times) / 1000),
    expiry: new Date(Math.max(...times)).toISOString(),
  };
}

/** What validation needs to know about a leg, looked up from Gemini. */
export type LegFacts = {
  symbol: string;
  outcome: Outcome;
  eventTicker: string;
  gameId?: string | null;
  open: boolean;
  expiry: string | null;
};

export type LegCheck = { ok: true } | { ok: false; code: string; error: string };

/**
 * The rules a combo's legs must meet before Vectis prices it as a product:
 * 2 to 6 legs, no repeated contract, no two legs from the same event or game (their outcomes
 * are linked, so multiplying their prices would be wrong), every leg an open single contract,
 * and the first leg to close more than two hours away.
 */
export function validateLegs(legs: LegFacts[], nowSeconds: number): LegCheck {
  if (legs.length < MIN_LEGS) return { ok: false, code: "too_few_legs", error: `A combo needs at least ${MIN_LEGS} legs.` };
  if (legs.length > MAX_LEGS) return { ok: false, code: "too_many_legs", error: `A combo can have at most ${MAX_LEGS} legs.` };

  const symbols = new Set<string>();
  const events = new Set<string>();
  const games = new Set<string>();
  for (const leg of legs) {
    if (leg.outcome !== "yes" && leg.outcome !== "no")
      return { ok: false, code: "bad_outcome", error: "Each leg must be Yes or No." };
    if (symbols.has(leg.symbol))
      return { ok: false, code: "duplicate_leg", error: "The same contract is in this combo twice." };
    symbols.add(leg.symbol);
    if (isComboSymbol(leg.symbol))
      return { ok: false, code: "combo_leg", error: "A leg must be a single contract, not another combo." };
    if (events.has(leg.eventTicker) || (leg.gameId && games.has(leg.gameId)))
      return {
        ok: false,
        code: "same_event",
        error:
          "Two legs come from the same event. Their results are linked, so the combo price would be wrong. Keep one leg per event.",
      };
    events.add(leg.eventTicker);
    if (leg.gameId) games.add(leg.gameId);
    if (!leg.open) return { ok: false, code: "leg_closed", error: "One of the legs is no longer open for trading." };
    const expiry = leg.expiry ? Date.parse(leg.expiry) : Number.NaN;
    if (Number.isNaN(expiry)) return { ok: false, code: "leg_no_expiry", error: "One of the legs has no close time." };
    if (expiry / 1000 - nowSeconds <= MIN_LEAD_SECONDS)
      return { ok: false, code: "closes_soon", error: "A leg closes within two hours. Pick legs that close later." };
  }
  return { ok: true };
}

/** 1e6 integer price to decimal dollars with six places, e.g. "0.412500". */
export const toDollars = (price: bigint | number): string => {
  const p = BigInt(price);
  return `${p / 1_000_000n}.${(p % 1_000_000n).toString().padStart(6, "0")}`;
};

/** Decimal-dollar string back to a 1e6 integer; null when missing or malformed. */
export function fromDollars(value: string | null | undefined): bigint | null {
  if (!value || !/^\d+(\.\d{1,6})?$/.test(value)) return null;
  const [whole = "0", frac = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
}
