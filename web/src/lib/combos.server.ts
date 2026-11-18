// Server-side combo data: Gemini's public combo list, the `combos` table of requested combos,
// leg lookups and leg-derived indicative prices. Imported by route handlers only.
import { neon } from "@neondatabase/serverless";
import {
  MAX_LEGS,
  MIN_LEGS,
  canonicalLegKey,
  comboLabel,
  comboMarketId,
  comboTimes,
  toDollars,
  validateLegs,
  vectisComboSymbol,
  type Combo,
  type ComboLeg,
  type CombosResponse,
  type Outcome,
} from "./combo";
import { cached, getBook, getEvent, getJson, getQuoteIndex, isObj, isSafeId, str } from "./gemini";
import { fixtureCombos } from "./fixtures";
import { comboQuote, type ComboLegQuote } from "./math";

const LIST_LIMIT = 60;
const PAGE_LIMIT = 100; // Gemini caps a page at 100
const MAX_PAGES = 6;
const REQUESTED_LIMIT = 50;
const MAX_FUTURE_ROWS = 200;
const BOOK_PRICED = 12; // requested combos priced from books in the list response

/** A leg plus the facts validation needs. The extra fields never leave the server. */
export type LegDef = ComboLeg & { gameId: string | null; open: boolean };
export type ComboDef = {
  symbol: string;
  origin: "gemini" | "vectis";
  label: string;
  legs: LegDef[];
  closeTime: number;
  expiry: string;
};

const clean = (s: string) => s.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
const NO_PRICE = { bid: null, ask: null };

function normaliseCombo(raw: unknown): ComboDef | null {
  if (!isObj(raw) || !isObj(raw.contract) || !Array.isArray(raw.legs)) return null;
  const symbol = str(raw.contract.instrumentSymbol);
  if (!symbol || !isSafeId(symbol)) return null;
  const legs: LegDef[] = [];
  const ordered = [...raw.legs].sort((a, b) => (isObj(a) ? Number(a.legIndex) : 0) - (isObj(b) ? Number(b.legIndex) : 0));
  for (const l of ordered) {
    if (!isObj(l) || !isObj(l.contract)) return null;
    const legSymbol = str(l.contract.instrumentSymbol);
    const required = str(l.requiredOutcome).toLowerCase();
    const expiry = str(l.contract.expiryDate);
    if (!legSymbol || (required !== "yes" && required !== "no") || !expiry) return null;
    legs.push({
      symbol: legSymbol,
      outcome: required,
      label: clean(str(l.contract.contractName) || str(l.contract.contractTicker) || legSymbol),
      eventTitle: clean(str(l.contract.eventName)),
      eventTicker: str(l.contract.eventTicker),
      expiry,
      gameId: str(l.contract.gameId) || null,
      open: str(l.contract.contractStatus).toLowerCase() === "active",
    });
  }
  const times = comboTimes(legs);
  if (legs.length === 0 || !times) return null;
  return {
    symbol,
    origin: "gemini",
    label: clean(str(raw.contract.contractName)) || comboLabel(legs),
    legs,
    ...times,
  };
}

type GeminiCombos = { source: "gemini" | "fixture"; combos: ComboDef[] };

/** The first page of Gemini's active combos, cached for 30 seconds. */
export async function getGeminiCombos(): Promise<GeminiCombos> {
  return cached<GeminiCombos>(
    "combos",
    30_000,
    async () => {
      const { body } = await getJson(`/v1/prediction-markets/combos?status=Active&limit=${LIST_LIMIT}&offset=0`, 30);
      if (!isObj(body) || !Array.isArray(body.combos)) throw new Error("Unexpected combos payload");
      const combos = body.combos.map(normaliseCombo).filter((c): c is ComboDef => c !== null);
      return { source: "gemini", combos };
    },
    () => ({ source: "fixture", combos: fixtureCombos() }),
  );
}

/** One Gemini combo by symbol; null when Gemini does not list it. */
export async function getGeminiCombo(symbol: string): Promise<ComboDef | null> {
  if (!isSafeId(symbol)) return null;
  const listed = (await getGeminiCombos()).combos.find((c) => c.symbol === symbol);
  if (listed) return listed;
  return cached<ComboDef | null>(
    `combo/${symbol}`,
    30_000,
    async () => {
      const { status, body } = await getJson(`/v1/prediction-markets/combos/${encodeURIComponent(symbol)}`, 30);
      if (status === 404) return null;
      const combo = normaliseCombo(body);
      if (!combo) throw new Error("Unexpected combo payload");
      return combo;
    },
    () => fixtureCombos().find((c) => c.symbol === symbol) ?? null,
  );
}

/** Every active Gemini combo keyed by its canonical leg key, to match a built combo. Cached 5 min. */
async function getGeminiCombosByKey(): Promise<Map<string, ComboDef>> {
  return cached<Map<string, ComboDef>>(
    "combo-keys",
    5 * 60_000,
    async () => {
      const out = new Map<string, ComboDef>();
      for (let page = 0; page < MAX_PAGES; page++) {
        const { body } = await getJson(
          `/v1/prediction-markets/combos?status=Active&limit=${PAGE_LIMIT}&offset=${page * PAGE_LIMIT}`,
          300,
        );
        if (!isObj(body) || !Array.isArray(body.combos)) throw new Error("Unexpected combos payload");
        for (const raw of body.combos) {
          const combo = normaliseCombo(raw);
          if (combo) out.set(canonicalLegKey(combo.legs), combo);
        }
        if (body.combos.length < PAGE_LIMIT) break;
      }
      return out;
    },
    () => new Map(),
  );
}

// ---------------------------------------------------------------------------------------------
// Indicative prices from the legs

const publicLeg = (l: ComboLeg): ComboLeg => ({
  symbol: l.symbol,
  outcome: l.outcome,
  label: l.label,
  eventTitle: l.eventTitle,
  eventTicker: l.eventTicker,
  expiry: l.expiry,
});

const toIndicative = (quotes: ComboLegQuote[] | null): Combo["indicative"] => {
  const q = quotes ? comboQuote(quotes) : null;
  return q ? { bid: toDollars(q.bid), ask: toDollars(q.ask) } : NO_PRICE;
};

/** From the cached event list only: no extra requests. Legs outside that list give no price. */
async function indicativeFromIndex(defs: { legs: ComboLeg[] }[]): Promise<Combo["indicative"][]> {
  const index = await getQuoteIndex();
  return defs.map((def) => {
    const quotes: ComboLegQuote[] = [];
    for (const leg of def.legs) {
      const c = index.get(leg.symbol);
      if (!c) return NO_PRICE;
      quotes.push({
        outcome: leg.outcome,
        yesBid: c.yesBid === null ? null : BigInt(c.yesBid),
        yesAsk: c.yesAsk === null ? null : BigInt(c.yesAsk),
      });
    }
    return toIndicative(quotes);
  });
}

/** From each leg's order book (cached 5 s per leg): best bid and best ask. */
async function indicativeFromBooks(legs: ComboLeg[]): Promise<Combo["indicative"]> {
  const books = await Promise.all(legs.map((l) => getBook(l.symbol)));
  const quotes = legs.map((leg, i): ComboLegQuote => {
    const book = books[i];
    const bids = book?.bids ?? [];
    const asks = book?.asks ?? [];
    return {
      outcome: leg.outcome,
      yesBid: bids.length ? BigInt(Math.max(...bids.map((b) => b.price))) : null,
      yesAsk: asks.length ? BigInt(Math.min(...asks.map((a) => a.price))) : null,
    };
  });
  return toIndicative(quotes);
}

const toCombo = (
  def: Pick<ComboDef, "symbol" | "origin" | "label" | "closeTime" | "expiry"> & { legs: ComboLeg[] },
  requested: boolean,
  indicative: Combo["indicative"],
): Combo => ({
  marketId: comboMarketId(def.symbol),
  symbol: def.symbol,
  origin: def.origin,
  label: def.label,
  legs: def.legs.map(publicLeg),
  closeTime: def.closeTime,
  expiry: def.expiry,
  requested,
  indicative,
});

// ---------------------------------------------------------------------------------------------
// The combos table: one row per combo someone asked to trade

type Row = {
  market_id: string;
  symbol: string;
  origin: string;
  label: string;
  legs: unknown;
  close_time: string | number;
  expiry_time: string | number;
};

const sqlClient = () => {
  const url = process.env.DATABASE_URL;
  return url ? neon(url) : null;
};

function rowToCombo(r: Row): Combo | null {
  const rawLegs = typeof r.legs === "string" ? (JSON.parse(r.legs) as unknown) : r.legs;
  if (!Array.isArray(rawLegs)) return null;
  const legs: ComboLeg[] = [];
  for (const l of rawLegs) {
    if (!isObj(l)) return null;
    const outcome = str(l.outcome);
    if (!str(l.symbol) || (outcome !== "yes" && outcome !== "no")) return null;
    legs.push({
      symbol: str(l.symbol),
      outcome,
      label: clean(str(l.label)),
      eventTitle: clean(str(l.eventTitle)),
      eventTicker: str(l.eventTicker),
      expiry: str(l.expiry),
    });
  }
  return {
    marketId: r.market_id as Combo["marketId"],
    symbol: r.symbol,
    origin: r.origin === "vectis" ? "vectis" : "gemini",
    label: clean(r.label),
    legs,
    closeTime: Number(r.close_time),
    expiry: new Date(Number(r.expiry_time) * 1000).toISOString(),
    requested: true,
    indicative: NO_PRICE,
  };
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Requested combos that have not reached their close time, newest first. null = no database. */
export async function listRequested(): Promise<Combo[] | null> {
  const sql = sqlClient();
  if (!sql) return null;
  try {
    const rows = (await sql`
      SELECT market_id, symbol, origin, label, legs, close_time, expiry_time
      FROM combos
      WHERE close_time > ${nowSeconds()}
      ORDER BY created_at DESC
      LIMIT ${REQUESTED_LIMIT}`) as Row[];
    return rows.map(rowToCombo).filter((c): c is Combo => c !== null);
  } catch {
    return null;
  }
}

async function findRequested(symbol: string): Promise<Combo | null> {
  const sql = sqlClient();
  if (!sql) return null;
  try {
    const rows = (await sql`
      SELECT market_id, symbol, origin, label, legs, close_time, expiry_time
      FROM combos WHERE symbol = ${symbol} LIMIT 1`) as Row[];
    return rows[0] ? rowToCombo(rows[0]) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Reads

/** Gemini's active combos merged with requested ones (requested first), priced from the event list. */
export async function listCombos(): Promise<CombosResponse> {
  const [gemini, requested] = await Promise.all([getGeminiCombos(), listRequested()]);
  const seen = new Set<string>();
  const merged: Combo[] = [];
  for (const c of requested ?? []) {
    if (seen.has(c.symbol)) continue;
    seen.add(c.symbol);
    merged.push(c);
  }
  for (const def of gemini.combos) {
    if (seen.has(def.symbol)) continue;
    seen.add(def.symbol);
    merged.push(toCombo(def, false, NO_PRICE));
  }
  // Requested combos are the ones being traded, so the newest of them are priced from their legs'
  // books. The rest use the cached event list, which only covers the markets Vectis has loaded.
  const [fromIndex, fromBooks] = await Promise.all([
    indicativeFromIndex(merged),
    Promise.all(merged.slice(0, BOOK_PRICED).map((c) => (c.requested ? indicativeFromBooks(c.legs) : null))),
  ]);
  return {
    source: gemini.source,
    combos: merged.map((c, i) => ({ ...c, indicative: fromBooks[i] ?? fromIndex[i] ?? NO_PRICE })),
  };
}

/** One combo with a live indicative price from its legs' books. null = unknown. */
export async function getCombo(symbol: string): Promise<Combo | null> {
  if (!isSafeId(symbol)) return null;
  const row = await findRequested(symbol);
  const base = row ?? (await getGeminiCombo(symbol).then((def) => (def ? toCombo(def, false, NO_PRICE) : null)));
  if (!base) return null;
  return { ...base, indicative: await indicativeFromBooks(base.legs) };
}

// ---------------------------------------------------------------------------------------------
// Requesting a combo

export type RequestResult = { status: number; body: Combo | { error: string; code: string } };
const fail = (status: number, code: string, error: string): RequestResult => ({ status, body: { error, code } });

/** Look a leg contract up on Gemini. The symbol is "GEMI-" + event ticker + "-" + contract ticker. */
async function resolveLeg(symbol: string, outcome: Outcome): Promise<LegDef | null> {
  if (!isSafeId(symbol) || !symbol.startsWith("GEMI-")) return null;
  const parts = symbol.slice(5).split("-");
  // The contract ticker is normally the last segment; allow for one that itself has a hyphen.
  for (let drop = 1; drop <= 3 && parts.length - drop >= 1; drop++) {
    const found = await getEvent(parts.slice(0, parts.length - drop).join("-"));
    const contract = found?.event.contracts.find((c) => c.symbol === symbol);
    if (found && contract) {
      const expiry = contract.expiry ?? found.event.expiry;
      return {
        symbol,
        outcome,
        label: clean(contract.label),
        eventTitle: clean(found.event.title),
        eventTicker: found.event.ticker,
        expiry: expiry ?? "",
        gameId: found.event.gameId ?? null,
        open: contract.open && found.event.status === "active",
      };
    }
  }
  return null;
}

const legFacts = (legs: LegDef[]) =>
  legs.map((l) => ({ symbol: l.symbol, outcome: l.outcome, eventTicker: l.eventTicker, gameId: l.gameId, open: l.open, expiry: l.expiry || null }));

/** Validate and store a combo someone wants to trade. `body` is the parsed POST body. */
export async function requestCombo(body: unknown): Promise<RequestResult> {
  if (!isObj(body)) return fail(400, "bad_request", "Send a JSON object with a symbol or a list of legs.");
  const sql = sqlClient();
  if (!sql) return fail(503, "no_database", "Combos cannot be stored right now.");

  let def: ComboDef;
  if (typeof body.symbol === "string") {
    const symbol = body.symbol;
    if (!isSafeId(symbol)) return fail(400, "bad_symbol", "That combo symbol is not valid.");
    const existing = await findRequested(symbol);
    if (existing) return { status: 200, body: { ...existing, indicative: await indicativeFromBooks(existing.legs) } };
    const found = await getGeminiCombo(symbol);
    if (!found) return fail(404, "unknown_combo", "Gemini does not list an active combo with that symbol.");
    def = found;
  } else if (Array.isArray(body.legs)) {
    const input = body.legs;
    if (input.length < MIN_LEGS) return fail(400, "too_few_legs", `A combo needs at least ${MIN_LEGS} legs.`);
    if (input.length > MAX_LEGS) return fail(400, "too_many_legs", `A combo can have at most ${MAX_LEGS} legs.`);
    const wanted: { symbol: string; outcome: Outcome }[] = [];
    for (const l of input) {
      if (!isObj(l) || typeof l.symbol !== "string" || (l.outcome !== "yes" && l.outcome !== "no"))
        return fail(400, "bad_leg", 'Each leg needs a symbol and an outcome of "yes" or "no".');
      wanted.push({ symbol: l.symbol, outcome: l.outcome });
    }
    if (new Set(wanted.map((l) => l.symbol)).size !== wanted.length)
      return fail(400, "duplicate_leg", "The same contract is in this combo twice.");
    const resolved = await Promise.all(wanted.map((l) => resolveLeg(l.symbol, l.outcome)));
    const legs: LegDef[] = [];
    for (let i = 0; i < resolved.length; i++) {
      const leg = resolved[i];
      if (!leg) return fail(400, "unknown_leg", `Gemini does not list a contract with the symbol ${clean(wanted[i]?.symbol ?? "").slice(0, 80)}.`);
      legs.push(leg);
    }
    const times = comboTimes(legs);
    if (!times) return fail(400, "leg_no_expiry", "One of the legs has no close time.");
    // The same leg set as an active Gemini combo takes Gemini's symbol.
    const key = canonicalLegKey(legs);
    const match = (await getGeminiCombosByKey()).get(key);
    def = match
      ? { ...match, legs }
      : { symbol: vectisComboSymbol(key), origin: "vectis", label: comboLabel(legs), legs, ...times };
    const existing = await findRequested(def.symbol);
    if (existing) return { status: 200, body: { ...existing, indicative: await indicativeFromBooks(existing.legs) } };
  } else {
    return fail(400, "bad_request", "Send a JSON object with a symbol or a list of legs.");
  }

  const check = validateLegs(legFacts(def.legs), nowSeconds());
  if (!check.ok) return fail(400, check.code, check.error);

  const combo = toCombo(def, true, NO_PRICE);
  try {
    const counted = (await sql`SELECT count(*)::int AS n FROM combos WHERE close_time > ${nowSeconds()}`) as { n: number }[];
    if ((counted[0]?.n ?? 0) >= MAX_FUTURE_ROWS)
      return fail(429, "table_full", "Too many combos are waiting to be traded. Try again once some have closed.");
    await sql`
      INSERT INTO combos (market_id, symbol, origin, label, legs, close_time, expiry_time)
      VALUES (${combo.marketId}, ${combo.symbol}, ${combo.origin}, ${combo.label}, ${JSON.stringify(combo.legs)}::jsonb,
              ${combo.closeTime}, ${Math.floor(Date.parse(combo.expiry) / 1000)})
      ON CONFLICT (market_id) DO NOTHING`;
  } catch {
    return fail(503, "database_error", "The combo could not be stored. Try again.");
  }
  return { status: 200, body: { ...combo, indicative: await indicativeFromBooks(combo.legs) } };
}
