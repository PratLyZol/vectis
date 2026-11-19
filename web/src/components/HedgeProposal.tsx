"use client";

import { useId, useMemo, useState } from "react";
import Link from "next/link";
import { keccak256, toBytes, type Hex } from "viem";
import { isMock } from "@/config/contracts";
import { useOpenBatch, useOracleQuotes, useSpendableUsdc, useVault, useWallet, type BatchItem, type OracleQuote } from "@/hooks/useChain";
import { useEvents, useNow } from "@/hooks/useMarketData";
import { fmtCloseTime, fmtContracts, fmtLeverage, fmtPrice, fmtSignedUsd, fmtUsdc, fmtUnits6, parseUsdc, unixSeconds } from "@/lib/format";
import { legPreview, proposalTotals, scenarioPnl, sideOf } from "@/lib/hedge/validate";
import { LEVERAGE_UNIT, MIN_MARGIN, ONE, SIDE_NO, SIDE_YES, maxLeverage, sideAsk } from "@/lib/math";
import type { HedgeLeg, HedgeProposal as Proposal, MarketContract } from "@/lib/types";
import { MarketHeader } from "./MarketHeader";

const ORACLE_MAX_AGE = 60n;
const LEVERAGE_STEPS = [10, 15, 20, 30, 40]; // tenths; the current max is added to these
const MAX_MOVE = 30_000n; // $0.03: a price move that needs a fresh confirmation

const HOLDER: Record<string, string> = {
  individual: "Individual",
  small_business: "Small business",
  fund: "Fund",
  firm: "Firm",
  other: "Holder",
};
const CLASS: Record<string, string> = {
  equity: "Equity",
  crypto: "Crypto",
  commodity: "Commodity",
  rates_or_loan: "Rates / loan",
  fx: "FX",
  real_asset: "Real asset",
  operating_cost: "Operating cost",
  revenue: "Revenue",
  event: "Event",
  other: "Other",
};

type Live = {
  leg: HedgeLeg; // with live price and max leverage, leverage clamped to it
  marketId: Hex;
  blocked: string | null; // why this leg cannot be opened right now
};

/** Live price and limits for a leg: the fresh oracle price when live, otherwise Gemini's quote. */
function liveLeg(leg: HedgeLeg, contract: MarketContract | undefined, oracle: OracleQuote | undefined, now: bigint): Live {
  const marketId = keccak256(toBytes(leg.symbol));
  const oracleFresh =
    !isMock && oracle !== undefined && oracle.registered && oracle.updatedAt > 0n && now > 0n && now <= oracle.updatedAt + ORACLE_MAX_AGE;
  const yesBid = oracleFresh ? oracle!.yesBid : contract?.yesBid != null ? BigInt(contract.yesBid) : null;
  const yesAsk = oracleFresh ? oracle!.yesAsk : contract?.yesAsk != null ? BigInt(contract.yesAsk) : null;
  const s = sideOf(leg.side);
  const raw = s === SIDE_YES ? yesAsk : yesBid !== null ? sideAsk(SIDE_NO, yesBid, 0n) : null;
  const price = raw !== null && raw > 0n && raw < ONE ? raw : null;
  const closeTime = oracle && oracle.closeTime > 0n ? oracle.closeTime : unixSeconds(leg.expiry);
  const closed = (contract && !contract.open) || (now > 0n && closeTime > 0n && now >= closeTime);
  const max = price !== null ? maxLeverage(price, now, closeTime) : LEVERAGE_UNIT;
  const leverage = Math.min(leg.leverage, Number(max));

  let blocked: string | null = null;
  if (closed) blocked = "This market has closed.";
  else if (!isMock && !oracleFresh) blocked = "The Vectis keeper is not pricing this market on-chain yet, so it cannot be opened.";
  else if (price === null) blocked = `No ${leg.side === "yes" ? "Yes" : "No"} offer right now.`;

  return {
    leg: { ...leg, price: price !== null ? Number(price) : leg.price, maxLeverage: Number(max), leverage },
    marketId,
    blocked,
  };
}

export function HedgeProposal({
  proposal,
  onChange,
  locked,
}: {
  proposal: Proposal;
  onChange: (p: Proposal) => void;
  locked: boolean; // the agent is working on a new version
}) {
  const uid = useId();
  const now = useNow(5_000);
  const wallet = useWallet();
  const balance = useSpendableUsdc();
  const vault = useVault();
  const batch = useOpenBatch();

  const tickers = useMemo(() => [...new Set(proposal.legs.map((l) => l.eventTicker))], [proposal.legs]);
  const eventQueries = useEvents(tickers);
  const contracts = new Map<string, MarketContract>();
  for (const q of eventQueries) for (const c of q.data?.event.contracts ?? []) contracts.set(c.symbol, c);
  const marketIds = useMemo(() => proposal.legs.map((l) => keccak256(toBytes(l.symbol))), [proposal.legs]);
  const oracle = useOracleQuotes(marketIds);

  const live = proposal.legs.map((l, i) => liveLeg(l, contracts.get(l.symbol), oracle.get(marketIds[i]!), now));
  const legs = live.map((x) => x.leg);
  const tradeable = live.filter((x) => x.blocked === null);
  const totals = proposalTotals(tradeable.map((x) => x.leg));

  const [review, setReview] = useState<{ prices: number[]; maxes: number[] } | null>(null);
  const [ack, setAck] = useState(false);
  const [moved, setMoved] = useState(false);
  const [ran, setRan] = useState<string[]>([]); // leg keys in the order they were sent to the batch

  const running = batch.phase === "approving" || batch.phase === "opening";
  const started = batch.phase !== "idle";
  const editable = !locked && !started && review === null;

  const update = (i: number, patch: Partial<HedgeLeg>) =>
    onChange({ ...proposal, legs: proposal.legs.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const remove = (i: number) => onChange({ ...proposal, legs: proposal.legs.filter((_, j) => j !== i) });

  let problem: string | null = null;
  if (tradeable.length === 0) problem = proposal.legs.length ? "None of the legs can be opened right now." : null;
  else if (balance !== undefined && totals.total > balance) problem = `The hedge costs $${fmtUsdc(totals.total)}, more than your USDC balance.`;
  else if (vault.loaded && totals.borrowed > vault.available)
    problem = `The vault has $${fmtUsdc(vault.available)} to lend. Lower the leverage.`;

  const needsWallet = !isMock && !wallet.connected;
  const needsChain = !isMock && wallet.connected && wallet.wrongChain;

  const openReview = () => {
    setReview({ prices: tradeable.map((x) => x.leg.price), maxes: tradeable.map((x) => x.leg.maxLeverage) });
    setAck(false);
    setMoved(false);
  };

  const confirm = () => {
    if (!review) return;
    // Prices can move while the review is open. A move of more than 3 cents, or a lower leverage
    // limit, means the figures the user agreed to are stale: show the new ones and ask again.
    const changed =
      review.prices.length !== tradeable.length ||
      tradeable.some((x, i) => {
        const was = BigInt(review.prices[i] ?? 0);
        const diff = BigInt(x.leg.price) - was;
        return (diff < 0n ? -diff : diff) > MAX_MOVE || x.leg.maxLeverage < (review.maxes[i] ?? 0);
      });
    if (changed) {
      openReview();
      setMoved(true);
      return;
    }
    const items: BatchItem[] = tradeable.map(({ leg, marketId }) => {
      const p = legPreview(leg);
      return {
        args: { marketId, side: sideOf(leg.side), margin: BigInt(leg.margin), leverage: BigInt(leg.leverage), refPrice: BigInt(leg.price), fee: p.fee },
        meta: { symbol: leg.symbol, eventTicker: leg.eventTicker, title: leg.eventTitle, label: leg.label, expiry: leg.expiry, imageUrl: leg.imageUrl },
      };
    });
    setRan(tradeable.map(({ leg }) => `${leg.symbol}:${leg.side}`));
    void batch.run(items);
  };

  const { exposure } = proposal;

  return (
    <section className="flex flex-col gap-5" aria-labelledby={`${uid}-h`}>
      <div className="card flex flex-col gap-3 p-4 md:p-6">
        <h2 id={`${uid}-h`} className="text-[20px]">
          Proposed hedge
        </h2>
        <p className="text-text-2">{proposal.summary}</p>
        <dl className="rows">
          <div>
            <dt>Exposure</dt>
            <dd>
              {HOLDER[exposure.holderType]} · {CLASS[exposure.instrumentClass]} · {exposure.direction}
              {exposure.notionalUsd ? ` · $${exposure.notionalUsd.toLocaleString("en-US")}` : ""}
            </dd>
          </div>
          {exposure.description ? (
            <div>
              <dt>What you hold</dt>
              <dd>{exposure.description}</dd>
            </div>
          ) : null}
          <div>
            <dt>Hedging against</dt>
            <dd>{exposure.adverseMove || "n/a"}</dd>
          </div>
          {proposal.horizonNote ? (
            <div>
              <dt>Horizon</dt>
              <dd>{proposal.horizonNote}</dd>
            </div>
          ) : null}
        </dl>
        <p className="text-[12px] text-muted">
          If the agent misread your exposure, say so in the box above and it will revise the hedge.
          {proposal.source === "fixture" ? " Gemini was unreachable, so these markets come from a saved snapshot." : ""}
        </p>
        {proposal.warnings.length ? (
          <ul className="note flex list-disc flex-col gap-1 pl-8" aria-label="Warnings">
            {proposal.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        ) : null}
      </div>

      {live.map((x, i) => (
        <LegCard
          key={`${x.leg.symbol}-${i}`}
          live={x}
          editable={editable}
          status={batch.legs[ran.indexOf(`${x.leg.symbol}:${x.leg.side}`)]}
          onSide={(side) => update(i, { side })}
          onMargin={(margin) => update(i, { margin })}
          onLeverage={(leverage) => update(i, { leverage })}
          onRemove={() => remove(i)}
        />
      ))}

      {legs.length ? (
        <div className="card flex flex-col gap-4 p-4 md:p-6">
          <h3 className="text-[18px]">If held to resolution</h3>
          {proposal.scenarios.length ? (
            <dl className="rows">
              {proposal.scenarios.map((s, i) => (
                <div key={i}>
                  <dt>
                    <span className="font-medium text-text">{s.name}</span>
                    {s.description ? <span className="block text-[12px]">{s.description}</span> : null}
                  </dt>
                  <dd className="num">{fmtSignedUsd(scenarioPnl(tradeable.map((t) => t.leg), s))}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          <dl className="rows">
            <div>
              <dt>Total cost (margin + fees)</dt>
              <dd className="num">${fmtUsdc(totals.total)}</dd>
            </div>
            <div>
              <dt>Borrowed from vault</dt>
              <dd className="num">${fmtUsdc(totals.borrowed)}</dd>
            </div>
            <div>
              <dt>Most you can lose</dt>
              <dd className="num text-danger">${fmtUsdc(totals.maxLoss)}</dd>
            </div>
            <div>
              <dt>Payout if every leg wins</dt>
              <dd className="num">${fmtUsdc(totals.payoutIfAllWin)}</dd>
            </div>
          </dl>
          <p className="text-[12px] text-muted">
            Leveraged legs can be liquidated before resolution if their price falls to the liquidation price, which ends the hedge
            early.
          </p>

          {review === null && !started ? (
            needsWallet ? (
              <button type="button" className="btn btn-primary btn-lg btn-block" onClick={wallet.connect} disabled={wallet.connecting || !wallet.hasConnector}>
                Connect wallet
              </button>
            ) : needsChain ? (
              <button type="button" className="btn btn-primary btn-lg btn-block" onClick={wallet.switchToArc} disabled={wallet.switching}>
                Switch to Arc Testnet
              </button>
            ) : (
              <>
                <button type="button" className="btn btn-primary btn-lg btn-block" disabled={locked || problem !== null || tradeable.length === 0} onClick={openReview}>
                  Review {tradeable.length} position{tradeable.length === 1 ? "" : "s"}
                </button>
                {problem ? <p className="text-[13px] text-muted">{problem}</p> : null}
              </>
            )
          ) : null}

          {review !== null && !started ? (
            <div className="note appear flex flex-col gap-3" role="region" aria-label="Confirm hedge">
              <p className="font-medium text-text">Confirm these positions</p>
              {moved ? (
                <p className="text-danger" role="alert">
                  Prices moved since you opened the review. Check the updated figures and confirm again.
                </p>
              ) : null}
              <ol className="flex list-decimal flex-col gap-1 pl-5">
                {tradeable.map(({ leg }) => {
                  const p = legPreview(leg);
                  return (
                    <li key={`${leg.symbol}-${leg.side}`}>
                      {leg.side === "yes" ? "Yes" : "No"} on {leg.eventTitle}: {leg.label} at {fmtPrice(leg.price)}, ${fmtUsdc(BigInt(leg.margin))} margin at{" "}
                      {fmtLeverage(leg.leverage)}, fee ${fmtUsdc(p.fee)}
                      {p.liqPrice > 0n ? `, liquidation at ${fmtPrice(p.liqPrice)}` : ""}
                    </li>
                  );
                })}
              </ol>
              <p>
                Total <span className="num text-text">${fmtUsdc(totals.total)}</span>
                {balance !== undefined ? (
                  <>
                    {" "}
                    of your <span className="num">${fmtUsdc(balance)}</span> balance
                  </>
                ) : null}
                .{" "}
                {isMock
                  ? "Demo mode: the positions use demo USDC."
                  : `Your wallet will ask for one USDC approval if needed, then ${tradeable.length} transaction${tradeable.length === 1 ? "" : "s"}.`}
              </p>
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-1" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                <span>I understand these positions may not offset my exposure and I can lose the full ${fmtUsdc(totals.maxLoss)}.</span>
              </label>
              <div className="flex flex-wrap gap-3">
                <button type="button" className="btn btn-primary" disabled={!ack || problem !== null} onClick={confirm}>
                  Open {tradeable.length} position{tradeable.length === 1 ? "" : "s"}
                </button>
                <button type="button" className="btn btn-outline" onClick={() => setReview(null)}>
                  Back to editing
                </button>
              </div>
            </div>
          ) : null}

          {started ? (
            <div className="note appear flex flex-col gap-2" role="status" aria-live="polite">
              {batch.phase === "approving" ? <p>Approving USDC…</p> : null}
              {batch.phase === "opening" ? (
                <p>
                  Opening positions: {batch.legs.filter((l) => l.status === "opened").length} of {batch.legs.length} done.
                </p>
              ) : null}
              {batch.phase === "done" ? (
                <p>
                  {batch.filled ? "Every position is open and filled." : "Every position is open; waiting for the keeper to record the fills."}{" "}
                  <Link className="link" href="/portfolio">
                    See them in your portfolio
                  </Link>
                </p>
              ) : null}
              {batch.phase === "error" ? (
                <>
                  <p className="text-danger" role="alert">
                    {batch.error ?? batch.legs.find((l) => l.status === "failed")?.error ?? "Opening stopped."}
                  </p>
                  <div className="flex flex-wrap gap-3">
                    <button type="button" className="btn btn-primary" disabled={running} onClick={() => void batch.retryRemaining()}>
                      Retry remaining
                    </button>
                    {batch.legs.some((l) => l.status === "opened") ? (
                      <Link className="btn btn-outline" href="/portfolio">
                        Portfolio
                      </Link>
                    ) : null}
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function LegCard({
  live,
  editable,
  status,
  onSide,
  onMargin,
  onLeverage,
  onRemove,
}: {
  live: Live;
  editable: boolean;
  status?: { status: string; positionId?: bigint; error?: string };
  onSide: (s: HedgeLeg["side"]) => void;
  onMargin: (m: number) => void;
  onLeverage: (l: number) => void;
  onRemove: () => void;
}) {
  const uid = useId();
  const { leg, blocked } = live;
  const [marginInput, setMarginInput] = useState(() => fmtUnits6(BigInt(leg.margin), 6).replace(/,/g, "").replace(/\.?0+$/, ""));
  const preview = legPreview(leg);
  const chips = [...new Set([...LEVERAGE_STEPS.filter((l) => l < leg.maxLeverage), leg.maxLeverage])];
  const marginValue = parseUsdc(marginInput);
  const marginProblem = marginValue === null ? "Enter a USDC amount." : marginValue < MIN_MARGIN ? "The minimum margin is 1 USDC." : null;

  return (
    <article className={`card flex flex-col gap-4 p-4 md:p-6 ${blocked ? "opacity-70" : ""}`} aria-labelledby={`${uid}-h`}>
      <MarketHeader
        as="h3"
        headingId={`${uid}-h`}
        title={leg.eventTitle}
        outcome={leg.label}
        side={leg.side}
        category={leg.category}
        image={leg.imageUrl}
        right={
          <span className={`chip ${leg.basisRisk === "direct" ? "chip-yes" : "chip-outline"}`}>{leg.basisRisk === "direct" ? "Direct" : "Proxy"}</span>
        }
      />
      <div className="flex flex-col gap-1 text-[14px] text-text-2">
        {leg.rationale ? <p>{leg.rationale}</p> : null}
        {leg.hedgeMechanism ? (
          <p>
            <span className="text-muted">Pays when: </span>
            {leg.hedgeMechanism}
          </p>
        ) : null}
        {leg.basisRiskNote ? (
          <p>
            <span className="text-muted">Basis risk: </span>
            {leg.basisRiskNote}
          </p>
        ) : null}
        <p className="text-[12px] text-muted">Closes {fmtCloseTime(leg.expiry)}</p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div role="group" aria-label="Side" className="grid grid-cols-2 gap-2">
          {(["yes", "no"] as const).map((s) => (
            <button
              key={s}
              type="button"
              disabled={!editable}
              aria-pressed={leg.side === s}
              className={`btn ${leg.side === s ? (s === "yes" ? "btn-primary" : "btn-danger") : "btn-secondary"}`}
              onClick={() => onSide(s)}
            >
              {s === "yes" ? "Yes" : "No"}
              {leg.side === s ? <span className="figure ml-1">{fmtPrice(leg.price)}</span> : null}
            </button>
          ))}
        </div>
        <div>
          <label htmlFor={`${uid}-m`} className="sr-only">
            Margin in USDC
          </label>
          <div className="flex items-center gap-2">
            <span className="text-muted">$</span>
            <input
              id={`${uid}-m`}
              className="field num"
              inputMode="decimal"
              autoComplete="off"
              disabled={!editable}
              value={marginInput}
              aria-invalid={marginProblem ? true : undefined}
              onChange={(e) => {
                setMarginInput(e.target.value);
                const v = parseUsdc(e.target.value);
                if (v !== null && v >= MIN_MARGIN) onMargin(Number(v));
              }}
            />
          </div>
          {marginProblem ? <p className="mt-1 text-[12px] text-danger">{marginProblem}</p> : null}
        </div>
        <div role="group" aria-label="Leverage" className="flex flex-wrap gap-2">
          {chips.map((l) => (
            <button
              key={l}
              type="button"
              disabled={!editable}
              aria-pressed={leg.leverage === l}
              className={`btn num px-3 ${leg.leverage === l ? "btn-solid" : "btn-outline"}`}
              onClick={() => onLeverage(l)}
            >
              {fmtLeverage(l)}
            </button>
          ))}
        </div>
      </div>

      <dl className="rows">
        <div>
          <dt>Contracts</dt>
          <dd className="num">{fmtContracts(preview.contracts)}</dd>
        </div>
        <div>
          <dt>Cost (margin + fee)</dt>
          <dd className="num">${fmtUsdc(preview.total)}</dd>
        </div>
        <div>
          <dt>Liquidation price</dt>
          <dd className={`num ${preview.liqPrice > 0n ? "text-danger" : ""}`}>{preview.liqPrice === 0n ? "None" : fmtPrice(preview.liqPrice)}</dd>
        </div>
        <div>
          <dt>Payout if it wins</dt>
          <dd className="num text-accent">${fmtUsdc(preview.payoutIfWin)}</dd>
        </div>
      </dl>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-muted" aria-live="polite">
          {status
            ? status.status === "opened"
              ? `Opened${status.positionId !== undefined ? ` as #${status.positionId.toString()}` : ""}.`
              : status.status === "opening"
                ? "Opening…"
                : status.status === "failed"
                  ? `Failed: ${status.error ?? "unknown error"}`
                  : "Waiting to open."
            : blocked ?? (leg.maxLeverage <= 10 ? "Only 1x at this price or this close to the close." : `Max ${fmtLeverage(leg.maxLeverage)} at this price.`)}
        </p>
        {editable ? (
          <button type="button" className="btn btn-outline px-3 text-[13px]" onClick={onRemove}>
            Remove leg
          </button>
        ) : null}
      </div>
    </article>
  );
}
