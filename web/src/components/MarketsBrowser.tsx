"use client";

import { useMemo, useState } from "react";
import type { MarketsResponse } from "@/lib/types";
import { useMarkets, useNow } from "@/hooks/useMarketData";
import { ActivityFeed } from "./ActivityFeed";
import { MarketCard } from "./MarketCard";

export function MarketsBrowser({ initial }: { initial: MarketsResponse }) {
  const { data } = useMarkets(initial);
  const now = useNow(30_000);
  const [category, setCategory] = useState("All");
  const [search, setSearch] = useState("");

  const events = useMemo(() => data?.events ?? [], [data]);
  const categories = useMemo(() => ["All", ...[...new Set(events.map((e) => e.category))].sort()], [events]);
  const active = categories.includes(category) ? category : "All";

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return events.filter(
      (e) =>
        (active === "All" || e.category === active) &&
        (q === "" ||
          e.title.toLowerCase().includes(q) ||
          e.ticker.toLowerCase().includes(q) ||
          e.contracts.some((c) => c.label.toLowerCase().includes(q))),
    );
  }, [events, active, search]);

  return (
    <>
      <div className="mt-8 grid gap-4 md:grid-cols-[1fr_280px] md:items-end">
        <div className="min-w-0">
          <span className="label" id="category-label">
            Category
          </span>
          <div className="seg seg-scroll" role="radiogroup" aria-labelledby="category-label">
            {categories.map((c) => (
              <label key={c} className="seg-item">
                <input type="radio" name="category" value={c} checked={active === c} onChange={() => setCategory(c)} />
                {c}
              </label>
            ))}
          </div>
        </div>
        <div>
          <label className="label" htmlFor="market-search">
            Search markets
          </label>
          <input
            id="market-search"
            type="search"
            className="field min-h-[54px]"
            placeholder="Team, asset or ticker"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoComplete="off"
          />
        </div>
      </div>

      {data?.source === "fixture" ? (
        <p className="note mt-4" role="status">
          Gemini&apos;s market feed did not respond, so this list is a saved snapshot. Prices are not live.
        </p>
      ) : null}

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
        <aside className="min-w-0 lg:sticky lg:top-[88px] lg:order-2">
          <ActivityFeed scope="all" heading="Activity" />
        </aside>
        <div className="min-w-0">
          <p className="text-[13px] text-muted" aria-live="polite">
            <span className="num">{shown.length}</span> {shown.length === 1 ? "market" : "markets"}
            {active !== "All" ? ` in ${active}` : ""}
          </p>

          {shown.length > 0 ? (
            <ul className="m-0 mt-3 grid list-none grid-cols-1 gap-4 p-0 sm:grid-cols-2">
              {shown.map((e) => (
                <li key={e.ticker} className="min-w-0">
                  <MarketCard event={e} now={now} />
                </li>
              ))}
            </ul>
          ) : (
            <div className="card mt-3 p-6">
              <h2 className="text-[17px]">No markets match</h2>
              <p className="mt-2 text-muted">Clear the search or pick another category.</p>
              <button
                type="button"
                className="btn btn-secondary mt-4"
                onClick={() => {
                  setSearch("");
                  setCategory("All");
                }}
              >
                Clear filters
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
