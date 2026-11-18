"use client";

import { useMemo } from "react";
import Link from "next/link";
import { isMock } from "@/config/contracts";
import { useCombos, useNow } from "@/hooks/useMarketData";
import { fromDollars, type Combo } from "@/lib/combo";
import { useDemoState } from "@/lib/demoStore";
import { fmtCloseTime, fmtLeverage, fmtPrice } from "@/lib/format";
import { maxLeverage } from "@/lib/math";
import { ComboBuilder } from "./ComboBuilder";

/** "in 1d 3h", "in 42m"; empty once the time has passed. */
export function fmtUntil(unixSeconds: number, now: bigint): string {
  const s = unixSeconds - Number(now);
  if (now === 0n || s <= 0) return "";
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `in ${d}d ${h}h` : h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
}

/** Two legs from one event: their results are linked, so Vectis will not price or trade the combo. */
export const sharesEvent = (c: Combo) => new Set(c.legs.map((l) => l.eventTicker)).size < c.legs.length;

export function ComboCard({ combo, now }: { combo: Combo; now: bigint }) {
  const ask = fromDollars(combo.indicative.ask);
  const lev = ask !== null && ask > 0n ? maxLeverage(ask, now, BigInt(combo.closeTime)) : null;
  const until = fmtUntil(combo.closeTime, now);
  const linked = sharesEvent(combo);
  return (
    <Link href={`/combo/${encodeURIComponent(combo.symbol)}`} className="card card-link flex h-full min-w-0 flex-col p-4 md:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="chip">
          <span className="num">{combo.legs.length}</span> legs
        </span>
        <span className="flex flex-wrap gap-2">
          {linked ? <span className="chip chip-no">Legs share an event</span> : null}
          {combo.origin === "vectis" ? <span className="chip">Built on Vectis</span> : null}
          {combo.requested ? <span className="chip chip-yes">Trading enabled</span> : null}
        </span>
      </div>

      <h3 className="mt-4 text-[17px]">{combo.label}</h3>

      <ul className="m-0 mt-3 grid min-w-0 grid-cols-1 list-none gap-1.5 p-0 text-[13px]">
        {combo.legs.map((l) => (
          <li key={l.symbol} className="flex min-w-0 items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-muted">
              {l.label}
              {l.eventTitle ? <span className="hidden sm:inline"> · {l.eventTitle}</span> : null}
            </span>
            <span className={`shrink-0 ${l.outcome === "yes" ? "text-accent" : "text-danger"}`}>{l.outcome === "yes" ? "Yes" : "No"}</span>
          </li>
        ))}
      </ul>

      <dl className="m-0 mt-auto grid grid-cols-3 gap-3 pt-4 text-[13px]">
        <div>
          <dt className="text-[12px] text-muted">Indicative price</dt>
          <dd className="num m-0 mt-1 text-[15px]">{ask !== null ? fmtPrice(ask) : "n/a"}</dd>
        </div>
        <div>
          <dt className="text-[12px] text-muted">Max leverage</dt>
          <dd className="num m-0 mt-1 text-[15px]">{lev !== null ? fmtLeverage(lev) : "n/a"}</dd>
        </div>
        <div>
          <dt className="text-[12px] text-muted">First leg closes</dt>
          <dd className="num m-0 mt-1">{until || fmtCloseTime(new Date(combo.closeTime * 1000).toISOString())}</dd>
        </div>
      </dl>
    </Link>
  );
}

export function CombosBrowser() {
  const { data, isLoading, isError } = useCombos();
  const demoState = useDemoState();
  const now = useNow(30_000);

  // Requested combos first; in demo mode that means the ones built or opened in this browser.
  const combos = useMemo(() => {
    const server = data?.combos ?? [];
    const local = isMock ? Object.values(demoState.combos).map((c) => ({ ...c, requested: true })) : [];
    const seen = new Set(local.map((c) => c.symbol));
    const rest = server.filter((c) => !seen.has(c.symbol));
    const open = (c: Combo) => now === 0n || c.closeTime > Number(now);
    // Then combos that can be priced now, then the rest; combos Vectis will not trade go last.
    const rank = (c: Combo) => (c.requested ? 0 : sharesEvent(c) ? 3 : c.indicative.ask ? 1 : 2);
    return [...local, ...[...rest].sort((a, b) => rank(a) - rank(b))].filter(open);
  }, [data, demoState.combos, now]);

  return (
    <>
      <ComboBuilder geminiCombos={data?.combos ?? []} />

      <section className="mt-12" aria-labelledby="combo-list-heading">
        <h2 id="combo-list-heading" className="text-[19px]">
          Active combos <span className="num text-muted">{combos.length}</span>
        </h2>
        <p className="mt-2 max-w-[62ch] text-[13px] text-muted">
          Combos listed on Gemini, and combos built here. Prices are calculated from the legs. A price shows
          &quot;n/a&quot; on this list when a leg is outside the markets Vectis has loaded; open the combo to price it
          from the legs&apos; order books.
        </p>

        {data?.source === "fixture" ? (
          <p className="note mt-4" role="status">
            Gemini&apos;s combo feed did not respond, so this list is a saved snapshot.
          </p>
        ) : null}

        {isLoading ? (
          <p className="mt-4 text-muted" role="status">
            Loading combos…
          </p>
        ) : isError && combos.length === 0 ? (
          <p className="note mt-4" role="status">
            The combo list could not be loaded. It retries every 30 seconds.
          </p>
        ) : combos.length === 0 ? (
          <p className="note mt-4">No active combos right now. Build one above.</p>
        ) : (
          <ul className="fade-in m-0 mt-4 grid list-none grid-cols-1 gap-3 p-0 md:grid-cols-2 md:gap-6">
            {combos.map((c) => (
              <li key={c.symbol} className="min-w-0">
                <ComboCard combo={c} now={now} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
