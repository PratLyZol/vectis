"use client";

import { useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import { keccak256, toBytes } from "viem";
import { isMock } from "@/config/contracts";
import { saveMarketMeta, useOpenPosition, useOracleQuotes, useSpendableUsdc, useVault, useWallet } from "@/hooks/useChain";
import { useNow } from "@/hooks/useMarketData";
import type { MarketMeta } from "@/lib/positions";
import type { MarketContract, MarketEvent } from "@/lib/types";
import { fmtCents, fmtContracts, fmtLeverage, fmtPrice, fmtUnits6, fmtUsdc, parseUsdc, unixSeconds } from "@/lib/format";
import {
  LEVERAGE_UNIT,
  MIN_MARGIN,
  ONE,
  SIDE_NO,
  SIDE_YES,
  maxLeverage,
  previewOpen,
  sideAsk,
  type Side,
} from "@/lib/math";
import { MarketHeader } from "./MarketHeader";

const ORACLE_MAX_AGE = 60n;
const QUICK_ADD = [10, 50, 100];
const LEVERAGE_STEPS = [10, 15, 20, 30]; // tenths; the current max is added to these

const Chevron = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <path d="m3 4.5 3 3 3-3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function TradePanel({
  event,
  contract,
  side,
  onSideChange,
  yesOnly = false,
  meta,
  waitingNote,
  noQuoteNote,
  onSubmit,
  eagerImage,
}: {
  event: MarketEvent;
  contract: MarketContract;
  side: Side;
  onSideChange: (s: Side) => void;
  yesOnly?: boolean; // a combo: there is only the Yes side
  meta?: MarketMeta; // how to name this market on the portfolio; defaults to the event and contract
  waitingNote?: string; // shown instead of the default while there is no fresh on-chain price
  noQuoteNote?: string; // shown instead of the default when there is no offer to price from
  onSubmit?: () => void; // runs just before the position is opened
  eagerImage?: boolean; // load the market image at once (the landing hero)
}) {
  const uid = useId();
  const wallet = useWallet();
  const balance = useSpendableUsdc();
  const vault = useVault();
  const trade = useOpenPosition();
  const now = useNow(5_000);

  const [marginInput, setMarginInput] = useState("100");
  const [leverage, setLeverage] = useState(20); // tenths
  const [tab, setTab] = useState<"buy" | "sell">("buy");

  const marketId = useMemo(() => keccak256(toBytes(contract.symbol)), [contract.symbol]);
  const marketIds = useMemo(() => [marketId], [marketId]);
  const oracle = useOracleQuotes(marketIds).get(marketId);

  // A new contract starts a new ticket.
  const { reset } = trade;
  useEffect(() => {
    reset();
  }, [contract.symbol, reset]);

  // Price source: the oracle when live and fresh (that is what the contract will use), otherwise
  // Gemini's quote, which is only indicative in live mode.
  const oracleFresh =
    !isMock && oracle !== undefined && oracle.registered && oracle.updatedAt > 0n && now > 0n
      ? now <= oracle.updatedAt + ORACLE_MAX_AGE
      : false;
  const yesBid = oracleFresh && oracle ? oracle.yesBid : contract.yesBid !== null ? BigInt(contract.yesBid) : null;
  const yesAsk = oracleFresh && oracle ? oracle.yesAsk : contract.yesAsk !== null ? BigInt(contract.yesAsk) : null;

  const askFor = (s: Side): bigint | null => {
    const p = s === SIDE_YES ? yesAsk : yesBid !== null ? sideAsk(SIDE_NO, yesBid, 0n) : null;
    return p !== null && p > 0n && p < ONE ? p : null;
  };
  const price = askFor(side);

  const closeTime = oracle && oracle.closeTime > 0n ? oracle.closeTime : unixSeconds(contract.expiry ?? event.expiry);
  const closed = now > 0n && closeTime > 0n && now >= closeTime;
  const maxLev = price !== null ? Number(maxLeverage(price, now, closeTime)) : Number(LEVERAGE_UNIT);
  const lev = Math.min(leverage, maxLev);

  const margin = parseUsdc(marginInput);
  const preview = price !== null && margin !== null ? previewOpen(margin, BigInt(lev), price) : null;

  // Why the market cannot be traded at all, if it cannot.
  let blocked: string | null = null;
  if (closed || !contract.open) blocked = "This market has closed.";
  else if (!isMock && !oracleFresh)
    blocked =
      waitingNote ??
      "The Vectis keeper is not tracking this market, so it has no fresh on-chain price. Positions cannot be opened here yet.";
  else if (price === null)
    blocked = noQuoteNote ?? `Gemini has no ${side === SIDE_YES ? "Yes" : "No"} offer for this contract right now.`;

  // What is wrong with the ticket, if anything.
  let problem: string | null = null;
  if (margin === null) problem = "Enter a margin amount in USDC.";
  else if (margin < MIN_MARGIN) problem = "The minimum margin is 1 USDC.";
  else if (balance !== undefined && preview && preview.total > balance)
    problem =
      preview.fee > 0n
        ? "Margin plus the " + fmtUsdc(preview.fee) + " USDC open fee is more than your USDC balance."
        : "Margin is more than your USDC balance.";
  else if (balance !== undefined && margin > balance) problem = "Margin is more than your USDC balance.";
  else if (preview && vault.loaded && preview.borrowed > vault.available)
    problem = `The vault has ${fmtUsdc(vault.available)} USDC to lend. Lower the margin or the leverage.`;

  const busy = trade.phase === "approving" || trade.phase === "opening";
  const needsWallet = !isMock && !wallet.connected;
  const needsChain = !isMock && wallet.connected && wallet.wrongChain;

  const submit = () => {
    if (!preview || price === null || margin === null) return;
    onSubmit?.();
    saveMarketMeta(
      marketId,
      meta ?? {
        symbol: contract.symbol,
        eventTicker: event.ticker,
        title: event.title,
        label: contract.label,
        expiry: contract.expiry ?? event.expiry,
        imageUrl: event.imageUrl,
      },
    );
    void trade.open({ marketId, side, margin, leverage: BigInt(lev), refPrice: price, fee: preview.fee });
  };

  const yesPrice = askFor(SIDE_YES);
  const noPrice = askFor(SIDE_NO);
  const tracked = trade.position;
  const isYes = side === SIDE_YES;
  const sideName = isYes ? "Yes" : "No";

  // Never offer a chip above the current max; the selected value is already clamped to it.
  const leverageChips = [...new Set([...LEVERAGE_STEPS.filter((l) => l < maxLev), maxLev])];

  const addMargin = (dollars: number) => {
    const next = (margin ?? 0n) + BigInt(dollars) * ONE;
    setMarginInput(fmtUnits6(next, 6).replace(/,/g, "").replace(/\.?0+$/, ""));
  };

  const message =
    blocked ?? (needsWallet && !wallet.hasConnector ? "No browser wallet was found." : needsWallet || needsChain ? null : problem);

  return (
    <section className="card flex flex-col gap-[18px] p-4 md:p-6" aria-labelledby={`${uid}-h`}>
      <MarketHeader
        title={event.title}
        outcome={contract.label}
        side={isYes ? "yes" : "no"}
        category={yesOnly ? "combo" : event.category}
        image={event.imageUrl}
        eagerImage={eagerImage}
        headingId={`${uid}-h`}
      />

      <div className="flex items-center justify-between border-b border-border">
        <div role="tablist" aria-label="Order side" className="flex gap-5">
          <button
            type="button"
            role="tab"
            id={`${uid}-tab-buy`}
            aria-selected={tab === "buy"}
            aria-controls={`${uid}-panel`}
            className="tab"
            onClick={() => setTab("buy")}
          >
            Buy
          </button>
          <button
            type="button"
            role="tab"
            id={`${uid}-tab-sell`}
            aria-selected={tab === "sell"}
            aria-controls={`${uid}-panel`}
            className="tab"
            onClick={() => setTab("sell")}
          >
            Sell
          </button>
        </div>
        {/* Every fill is at the market, so this is a label, not a control. */}
        <span className="flex items-center gap-1.5 text-[14px] font-medium text-text-2">
          Market <Chevron />
        </span>
      </div>

      {tab === "sell" ? (
        <div role="tabpanel" id={`${uid}-panel`} aria-labelledby={`${uid}-tab-sell`} className="note">
          Selling closes a position you hold.{" "}
          <Link className="link" href="/portfolio">
            Sell an open position from your portfolio
          </Link>
        </div>
      ) : (
        <div role="tabpanel" id={`${uid}-panel`} aria-labelledby={`${uid}-tab-buy`} className="flex flex-col gap-[18px]">
          <div className="grid grid-cols-2 gap-2" role="group" aria-label="Outcome">
            <button
              type="button"
              className={`btn btn-lg ${isYes ? "btn-primary" : "btn-secondary"}`}
              aria-pressed={isYes}
              onClick={() => onSideChange(SIDE_YES)}
            >
              <span className="font-medium">Yes</span>
              <span className="figure">{yesPrice !== null ? fmtCents(Number(yesPrice)) : "n/a"}</span>
            </button>
            <button
              type="button"
              className={`btn btn-lg ${!isYes ? "btn-danger" : "btn-secondary"}`}
              aria-pressed={!isYes}
              disabled={yesOnly}
              onClick={() => onSideChange(SIDE_NO)}
              title={yesOnly ? "A combo has only a Yes side: it pays out if every leg hits." : undefined}
            >
              <span className="font-medium">No</span>
              {yesOnly ? null : <span className="figure">{noPrice !== null ? fmtCents(Number(noPrice)) : "n/a"}</span>}
            </button>
          </div>
          {yesOnly ? (
            <p className="-mt-2 text-[12px] text-muted">A combo has one side. It pays out only if every leg resolves as required.</p>
          ) : null}

          <div>
            <div className="flex items-center justify-between gap-4">
              <label className="text-[16px] font-medium" htmlFor={`${uid}-margin`}>
                Margin
              </label>
              <div className="flex min-w-0 items-baseline justify-end gap-1">
                <span className="figure text-[40px] text-muted" aria-hidden="true">
                  $
                </span>
                <input
                  id={`${uid}-margin`}
                  className="amount"
                  style={{ width: `${Math.max(1, marginInput.length)}ch` }}
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0"
                  value={marginInput}
                  onChange={(e) => setMarginInput(e.target.value)}
                  aria-describedby={`${uid}-msg`}
                  aria-invalid={margin === null && marginInput !== "" ? true : undefined}
                />
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-[12px] text-muted">
                {isMock ? "Demo balance" : "Balance"}{" "}
                <span className="num text-text-2">{balance === undefined ? "n/a" : `$${fmtUsdc(balance)}`}</span>
              </p>
              <div className="flex gap-2">
                {QUICK_ADD.map((d) => (
                  <button
                    key={d}
                    type="button"
                    className="btn btn-secondary px-3 text-[13px] font-medium"
                    onClick={() => addMargin(d)}
                  >
                    +${d}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div>
            <div className="flex items-baseline justify-between gap-3">
              <span id={`${uid}-lev`} className="text-[16px] font-medium">
                Leverage
              </span>
              <span className="text-[12px] text-muted">
                {maxLev <= 10 ? (
                  "Only 1x at this price or this close to the close"
                ) : (
                  <>
                    Max <span className="num">{fmtLeverage(maxLev)}</span> at this price
                  </>
                )}
              </span>
            </div>
            <div
              className="mt-2 grid gap-2"
              style={{ gridTemplateColumns: `repeat(${leverageChips.length}, minmax(0, 1fr))` }}
              role="group"
              aria-labelledby={`${uid}-lev`}
            >
              {leverageChips.map((l) => (
                <button
                  key={l}
                  type="button"
                  className={`btn num px-0 font-medium ${lev === l ? "btn-solid" : "btn-outline"}`}
                  aria-pressed={lev === l}
                  onClick={() => setLeverage(l)}
                >
                  {fmtLeverage(l)}
                </button>
              ))}
            </div>
          </div>

          <dl className="rows">
            <div>
              <dt>Position size</dt>
              <dd className="num">
                {preview ? `$${fmtUsdc(preview.size)} · ${fmtContracts(preview.contracts)} contracts` : "n/a"}
              </dd>
            </div>
            <div>
              <dt>Borrowed from vault</dt>
              <dd className="num">{preview ? `$${fmtUsdc(preview.borrowed)}` : "n/a"}</dd>
            </div>
            <div>
              <dt>
                Open fee <span className="text-[12px]">(1% of borrowed, paid to lenders)</span>
              </dt>
              <dd className="num">{preview ? (preview.fee === 0n ? "None" : "$" + fmtUsdc(preview.fee)) : "n/a"}</dd>
            </div>
            <div>
              <dt>You pay now</dt>
              <dd className="num">{preview ? "$" + fmtUsdc(preview.total) : "n/a"}</dd>
            </div>
            <div>
              <dt>Liquidation price</dt>
              <dd className={`num ${preview && preview.liqPrice > 0n ? "text-danger" : ""}`}>
                {preview ? (preview.liqPrice === 0n ? "None" : fmtPrice(preview.liqPrice)) : "n/a"}
              </dd>
            </div>
          </dl>

          <div className="flex items-baseline justify-between gap-4">
            <span className="font-medium">To win</span>
            <span className="figure text-[24px] text-accent">{preview ? `$${fmtUsdc(preview.payoutIfWin)}` : "n/a"}</span>
          </div>

          <div>
            {blocked ? (
              <button type="button" className="btn btn-primary btn-lg btn-block" disabled>
                Buy {sideName} at {fmtLeverage(lev)}
              </button>
            ) : needsWallet ? (
              <button
                type="button"
                className="btn btn-primary btn-lg btn-block"
                onClick={wallet.connect}
                disabled={wallet.connecting || !wallet.hasConnector}
              >
                Connect wallet
              </button>
            ) : needsChain ? (
              <button type="button" className="btn btn-primary btn-lg btn-block" onClick={wallet.switchToArc} disabled={wallet.switching}>
                Switch to Arc Testnet
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary btn-lg btn-block"
                onClick={submit}
                disabled={busy || problem !== null || !preview}
              >
                {trade.phase === "approving"
                  ? "Approving USDC…"
                  : trade.phase === "opening"
                    ? "Opening position…"
                    : `Buy ${sideName} at ${fmtLeverage(lev)}`}
              </button>
            )}
            <p id={`${uid}-msg`} className="mt-3 min-h-[20px] text-[13px] text-muted" aria-live="polite">
              {message}
            </p>
          </div>

          {trade.phase === "error" && trade.error ? (
            <p className="note appear text-danger" role="alert">
              {trade.error}
            </p>
          ) : null}

          {tracked ? (
            <div className="note appear" role="status">
              {trade.phase === "pending" ? (
                <p>
                  <span className="chip chip-no mr-2">Pending open</span>
                  Position <span className="num text-text">#{tracked.id.toString()}</span> is waiting for the keeper to
                  record the Gemini fill.
                </p>
              ) : (
                <p>
                  <span className="chip chip-yes mr-2">Open</span>
                  Position <span className="num text-text">#{tracked.id.toString()}</span> filled:{" "}
                  <span className="num text-text">{fmtContracts(tracked.contracts)}</span> contracts at{" "}
                  <span className="num text-text">{fmtPrice(tracked.entryPrice)}</span>.{" "}
                  <Link className="link" href="/portfolio">
                    See it in your portfolio
                  </Link>
                </p>
              )}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
