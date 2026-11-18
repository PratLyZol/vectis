"use client";

import { useMemo } from "react";
import { useBook } from "@/hooks/useMarketData";
import type { BookLevel } from "@/lib/types";
import { fmtPrice } from "@/lib/format";
import { SIDE_NO, SIDE_YES, type Side } from "@/lib/math";
import { SideToggle } from "./SideToggle";

const LEVELS = 8;
const amount = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type Row = { price: number; amount: number; total: number };

/** Best price first, with a running total. */
function ladder(levels: BookLevel[], bestFirst: (a: BookLevel, b: BookLevel) => number): Row[] {
  let total = 0;
  return [...levels]
    .sort(bestFirst)
    .slice(0, LEVELS)
    .map((l) => {
      total += l.amount;
      return { ...l, total };
    });
}

function Rows({ rows, max, tone }: { rows: Row[]; max: number; tone: "bid" | "ask" }) {
  return (
    <>
      {rows.map((r) => (
        <tr
          key={`${tone}-${r.price}`}
          // Depth bar: the row's background fills to the cumulative share of the deepest side.
          style={{
            backgroundImage: `linear-gradient(to right, var(--book-${tone}) ${Math.max(2, (r.total / max) * 100)}%, transparent 0)`,
          }}
        >
          <td className="py-[5px] pl-3 text-left">
            <span className={tone === "bid" ? "text-[var(--book-ink)]" : "text-text"}>{fmtPrice(r.price)}</span>
          </td>
          <td className="py-[5px] text-right">{amount.format(r.amount)}</td>
          <td className="py-[5px] pr-3 text-right text-muted">{amount.format(r.total)}</td>
        </tr>
      ))}
    </>
  );
}

export function OrderBook({
  symbol,
  side,
  onSideChange,
}: {
  symbol: string;
  side: Side;
  onSideChange: (s: Side) => void;
}) {
  const { data, isLoading, isError } = useBook(symbol);

  const { asks, bids, max } = useMemo(() => {
    const rawBids = data?.bids ?? [];
    const rawAsks = data?.asks ?? [];
    // The NO book mirrors the YES book: a YES bid at p is a NO ask at 1 - p.
    const flip = (l: BookLevel): BookLevel => ({ price: 1_000_000 - l.price, amount: l.amount });
    const sideBids = side === SIDE_YES ? rawBids : rawAsks.map(flip);
    const sideAsks = side === SIDE_YES ? rawAsks : rawBids.map(flip);
    const b = ladder(sideBids, (x, y) => y.price - x.price);
    const a = ladder(sideAsks, (x, y) => x.price - y.price);
    const top = Math.max(b.at(-1)?.total ?? 0, a.at(-1)?.total ?? 0, 1);
    return { asks: [...a].reverse(), bids: b, max: top };
  }, [data, side]);

  const bestBid = bids[0]?.price;
  const bestAsk = asks.at(-1)?.price;
  const spread = bestBid !== undefined && bestAsk !== undefined ? bestAsk - bestBid : null;
  const name = side === SIDE_YES ? "Yes" : "No";

  return (
    <section
      className="card p-4 md:p-6"
      aria-labelledby="book-heading"
      style={
        {
          "--book-ink": side === SIDE_NO ? "var(--color-danger)" : "var(--color-accent)",
          "--book-bid": `color-mix(in srgb, ${side === SIDE_NO ? "var(--color-danger)" : "var(--color-accent)"} 16%, transparent)`,
          "--book-ask": "color-mix(in srgb, var(--color-text) 8%, transparent)",
        } as React.CSSProperties
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="book-heading" className="text-[19px]">
          Order book
        </h2>
        <SideToggle legend="Book side" name="book-side" side={side} onChange={onSideChange} compact />
      </div>

      {isLoading ? (
        <p className="mt-6 text-muted" role="status">
          Loading the order book…
        </p>
      ) : isError ? (
        <p className="note mt-6" role="status">
          The order book could not be loaded. It retries every few seconds.
        </p>
      ) : asks.length === 0 && bids.length === 0 ? (
        <p className="note mt-6">Gemini lists no resting orders for this contract right now.</p>
      ) : (
        <table className="num fade-in mt-4 w-full border-collapse text-[13px]">
          <caption className="sr-only">
            {name} order book: asks above the spread, bids below. Totals are cumulative contracts.
          </caption>
          <thead>
            <tr className="font-sans text-[12px] text-muted">
              <th scope="col" className="pb-2 pl-3 text-left font-medium">
                {name} price
              </th>
              <th scope="col" className="pb-2 text-right font-medium">
                Contracts
              </th>
              <th scope="col" className="pb-2 pr-3 text-right font-medium">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            <Rows rows={asks} max={max} tone="ask" />
            <tr>
              <td colSpan={3} className="border-y border-border px-3 py-2 font-sans text-[12px] text-muted">
                <span className="flex justify-between gap-3">
                  <span>
                    Asks above <span aria-hidden="true">↑</span> · Bids below <span aria-hidden="true">↓</span>
                  </span>
                  <span>
                    Spread <span className="num text-text">{spread !== null ? fmtPrice(spread) : "n/a"}</span>
                  </span>
                </span>
              </td>
            </tr>
            <Rows rows={bids} max={max} tone="bid" />
          </tbody>
        </table>
      )}

      {data?.source === "fixture" ? (
        <p className="mt-3 text-[12px] text-muted">Saved snapshot. Gemini&apos;s book feed did not respond.</p>
      ) : null}
    </section>
  );
}
