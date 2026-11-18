"use client";

import Link from "next/link";
import { fmtCents, fmtContracts, fmtLeverage, fmtPercentBps, fmtPrice, fmtSignedUsd, fmtUsdc, shortHash } from "@/lib/format";
import { SIDE_YES, healthBps, netPnl, positionOpenFee, sideBid, unrealisedPnl } from "@/lib/math";
import { STATUS, statusLabel, type MarketMeta, type PositionView, type YesQuote } from "@/lib/positions";
import { MarketHeader } from "./MarketHeader";

export function PositionCard({
  position: p,
  meta,
  quote,
  onClose,
  closing,
}: {
  position: PositionView;
  meta?: MarketMeta;
  quote?: YesQuote | null; // latest YES-space bid and ask for the market
  onClose: (id: bigint, exitPrice: bigint) => void;
  closing: boolean;
}) {
  const isYes = p.side === SIDE_YES;
  const filled = p.status === STATUS.Open || p.status === STATUS.PendingClose;
  const settled = p.status === STATUS.Closed;
  const isCombo = meta?.kind === "combo";
  const mark = quote ? sideBid(p.side, quote.yesBid, quote.yesAsk) : null;

  // Fill of the bar: (current - liquidation) / (entry - liquidation), clamped to 0..1.
  const health = filled && mark !== null ? healthBps(mark, p.entryPrice, p.liqPrice, p.borrowed) : null;
  const pct = health !== null ? Math.min(100, Number(health) / 100) : 0;
  // The open fee is paid on top of margin and is not part of cost or payout, so take it off here.
  const fee = positionOpenFee(p.margin, p.leverage);
  const grossPnl =
    filled && mark !== null
      ? unrealisedPnl(p.contracts, mark, p.cost)
      : settled && p.payout !== undefined && p.settledDebt !== undefined
        ? // The owner's stake is what the fill cost beyond the vault's share, not the posted margin
          // (margin is not reduced when an open fill refunds unused size).
          p.payout - (p.cost - p.settledDebt)
        : null;
  const pnl = grossPnl !== null ? netPnl(grossPnl, p.margin, p.leverage) : null;

  const headingId = `position-${p.id.toString()}`;
  const href = meta
    ? isCombo
      ? `/combo/${encodeURIComponent(meta.symbol)}`
      : `/market/${encodeURIComponent(meta.eventTicker)}?c=${encodeURIComponent(meta.symbol)}`
    : null;
  const outcome = meta ? (isCombo ? meta.title : meta.label) : `Market ${shortHash(p.marketId)}`;

  return (
    <article className="card flex flex-col gap-5 p-4 md:p-6" aria-labelledby={headingId}>
      <MarketHeader
        as="h3"
        headingId={headingId}
        category={isCombo ? "combo" : undefined}
        image={meta?.imageUrl}
        title={
          <>
            {meta ? (isCombo ? "Combo" : meta.title) : "Unnamed market"} · Position <span className="num">#{p.id.toString()}</span>
          </>
        }
        outcome={
          href ? (
            <Link className="link link-tap" href={href}>
              {outcome}
            </Link>
          ) : (
            outcome
          )
        }
        side={isYes ? "yes" : "no"}
        right={
          <>
            {p.status !== STATUS.Open ? (
              <span className={`chip fade-in ${settled && !p.liquidated ? "" : "chip-no"}`}>{statusLabel(p)}</span>
            ) : null}
            <span className="chip chip-outline num h-[30px] text-[13px] font-medium">{fmtLeverage(p.leverage)}</span>
          </>
        }
      />

      <dl className="stats grid-cols-2 sm:grid-cols-4">
        <div className="min-w-0">
          <dt>Size</dt>
          <dd>{p.contracts > 0n ? fmtContracts(p.contracts) : "Pending"}</dd>
        </div>
        <div className="min-w-0">
          <dt>Avg price</dt>
          <dd>{p.entryPrice > 0n ? fmtPrice(p.entryPrice) : p.refPrice ? `~${fmtPrice(p.refPrice)}` : "Pending"}</dd>
        </div>
        <div className="min-w-0">
          <dt>{settled ? "Exit" : "Current"}</dt>
          <dd>
            {settled ? (p.exitPrice !== undefined ? fmtPrice(p.exitPrice) : "n/a") : mark !== null ? fmtPrice(mark) : "n/a"}
          </dd>
        </div>
        <div className="min-w-0">
          <dt>{fee > 0n ? "PnL after fee" : "PnL"}</dt>
          <dd className={pnl === null || pnl === 0n ? "" : pnl > 0n ? "text-accent" : "text-danger"}>
            {pnl !== null ? fmtSignedUsd(pnl) : "n/a"}
          </dd>
        </div>
      </dl>

      {fee > 0n ? (
        <p className="-mt-2 flex items-baseline justify-between gap-4 text-[13px]">
          <span className="text-muted">Open fee paid</span>
          <span className="num text-text-2">${fmtUsdc(fee)}</span>
        </p>
      ) : null}

      {!settled ? (
        <>
          <div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-[13px]">
              <span id={`${headingId}-health`} className="text-muted">
                Distance to liquidation
              </span>
              <span className="text-text-2">
                {p.status === STATUS.PendingOpen ? (
                  "Set when the order fills"
                ) : p.liqPrice > 0n ? (
                  <>
                    Liquidates at <span className="num text-danger">{fmtCents(Number(p.liqPrice))}</span>
                  </>
                ) : (
                  "No liquidation at 1x"
                )}
              </span>
            </div>
            <div
              role="meter"
              aria-labelledby={`${headingId}-health`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(pct)}
              aria-valuetext={health !== null ? fmtPercentBps(health, 0) : "not available"}
              className="bar mt-3"
            >
              <span style={{ transform: `translateX(${(health !== null ? pct : 0) - 100}%)` }} />
            </div>
            {p.status !== STATUS.Open ? (
              <p className="mt-3 text-[12px] text-muted">
                {p.status === STATUS.PendingOpen
                  ? "Waiting for the keeper to record the Gemini fill."
                  : "Waiting for the keeper to sell on Gemini and settle."}
              </p>
            ) : null}
          </div>

          <div className="mt-auto grid grid-cols-2 gap-2">
            {/* The margin contract has no add-margin call in this version. */}
            <button type="button" className="btn btn-secondary btn-48" disabled title="Add margin is not available in this version">
              Add margin<span className="sr-only"> is not available in this version</span>
            </button>
            <button
              type="button"
              className="btn btn-solid btn-48"
              disabled={p.status !== STATUS.Open || closing || mark === null}
              onClick={() => mark !== null && onClose(p.id, mark)}
            >
              {closing ? "Selling…" : "Sell"}
            </button>
          </div>
        </>
      ) : null}
    </article>
  );
}
