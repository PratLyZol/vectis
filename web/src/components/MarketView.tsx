"use client";

import { useState } from "react";
import Link from "next/link";
import type { EventResponse } from "@/lib/types";
import { useEvent } from "@/hooks/useMarketData";
import { fmtCents, fmtCloseTime, fmtCompactUsd } from "@/lib/format";
import { SIDE_YES, type Side } from "@/lib/math";
import { IconTile } from "./MarketHeader";
import { OrderBook } from "./OrderBook";
import { TradePanel } from "./TradePanel";

export function MarketView({
  initial,
  initialSymbol,
  initialSide = SIDE_YES,
}: {
  initial: EventResponse;
  initialSymbol?: string;
  initialSide?: Side; // preselected by a market card's Yes or No link
}) {
  const { data } = useEvent(initial.event.ticker, initial);
  const event = (data ?? initial).event;
  const [symbol, setSymbol] = useState(initialSymbol ?? event.contracts[0]?.symbol ?? "");
  const [side, setSide] = useState<Side>(initialSide);

  const contract = event.contracts.find((c) => c.symbol === symbol) ?? event.contracts[0];

  return (
    <>
      <p className="text-[13px]">
        <Link className="link link-tap" href="/markets">
          All markets
        </Link>
      </p>

      <header className="mt-4 flex items-start gap-4">
        <IconTile category={event.category} image={event.imageUrl} />
        <div className="min-w-0">
          <h1 className="text-[24px] md:text-[32px]">{event.title}</h1>
          <dl className="m-0 mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-muted">
            <div>
              <dt className="sr-only">Category</dt>
              <dd className="chip m-0">{event.category}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt>Closes</dt>
              <dd className="num m-0 text-text">{fmtCloseTime(contract?.expiry ?? event.expiry)}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt>Volume</dt>
              <dd className="num m-0 text-text">{fmtCompactUsd(event.volume)}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt>24h</dt>
              <dd className="num m-0 text-text">{fmtCompactUsd(event.volume24h)}</dd>
            </div>
          </dl>
        </div>
      </header>

      {(data ?? initial).source === "fixture" ? (
        <p className="note mt-4" role="status">
          Gemini&apos;s market feed did not respond, so this page shows a saved snapshot. Prices are not live.
        </p>
      ) : null}

      {!contract ? (
        <div className="card mt-8 p-6">
          <h2 className="text-[19px]">No contracts listed</h2>
          <p className="mt-2 text-muted">Gemini lists no tradable contracts for this event.</p>
        </div>
      ) : (
        <div className="mt-8 grid gap-4 md:gap-6 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-start">
          <div className="grid min-w-0 gap-4 md:gap-6">
            {event.contracts.length > 1 ? (
              <section className="card p-4 md:p-6" aria-labelledby="contracts-heading">
                <h2 id="contracts-heading" className="text-[19px]">
                  Contracts
                </h2>
                <div
                  role="radiogroup"
                  aria-labelledby="contracts-heading"
                  className="-mx-2 mt-3 max-h-[312px] overflow-y-auto"
                >
                  {event.contracts.map((c) => {
                    const selected = c.symbol === contract.symbol;
                    return (
                      <label
                        key={c.symbol}
                        className={`flex min-h-11 cursor-pointer items-center gap-3 px-2 py-2 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${
                          selected ? "bg-raised" : "hover:bg-raised"
                        }`}
                      >
                        <input
                          type="radio"
                          name="contract"
                          className="size-4 shrink-0 accent-accent outline-none"
                          checked={selected}
                          onChange={() => setSymbol(c.symbol)}
                        />
                        <span className={`min-w-0 flex-1 truncate ${selected ? "text-text" : "text-muted"}`}>{c.label}</span>
                        {!c.open ? <span className="chip">Closed</span> : null}
                        <span className="num w-[68px] text-right text-[13px] text-accent">
                          <span className="sr-only">Yes </span>
                          {fmtCents(c.yesAsk)}
                        </span>
                        <span className="num w-[68px] text-right text-[13px] text-danger">
                          <span className="sr-only">No </span>
                          {fmtCents(c.yesBid !== null ? 1_000_000 - c.yesBid : null)}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </section>
            ) : null}
            <OrderBook symbol={contract.symbol} side={side} onSideChange={setSide} />
          </div>
          <div className="min-w-0 lg:sticky lg:top-[88px]">
            <TradePanel event={event} contract={contract} side={side} onSideChange={setSide} />
            <p className="mt-3 text-[13px] text-muted">
              <Link className="link" href={`/replay?symbol=${encodeURIComponent(contract.symbol)}&t=${encodeURIComponent(event.ticker)}`}>
                Replay a position on this market&apos;s price history
              </Link>
            </p>
          </div>
        </div>
      )}
    </>
  );
}
