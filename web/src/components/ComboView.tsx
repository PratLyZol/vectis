"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { isMock } from "@/config/contracts";
import { useCombo, useLegQuotes, useNow } from "@/hooks/useMarketData";
import type { Combo } from "@/lib/combo";
import { demo, useDemoState } from "@/lib/demoStore";
import { fmtCloseTime, fmtPrice } from "@/lib/format";
import { ONE, SIDE_YES, comboQuote } from "@/lib/math";
import type { MarketContract, MarketEvent } from "@/lib/types";
import { fmtUntil } from "./CombosBrowser";
import { TradePanel } from "./TradePanel";

/** A combo's legs with their live quotes, the leg-derived price, and the trade panel (Yes only). */
export function ComboView({ symbol }: { symbol: string }) {
  const demoState = useDemoState();
  const queryClient = useQueryClient();
  const local = demoState.combos[symbol];
  // A combo held in this browser (demo mode) needs no server lookup.
  const remote = useCombo(symbol, !local);
  const combo: Combo | null | undefined = local ?? remote.data;
  const now = useNow(5_000);
  const [enabling, setEnabling] = useState(false);
  const [enableError, setEnableError] = useState<string | null>(null);

  const legSymbols = useMemo(() => (combo ? combo.legs.map((l) => l.symbol) : []), [combo]);
  const quotes = useLegQuotes(legSymbols);
  const quote = useMemo(() => {
    if (!combo) return null;
    const legQuotes = [];
    for (const l of combo.legs) {
      const q = quotes.get(l.symbol);
      if (!q) return null;
      legQuotes.push({ outcome: l.outcome, ...q });
    }
    return comboQuote(legQuotes);
  }, [combo, quotes]);

  if (combo === undefined) {
    return (
      <p className="text-muted" role="status">
        {remote.isError ? "The combo could not be loaded. It retries every few seconds." : "Loading the combo…"}
      </p>
    );
  }
  if (combo === null) {
    return (
      <div className="card max-w-[560px] p-6">
        <h1 className="text-[24px]">Combo not found</h1>
        <p className="mt-2 text-muted">
          Gemini does not list an active combo with this symbol, and nobody has built it on Vectis. It may have closed.
        </p>
        <Link href="/combos" className="btn btn-primary mt-5">
          See all combos
        </Link>
      </div>
    );
  }

  const closeIso = new Date(combo.closeTime * 1000).toISOString();
  const loaded = combo.legs.every((l) => quotes.has(l.symbol));
  const tradable = isMock || combo.requested;

  // The trade panel takes a market and a contract; a combo is one contract with a Yes side only.
  const event: MarketEvent = {
    id: combo.symbol,
    ticker: "",
    title: combo.label,
    slug: "",
    category: "Combo",
    status: "active",
    expiry: combo.expiry,
    imageUrl: null,
    volume: 0,
    volume24h: 0,
    contractCount: 1,
    contracts: [],
  };
  const contract: MarketContract = {
    symbol: combo.symbol,
    label: `${combo.legs.length}-leg combo`,
    ticker: "CMB",
    open: true,
    expiry: closeIso, // leverage rules run off the first leg to close
    yesBid: quote ? Number(quote.bid) : null,
    yesAsk: quote && quote.ask > 0n && quote.ask < ONE ? Number(quote.ask) : null,
    last: null,
  };

  const enable = async () => {
    setEnabling(true);
    setEnableError(null);
    try {
      const res = await fetch("/api/combos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbol: combo.symbol }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Trading could not be enabled for this combo.");
      await queryClient.invalidateQueries({ queryKey: ["combo", symbol] });
      void queryClient.invalidateQueries({ queryKey: ["combos"] });
    } catch (e) {
      setEnableError(e instanceof Error ? e.message : "Trading could not be enabled for this combo.");
    } finally {
      setEnabling(false);
    }
  };

  return (
    <>
      <p className="text-[13px]">
        <Link className="link link-tap" href="/combos">
          All combos
        </Link>
      </p>

      <header className="mt-4">
        <h1 className="text-[24px] md:text-[32px]">{combo.label}</h1>
        <dl className="m-0 mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-muted">
          <div>
            <dt className="sr-only">Type</dt>
            <dd className="chip m-0">{combo.legs.length}-leg combo</dd>
          </div>
          <div>
            <dt className="sr-only">Listed by</dt>
            <dd className="chip m-0">{combo.origin === "gemini" ? "Listed on Gemini" : "Built on Vectis"}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt>First leg closes</dt>
            <dd className="num m-0 text-text">
              {fmtCloseTime(closeIso)} {fmtUntil(combo.closeTime, now)}
            </dd>
          </div>
          <div className="flex gap-1.5">
            <dt>Last leg closes</dt>
            <dd className="num m-0 text-text">{fmtCloseTime(combo.expiry)}</dd>
          </div>
        </dl>
      </header>

      <div className="mt-8 grid gap-4 md:gap-6 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-start">
        <div className="grid min-w-0 grid-cols-1 gap-4 md:gap-6">
          <section className="card p-4 md:p-6" aria-labelledby="price-heading">
            <h2 id="price-heading" className="text-[19px]">
              Combo price
            </h2>
            <dl className="m-0 mt-4 grid grid-cols-2 gap-4">
              <div>
                <dt className="text-[13px] text-muted">Indicative ask (to open)</dt>
                <dd className="num m-0 mt-1 text-[22px] text-accent md:text-[26px]">
                  {quote ? fmtPrice(quote.ask) : loaded ? "n/a" : "…"}
                </dd>
              </div>
              <div>
                <dt className="text-[13px] text-muted">Indicative bid (to close)</dt>
                <dd className="num m-0 mt-1 text-[22px] md:text-[26px]">{quote ? fmtPrice(quote.bid) : loaded ? "n/a" : "…"}</dd>
              </div>
            </dl>
            <p className="mt-4 max-w-[62ch] text-[13px] text-muted">
              Indicative price, calculated from the legs. Gemini fills combos by quote request, so Vectis simulates combo
              fills at this price. Leverage ends one hour before the first leg closes, and the combo is worth nothing as
              soon as one leg loses.
            </p>
            {loaded && !quote ? (
              <p className="note mt-3">A leg has no offer on Gemini right now, so the combo cannot be priced.</p>
            ) : null}
          </section>

          <section className="card p-4 md:p-6" aria-labelledby="legs-heading">
            <h2 id="legs-heading" className="text-[19px]">
              Legs
            </h2>
            <table className="mt-4 w-full border-collapse text-[13px]">
              <caption className="sr-only">
                Each leg, the outcome it needs, and the bid and ask for that outcome. The combo price is the product of
                the legs.
              </caption>
              <thead>
                <tr className="text-[12px] text-muted">
                  <th scope="col" className="pb-2 text-left font-medium">
                    Leg
                  </th>
                  <th scope="col" className="pb-2 pl-2 text-left font-medium">
                    Needs
                  </th>
                  <th scope="col" className="pb-2 pl-2 text-right font-medium">
                    Bid
                  </th>
                  <th scope="col" className="pb-2 pl-2 text-right font-medium">
                    Ask
                  </th>
                  <th scope="col" className="hidden pb-2 pl-3 text-right font-medium sm:table-cell">
                    Closes
                  </th>
                </tr>
              </thead>
              <tbody>
                {combo.legs.map((l) => {
                  const q = quotes.get(l.symbol);
                  // Prices in the leg's required side: No = 1 - the YES price on the other side of the book.
                  const bid = !q ? undefined : l.outcome === "yes" ? q.yesBid : q.yesAsk === null ? null : ONE - q.yesAsk;
                  const ask = !q ? undefined : l.outcome === "yes" ? q.yesAsk : q.yesBid === null ? null : ONE - q.yesBid;
                  const cell = (v: bigint | null | undefined) => (v === undefined ? "…" : v === null ? "none" : fmtPrice(v));
                  return (
                    <tr key={l.symbol} className="border-t border-border align-top">
                      <th scope="row" className="py-3 text-left font-normal">
                        {l.eventTicker ? (
                          <Link
                            className="link"
                            href={`/market/${encodeURIComponent(l.eventTicker)}?c=${encodeURIComponent(l.symbol)}`}
                          >
                            {l.label}
                          </Link>
                        ) : (
                          l.label
                        )}
                        {l.eventTitle ? <span className="mt-0.5 block text-[12px] text-muted">{l.eventTitle}</span> : null}
                      </th>
                      <td className="py-3 pl-2">
                        <span className={`chip ${l.outcome === "yes" ? "chip-yes" : "chip-no"}`}>
                          {l.outcome === "yes" ? "Yes" : "No"}
                        </span>
                      </td>
                      <td className="num py-3 pl-2 text-right">{cell(bid)}</td>
                      <td className="num py-3 pl-2 text-right">{cell(ask)}</td>
                      <td className="num hidden py-3 pl-3 text-right text-muted sm:table-cell">{fmtCloseTime(l.expiry)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        </div>

        <div className="min-w-0 lg:sticky lg:top-[88px]">
          {tradable ? (
            <TradePanel
              event={event}
              contract={contract}
              side={SIDE_YES}
              onSideChange={() => {}}
              yesOnly
              meta={{ symbol: combo.symbol, eventTicker: "", title: combo.label, label: "Combo", expiry: combo.expiry, kind: "combo" }}
              waitingNote="Waiting for the Vectis keeper to register this combo and post its first price on-chain. This usually takes about ten seconds."
              noQuoteNote="A leg has no offer on Gemini right now, so the combo cannot be priced."
              // Keep the legs in this browser so the position can be named and marked on the portfolio.
              onSubmit={() => demo.saveCombo({ ...combo, requested: true })}
            />
          ) : (
            <section className="card p-4 md:p-6" aria-labelledby="enable-heading">
              <h2 id="enable-heading" className="text-[19px]">
                Trade this combo
              </h2>
              <p className="mt-2 text-[13px] text-muted">
                Nobody has traded this combo on Vectis yet. Enabling it asks the keeper to register the combo and start
                posting its price on-chain, after which you can open a position.
              </p>
              <button type="button" className="btn btn-primary btn-block mt-5" onClick={() => void enable()} disabled={enabling}>
                {enabling ? "Enabling trading…" : "Enable trading"}
              </button>
              <p className="mt-3 min-h-[20px] text-[13px] text-danger" role="alert">
                {enableError}
              </p>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
