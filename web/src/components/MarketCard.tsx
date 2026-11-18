import Link from "next/link";
import type { MarketContract, MarketEvent } from "@/lib/types";
import { fmtCloseTime, fmtCompactUsd, fmtLeverage, unixSeconds } from "@/lib/format";
import { maxLeverage, SIDE_NO, SIDE_YES, sideAsk } from "@/lib/math";
import { IconTile } from "./MarketHeader";

/** Highest leverage either side of a contract allows right now, in tenths; null with no quote. */
export function eventMaxLeverage(event: MarketEvent, now: bigint): bigint | null {
  const lead = event.contracts[0];
  if (!lead || lead.yesBid === null || lead.yesAsk === null) return null;
  const close = unixSeconds(lead.expiry ?? event.expiry);
  const bid = BigInt(lead.yesBid);
  const ask = BigInt(lead.yesAsk);
  const yes = maxLeverage(sideAsk(SIDE_YES, bid, ask), now, close);
  const no = maxLeverage(sideAsk(SIDE_NO, bid, ask), now, close);
  return yes > no ? yes : no;
}

/** The market's implied chance of Yes, from the price to buy it (or the last trade). */
function percent(c: MarketContract): string {
  const p = c.yesAsk ?? c.last ?? c.yesBid;
  return p === null ? "n/a" : `${Math.round(p / 10_000)}%`;
}

export function MarketCard({ event, now }: { event: MarketEvent; now: bigint }) {
  const lev = eventMaxLeverage(event, now);
  const outcomes = event.contracts.slice(0, 2);
  const base = `/market/${encodeURIComponent(event.ticker)}`;
  const tradeHref = (c: MarketContract, side: "yes" | "no") => `${base}?c=${encodeURIComponent(c.symbol)}&side=${side}`;

  return (
    <article className="card card-link relative flex h-full min-w-0 flex-col gap-[14px] p-[18px]">
      <div className="flex items-start gap-3">
        <IconTile category={event.category} image={event.imageUrl} small />
        <div className="min-w-0 flex-1">
          <h2 className="line-clamp-2 text-[16px] leading-snug">
            {/* The title link covers the card; the Yes and No links sit above it. */}
            <Link href={base} className="stretch text-text no-underline">
              {event.title}
            </Link>
          </h2>
          <p className="mt-1 truncate text-[12px] text-muted">
            {event.category} · Closes <span className="num">{fmtCloseTime(event.expiry)}</span>
          </p>
        </div>
      </div>

      {outcomes.length === 0 ? (
        <p className="text-[14px] text-muted">Gemini lists no contracts for this market.</p>
      ) : (
        <ul className="m-0 grid list-none grid-cols-1 gap-2 p-0">
          {outcomes.map((c) => (
            <li key={c.symbol} className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[14px] text-text-2">{c.label}</span>
              <span className="figure w-[46px] text-right text-[16px]">{percent(c)}</span>
              <Link
                href={tradeHref(c, "yes")}
                className="btn btn-yes-tint relative z-[1] w-14 px-0 text-[14px]"
                aria-label={`Buy Yes on ${c.label}`}
              >
                Yes
              </Link>
              <Link
                href={tradeHref(c, "no")}
                className="btn btn-no-tint relative z-[1] w-14 px-0 text-[14px]"
                aria-label={`Buy No on ${c.label}`}
              >
                No
              </Link>
            </li>
          ))}
        </ul>
      )}

      <p className="num mt-auto flex items-center justify-between gap-3 pt-1 text-[12px]">
        <span className="text-muted">{fmtCompactUsd(event.volume)} Vol.</span>
        <span className={lev !== null ? "text-accent" : "text-muted"}>{lev !== null ? `Up to ${fmtLeverage(lev)}` : "No quote"}</span>
      </p>
    </article>
  );
}
