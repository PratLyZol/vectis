"use client";

// The live parts of the landing page. Everything here shows real data: Gemini's feed, the vault
// contract (or the demo store in demo mode), or a protocol rule. A value that is not available
// is left out rather than filled in.
import { useMemo, useState } from "react";
import Link from "next/link";
import { keccak256, toBytes } from "viem";
import { isMock } from "@/config/contracts";
import { useOracleQuotes, useVault } from "@/hooks/useChain";
import { useCombos, useMarkets, useNow } from "@/hooks/useMarketData";
import type { Combo } from "@/lib/combo";
import { fmtUsdc } from "@/lib/format";
import { SIDE_YES, type Side } from "@/lib/math";
import type { MarketEvent, MarketsResponse } from "@/lib/types";
import { ComboCard, sharesEvent } from "./CombosBrowser";
import { MarketCard } from "./MarketCard";
import { TradePanel } from "./TradePanel";

const ORACLE_MAX_AGE = 60n;
const HOUR_MS = 3_600_000;

const quoted = (e: MarketEvent) => {
  const c = e.contracts[0];
  return Boolean(c && c.open && c.yesBid !== null && c.yesAsk !== null);
};

/** A market that shows the panel well: quoted, mid-priced (so leverage is on offer), not closing soon. */
function pickShowcase(events: MarketEvent[]): string | null {
  const live = events.filter(quoted);
  const soon = Date.now() + 2 * HOUR_MS;
  const good = live.find((e) => {
    const c = e.contracts[0];
    const ask = c?.yesAsk ?? 0;
    const expiry = Date.parse(c?.expiry ?? e.expiry ?? "");
    return ask >= 300_000 && ask <= 900_000 && (Number.isNaN(expiry) || expiry > soon);
  });
  return (good ?? live[0])?.ticker ?? null;
}

/** The hero's picture: the real trade panel on a real Gemini market. */
export function HeroPanel({ initial }: { initial: MarketsResponse }) {
  const { data } = useMarkets(initial);
  const events = useMemo(() => data?.events ?? initial.events, [data, initial.events]);
  const now = useNow(10_000);
  const [side, setSide] = useState<Side>(SIDE_YES);
  // Chosen once, so the panel does not jump between markets as prices move.
  const [showcase] = useState(() => pickShowcase(initial.events));

  // When the contracts are live, prefer a market the keeper is pricing on-chain: that one trades.
  const candidates = useMemo(() => events.filter(quoted).slice(0, 12), [events]);
  const ids = useMemo(() => candidates.map((e) => keccak256(toBytes(e.contracts[0]?.symbol ?? ""))), [candidates]);
  const oracle = useOracleQuotes(ids);
  const tracked = candidates.find((_, i) => {
    const id = ids[i];
    const q = id ? oracle.get(id) : undefined;
    return q !== undefined && q.registered && q.updatedAt > 0n && now > 0n && now <= q.updatedAt + ORACLE_MAX_AGE;
  });

  const event = tracked ?? events.find((e) => e.ticker === showcase) ?? initial.events.find((e) => e.ticker === showcase);
  const contract = event?.contracts[0];
  if (!event || !contract) return null;

  return (
    <div className="enter enter-panel" style={{ "--i": 2 } as React.CSSProperties}>
      <TradePanel event={event} contract={contract} side={side} onSideChange={setSide} eagerImage />
      <p className="mt-3 text-[12px] text-muted">
        {(data ?? initial).source === "fixture"
          ? "Saved snapshot: Gemini's feed did not respond. "
          : "This is the live trade panel, on a real Gemini market. "}
        <Link className="link" href={`/market/${encodeURIComponent(event.ticker)}?c=${encodeURIComponent(contract.symbol)}`}>
          Open this market
        </Link>
      </p>
    </div>
  );
}

/** Numbers read from the vault and from Gemini, plus one protocol rule. */
export function LiveNumbers({ initial }: { initial: MarketsResponse }) {
  const vault = useVault();
  const { data } = useMarkets(initial);
  const markets = data ?? initial;

  const tiles: { label: string; value: string; note: string }[] = [];
  if (vault.loaded) {
    const source = isMock ? "Demo vault in this browser" : "Read from the vault contract";
    tiles.push({ label: "Vault deposits", value: `$${fmtUsdc(vault.totalAssets)}`, note: source });
    tiles.push({ label: "Lent to traders", value: `$${fmtUsdc(vault.totalBorrowed)}`, note: source });
  }
  if (markets.source === "gemini" && markets.total > 0) {
    tiles.push({ label: "Active Gemini markets", value: markets.total.toLocaleString("en-US"), note: "From Gemini's public feed" });
  }
  tiles.push({ label: "Maximum leverage", value: "5x", note: "A protocol rule, lower at low prices" });

  return (
    <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-8 rule-y py-8 lg:grid-cols-4">
      {tiles.map((t, i) => (
        <div key={t.label} className="rv min-w-0" style={{ "--i": i } as React.CSSProperties}>
          <dt className="text-[13px] text-muted">{t.label}</dt>
          <dd className="num m-0 mt-2 truncate text-[24px] md:text-[30px]">{t.value}</dd>
          <dd className="m-0 mt-1 text-[12px] text-muted">{t.note}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Three real market cards from the feed. */
export function LandingMarkets({ initial }: { initial: MarketsResponse }) {
  const { data } = useMarkets(initial);
  const now = useNow(30_000);
  const events = (data?.events ?? initial.events).filter(quoted).slice(0, 3);
  if (events.length === 0) return null;
  return (
    <ul className="m-0 grid list-none grid-cols-1 gap-4 p-0 md:grid-cols-3">
      {events.map((e, i) => (
        <li key={e.ticker} className="rv min-w-0" style={{ "--i": i + 1 } as React.CSSProperties}>
          <MarketCard event={e} now={now} />
        </li>
      ))}
    </ul>
  );
}

/** One real combo: a requested one if there is one, else one that can be priced now. */
export function LandingCombo() {
  const { data } = useCombos();
  const now = useNow(30_000);
  const combo = useMemo(() => {
    const open = (data?.combos ?? []).filter((c: Combo) => !sharesEvent(c) && (now === 0n || c.closeTime > Number(now)));
    return open.find((c) => c.requested) ?? open.find((c) => c.indicative.ask) ?? open[0] ?? null;
  }, [data, now]);
  if (!combo) return null;
  return <ComboCard combo={combo} now={now} />;
}
