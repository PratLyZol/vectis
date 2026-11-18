"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { isMock } from "@/config/contracts";
import { useEvent, useLegQuotes, useMarkets, useNow } from "@/hooks/useMarketData";
import {
  MAX_LEGS,
  canonicalLegKey,
  comboLabel,
  comboMarketId,
  comboTimes,
  toDollars,
  validateLegs,
  vectisComboSymbol,
  type Combo,
  type LegFacts,
  type Outcome,
} from "@/lib/combo";
import { demo } from "@/lib/demoStore";
import { fmtCents, fmtCloseTime, fmtLeverage, fmtPrice } from "@/lib/format";
import { comboQuote, maxLeverage } from "@/lib/math";
import type { MarketContract, MarketEvent } from "@/lib/types";

type BuilderLeg = LegFacts & { label: string; eventTitle: string; expiry: string };

const SAME_EVENT =
  "This event already has a leg in the combo. Results inside one event are linked, so the combo price would be wrong. Keep one leg per event.";

/** Pick legs from the loaded markets, choose Yes or No for each, and see the product price. */
export function ComboBuilder({ geminiCombos }: { geminiCombos: Combo[] }) {
  const router = useRouter();
  const { data: markets } = useMarkets();
  const now = useNow(10_000);
  const [search, setSearch] = useState("");
  const [ticker, setTicker] = useState<string | null>(null);
  const [legs, setLegs] = useState<BuilderLeg[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const events = useMemo(() => markets?.events ?? [], [markets]);
  const results = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q === "") return events.slice(0, 6);
    return events
      .filter(
        (e) =>
          e.title.toLowerCase().includes(q) ||
          e.ticker.toLowerCase().includes(q) ||
          e.contracts.some((c) => c.label.toLowerCase().includes(q)),
      )
      .slice(0, 6);
  }, [events, search]);

  // Every contract of the picked event (the list endpoint only carries the first few).
  const picked = useEvent(ticker ?? "", undefined, ticker !== null);
  const pickedEvent: MarketEvent | undefined = ticker ? (picked.data?.event ?? events.find((e) => e.ticker === ticker)) : undefined;

  const legSymbols = useMemo(() => legs.map((l) => l.symbol), [legs]);
  const quotes = useLegQuotes(legSymbols);
  const quote = useMemo(() => {
    if (legs.length === 0) return null;
    const legQuotes = [];
    for (const l of legs) {
      const q = quotes.get(l.symbol);
      if (!q) return null;
      legQuotes.push({ outcome: l.outcome, ...q });
    }
    return comboQuote(legQuotes);
  }, [legs, quotes]);

  const times = comboTimes(legs);
  const lev = quote && quote.ask > 0n && times ? maxLeverage(quote.ask, now, BigInt(times.closeTime)) : null;
  const check = now > 0n ? validateLegs(legs, Number(now)) : null;
  const usedEvent = (e: MarketEvent) =>
    legs.some((l) => l.eventTicker === e.ticker || (l.gameId && e.gameId && l.gameId === e.gameId));

  const add = (event: MarketEvent, contract: MarketContract, outcome: Outcome) => {
    setError(null);
    setLegs((current) => [
      ...current,
      {
        symbol: contract.symbol,
        outcome,
        label: contract.label,
        eventTitle: event.title,
        eventTicker: event.ticker,
        gameId: event.gameId ?? null,
        open: contract.open,
        expiry: contract.expiry ?? event.expiry ?? "",
      },
    ]);
  };

  const create = async () => {
    if (!check?.ok || !times) return;
    setError(null);
    if (isMock) {
      // Demo mode: the combo lives in this browser. The same leg set as a Gemini combo keeps its symbol.
      const key = canonicalLegKey(legs);
      const match = geminiCombos.find((c) => c.origin === "gemini" && canonicalLegKey(c.legs) === key);
      const symbol = match?.symbol ?? vectisComboSymbol(key);
      demo.saveCombo({
        marketId: comboMarketId(symbol),
        symbol,
        origin: match ? "gemini" : "vectis",
        label: match?.label ?? comboLabel(legs),
        legs: legs.map((l) => ({
          symbol: l.symbol,
          outcome: l.outcome,
          label: l.label,
          eventTitle: l.eventTitle,
          eventTicker: l.eventTicker,
          expiry: l.expiry,
        })),
        closeTime: times.closeTime,
        expiry: times.expiry,
        requested: true,
        indicative: quote ? { bid: toDollars(quote.bid), ask: toDollars(quote.ask) } : { bid: null, ask: null },
      });
      router.push(`/combo/${encodeURIComponent(symbol)}`);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/combos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ legs: legs.map((l) => ({ symbol: l.symbol, outcome: l.outcome })) }),
      });
      const body = (await res.json()) as { symbol?: string; error?: string };
      if (!res.ok || !body.symbol) throw new Error(body.error ?? "The combo could not be created.");
      router.push(`/combo/${encodeURIComponent(body.symbol)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The combo could not be created.");
      setBusy(false);
    }
  };

  const full = legs.length >= MAX_LEGS;
  const message = error ?? (legs.length === 0 ? "Add at least two legs." : check && !check.ok ? check.error : null);

  return (
    <section className="card mt-8 grid lg:grid-cols-[minmax(0,1fr)_400px]" aria-labelledby="builder-heading">
      <div className="min-w-0 p-4 md:p-6">
        <h2 id="builder-heading" className="text-[19px]">
          Combo builder
        </h2>
        <p className="mt-2 max-w-[56ch] text-[13px] text-muted">
          A combo pays out only if every leg resolves the way you choose. Pick two to six legs, each from a different
          event.
        </p>

        <label className="label mt-5" htmlFor="leg-search">
          Search markets for a leg
        </label>
        <input
          id="leg-search"
          type="search"
          className="field"
          placeholder="Team, asset or ticker"
          autoComplete="off"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setTicker(null);
          }}
        />

        {ticker === null ? (
          <ul className="m-0 mt-3 grid grid-cols-1 list-none gap-1 p-0" aria-label="Matching markets">
            {results.length === 0 ? (
              <li className="note">No loaded market matches that search.</li>
            ) : (
              results.map((e) => (
                <li key={e.ticker} className="min-w-0">
                  <button
                    type="button"
                    className="flex min-h-11 w-full cursor-pointer items-center justify-between gap-3 border-0 bg-transparent px-2 text-left font-[inherit] text-text hover:bg-raised"
                    onClick={() => setTicker(e.ticker)}
                  >
                    <span className="min-w-0 truncate">{e.title}</span>
                    <span className="shrink-0 text-[12px] text-muted">
                      {usedEvent(e) ? "Has a leg" : `${e.contractCount} ${e.contractCount === 1 ? "contract" : "contracts"}`}
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
        ) : pickedEvent ? (
          <div className="fade-in mt-4">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h3 className="text-[15px]">{pickedEvent.title}</h3>
              <button
                type="button"
                className="link link-tap cursor-pointer border-0 bg-transparent p-0 font-[inherit] text-[13px]"
                onClick={() => setTicker(null)}
              >
                Pick another market
              </button>
            </div>
            {usedEvent(pickedEvent) ? <p className="note appear mt-3">{SAME_EVENT}</p> : null}
            {full ? <p className="note mt-3">A combo can have at most {MAX_LEGS} legs. Remove one to add another.</p> : null}
            <ul className="-mx-2 m-0 mt-2 max-h-[280px] list-none overflow-y-auto p-0">
              {pickedEvent.contracts.map((c) => {
                const noPrice = c.yesBid !== null ? 1_000_000 - c.yesBid : null;
                const blocked = full || usedEvent(pickedEvent) || !c.open;
                return (
                  <li key={c.symbol} className="flex min-h-11 flex-wrap items-center gap-2 px-2 py-1.5">
                    <span className="min-w-0 flex-1 truncate">{c.label}</span>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={blocked || c.yesAsk === null}
                      onClick={() => add(pickedEvent, c, "yes")}
                      aria-label={`Add ${c.label} Yes at ${fmtCents(c.yesAsk)}`}
                    >
                      Add Yes <span className="num text-accent">{fmtCents(c.yesAsk)}</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={blocked || noPrice === null}
                      onClick={() => add(pickedEvent, c, "no")}
                      aria-label={`Add ${c.label} No at ${fmtCents(noPrice)}`}
                    >
                      Add No <span className="num text-danger">{fmtCents(noPrice)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : (
          <p className="mt-4 text-muted" role="status">
            Loading contracts…
          </p>
        )}
      </div>

      <div className="min-w-0 border-t border-border p-4 md:p-6 lg:border-l lg:border-t-0">
        <h3 className="text-[17px]">
          Your combo <span className="num text-muted">{legs.length}</span>
        </h3>

        {legs.length === 0 ? (
          <p className="mt-3 text-[13px] text-muted">No legs yet. Search for a market and add its Yes or No.</p>
        ) : (
          <ul className="m-0 mt-3 grid grid-cols-1 list-none gap-3 p-0">
            {legs.map((l) => (
              <li key={l.symbol} className="appear min-w-0 border-t border-border pt-3 first:border-t-0 first:pt-0">
                <p className="truncate">{l.label}</p>
                <p className="truncate text-[12px] text-muted">
                  {l.eventTitle} · closes <span className="num">{fmtCloseTime(l.expiry)}</span>
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <div className="seg w-[168px]" role="radiogroup" aria-label={`Outcome for ${l.label}`}>
                    {(["yes", "no"] as const).map((o) => (
                      <label key={o} className="seg-item" data-tone={o}>
                        <input
                          type="radio"
                          name={`leg-${l.symbol}`}
                          checked={l.outcome === o}
                          onChange={() => setLegs((cur) => cur.map((x) => (x.symbol === l.symbol ? { ...x, outcome: o } : x)))}
                        />
                        {o === "yes" ? "Yes" : "No"}
                      </label>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary ml-auto"
                    onClick={() => setLegs((cur) => cur.filter((x) => x.symbol !== l.symbol))}
                    aria-label={`Remove ${l.label}`}
                  >
                    Remove leg
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <dl className="rows mt-5">
          <div>
            <dt>Combo price (product of the legs)</dt>
            <dd className="num">{quote ? fmtPrice(quote.ask) : "n/a"}</dd>
          </div>
          <div>
            <dt>Max leverage at this price</dt>
            <dd className="num">{lev !== null ? fmtLeverage(lev) : "n/a"}</dd>
          </div>
          <div>
            <dt>First leg closes</dt>
            <dd className="num">{times ? fmtCloseTime(new Date(times.closeTime * 1000).toISOString()) : "n/a"}</dd>
          </div>
        </dl>

        <button
          type="button"
          className="btn btn-primary btn-block mt-5"
          disabled={busy || !check?.ok}
          onClick={() => void create()}
        >
          {busy ? "Creating combo…" : "Create combo"}
        </button>
        <p className={`mt-3 min-h-[20px] text-[13px] ${error ? "text-danger" : "text-muted"}`} aria-live="polite">
          {message}
        </p>
      </div>
    </section>
  );
}
