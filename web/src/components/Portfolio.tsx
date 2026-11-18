"use client";

import { useMemo } from "react";
import Link from "next/link";
import type { Hex } from "viem";
import { isMock } from "@/config/contracts";
import { useKnownCombos, useMarketMeta, useOracleQuotes, usePositions, useWallet } from "@/hooks/useChain";
import { useEvents, useLegQuotes } from "@/hooks/useMarketData";
import { comboQuote } from "@/lib/math";
import { demo } from "@/lib/demoStore";
import { isActive, type YesQuote } from "@/lib/positions";
import { ActivityFeed } from "./ActivityFeed";
import { PositionCard } from "./PositionCard";

export function Portfolio() {
  const wallet = useWallet();
  const { positions, loading, needsWallet, closingId, error, close } = usePositions();
  const meta = useMarketMeta();

  const active = useMemo(() => positions.filter((p) => isActive(p.status)).sort((a, b) => Number(b.id - a.id)), [positions]);
  const closed = useMemo(() => positions.filter((p) => !isActive(p.status)).sort((a, b) => Number(b.id - a.id)), [positions]);

  // Latest quotes for markets with an active position: the oracle when live, Gemini otherwise.
  const activeIds = useMemo(() => active.map((p) => p.marketId), [active]);
  const tickers = useMemo(
    () => [...new Set(activeIds.map((id) => meta[id]?.eventTicker).filter((t): t is string => Boolean(t)))],
    [activeIds, meta],
  );
  const events = useEvents(tickers);
  const oracle = useOracleQuotes(activeIds);

  // Records saved before images were kept, or for positions opened elsewhere, have no image;
  // take it from the event data already loaded for quotes.
  const eventImages = useMemo(() => {
    const out = new Map<string, string>();
    for (const q of events) {
      const e = q.data?.event;
      if (e?.imageUrl) out.set(e.ticker, e.imageUrl);
    }
    return out;
  }, [events]);
  const metaFor = (marketId: Hex) => {
    const m = meta[marketId];
    return m && !m.imageUrl && m.eventTicker ? { ...m, imageUrl: eventImages.get(m.eventTicker) ?? null } : m;
  };

  const geminiQuotes = useMemo(() => {
    const out = new Map<string, YesQuote>();
    for (const q of events) {
      for (const c of q.data?.event.contracts ?? []) {
        if (c.yesBid !== null && c.yesAsk !== null) out.set(c.symbol, { yesBid: BigInt(c.yesBid), yesAsk: BigInt(c.yesAsk) });
      }
    }
    return out;
  }, [events]);

  // Combo positions are marked from their legs' books with the product rule.
  const combos = useKnownCombos();
  const comboLegSymbols = useMemo(
    () =>
      activeIds.flatMap((id) => {
        const m = meta[id];
        return m?.kind === "combo" ? (combos[m.symbol]?.legs.map((l) => l.symbol) ?? []) : [];
      }),
    [activeIds, meta, combos],
  );
  const legQuotes = useLegQuotes(comboLegSymbols);

  const comboQuoteFor = (symbol: string): YesQuote | null => {
    const combo = combos[symbol];
    if (!combo) return null;
    const quotes = [];
    for (const l of combo.legs) {
      const q = legQuotes.get(l.symbol);
      if (!q) return null;
      quotes.push({ outcome: l.outcome, ...q });
    }
    const q = comboQuote(quotes);
    return q ? { yesBid: q.bid, yesAsk: q.ask } : null;
  };

  const quoteFor = (marketId: Hex): YesQuote | null => {
    const o = oracle.get(marketId);
    if (o && o.updatedAt > 0n) return { yesBid: o.yesBid, yesAsk: o.yesAsk };
    if (meta[marketId]?.kind === "combo") return comboQuoteFor(meta[marketId].symbol);
    const symbol = meta[marketId]?.symbol;
    return (symbol && geminiQuotes.get(symbol)) || null;
  };

  if (needsWallet) {
    return (
      <div className="card mt-8 max-w-[560px] p-6">
        <h2 className="text-[19px]">Connect a wallet to see positions</h2>
        <p className="mt-2 text-muted">Positions are read from the Vectis margin contract on Arc testnet for the connected address.</p>
        <button
          type="button"
          className="btn btn-primary mt-5"
          onClick={wallet.connect}
          disabled={wallet.connecting || !wallet.hasConnector}
        >
          Connect wallet
        </button>
        {!wallet.hasConnector ? <p className="mt-3 text-[13px] text-muted">No browser wallet was found.</p> : null}
      </div>
    );
  }

  return (
    <>
      {error ? (
        <p className="note appear mt-6 text-danger" role="alert">
          {error}
        </p>
      ) : null}

      <section className="mt-8" aria-labelledby="active-heading">
        <h2 id="active-heading" className="text-[19px]">
          Open and pending positions <span className="num text-muted">{active.length}</span>
        </h2>
        {loading ? (
          <p className="mt-4 text-muted" role="status">
            Loading positions…
          </p>
        ) : active.length === 0 ? (
          <div className="card fade-in mt-4 p-6">
            <p className="text-muted">No open positions. Pick a market to open one.</p>
            <Link href="/markets" className="btn btn-primary mt-4">
              See all markets
            </Link>
          </div>
        ) : (
          <ul className="fade-in m-0 mt-4 grid list-none grid-cols-1 gap-4 p-0 lg:grid-cols-2">
            {active.map((p) => (
              <li key={p.id.toString()} className="min-w-0">
                <PositionCard
                  position={p}
                  meta={metaFor(p.marketId)}
                  quote={quoteFor(p.marketId)}
                  onClose={(id, exit) => void close(id, exit)}
                  closing={closingId === p.id}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {closed.length > 0 ? (
        <section className="mt-12" aria-labelledby="closed-heading">
          <h2 id="closed-heading" className="text-[19px]">
            Closed positions <span className="num text-muted">{closed.length}</span>
          </h2>
          <ul className="m-0 mt-4 grid list-none grid-cols-1 gap-4 p-0 lg:grid-cols-2">
            {closed.map((p) => (
              <li key={p.id.toString()} className="fade-in min-w-0">
                <PositionCard position={p} meta={metaFor(p.marketId)} quote={null} onClose={() => {}} closing={false} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="mt-12">
        <ActivityFeed scope="mine" heading="Your activity" />
      </div>

      {isMock ? (
        <p className="mt-6 text-[13px] text-muted">
          Demo positions are stored in this browser.{" "}
          <button type="button" className="link link-tap cursor-pointer border-0 bg-transparent p-0 font-[inherit]" onClick={() => demo.reset()}>
            Reset demo data
          </button>
        </p>
      ) : null}
    </>
  );
}
