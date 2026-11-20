"use client";

import { useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import { keccak256, toBytes, type Hex } from "viem";
import { isMock } from "@/config/contracts";
import { useOpenBatch, useOracleQuotes, useSpendableUsdc, useVault, useWallet, type BatchItem, type OracleQuote } from "@/hooks/useChain";
import { useEvents, useNow } from "@/hooks/useMarketData";
import { fmtCloseTime, fmtLeverage, fmtPrice, fmtSignedUsd, fmtUsdc, fmtUnits6, parseUsdc, unixSeconds } from "@/lib/format";
import { legPreview, proposalTotals, scenarioPnl, sideOf } from "@/lib/hedge/validate";
import { LEVERAGE_UNIT, MIN_MARGIN, ONE, SIDE_NO, SIDE_YES, maxLeverage, sideAsk } from "@/lib/math";
import type { HedgeLeg, HedgeProposal as Proposal, MarketContract } from "@/lib/types";
import { IconTile } from "./MarketHeader";

const ORACLE_MAX_AGE = 60n;
const LEVERAGE_STEPS = [10, 15, 20, 30, 40]; // tenths; the current max is added to these
const LEVERAGE_UNIT_N = Number(LEVERAGE_UNIT);
const MAX_MOVE = 30_000n;
const LEG_STAGGER_MS = 60;
const REQUEST_EVERY_MS = 10 * 60_000; // keeps the keeper's request alive while the page is open

type RequestState = { status: "sent" } | { status: "rejected"; reason: string } | { status: "failed" };

/**
 * Ask the keeper to price every proposed market (live mode only). The keeper polls the requests,
 * registers new markets and starts posting prices, usually within a minute.
 */
function useMarketRequests(legs: HedgeLeg[]): Map<string, RequestState> {
  const [state, setState] = useState<Map<string, RequestState>>(new Map());
  const key = [...new Set(legs.map((l) => `${l.eventTicker}|${l.symbol}`))].sort().join(",");
  useEffect(() => {
    if (isMock || !key) return;
    const markets = key.split(",").map((k) => {
      const [eventTicker, symbol] = k.split("|");
      return { eventTicker, symbol };
    });
    let stop = false;
    const send = async () => {
      let next: Map<string, RequestState>;
      try {
        const res = await fetch("/api/market-requests", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ markets }),
        });
        const body = (await res.json().catch(() => null)) as { requested?: string[]; rejected?: { symbol: string; reason: string }[] } | null;
        if (!res.ok || !body?.requested) throw new Error(String(res.status));
        next = new Map(body.requested.map((sym) => [sym, { status: "sent" }]));
        for (const r of body.rejected ?? []) next.set(r.symbol, { status: "rejected", reason: r.reason });
      } catch {
        next = new Map(markets.map((m) => [m.symbol ?? "", { status: "failed" }]));
      }
      if (!stop) setState(next);
    };
    void send();
    const t = setInterval(() => void send(), REQUEST_EVERY_MS);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [key]);
  return state;
}
 // $0.03: a price move that needs a fresh confirmation

type Live = {
  leg: HedgeLeg; // with live price and max leverage, leverage clamped to it
  marketId: Hex;
  blocked: string | null; // why this leg cannot be opened right now
  unpriced: boolean; // blocked only because the keeper has no fresh on-chain price yet
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
  let unpriced = false;
  if (closed) blocked = "This market has closed.";
  else if (!isMock && !oracleFresh) {
    unpriced = true;
    blocked = "Not priced on-chain yet.";
  } else if (price === null) blocked = `No ${leg.side === "yes" ? "Yes" : "No"} offer right now.`;

  return {
    leg: { ...leg, price: price !== null ? Number(price) : leg.price, maxLeverage: Number(max), leverage },
    marketId,
    blocked,
    unpriced,
  };
}

const PRICE_PENDING = "Starting the price feed.";

function unpricedText(req: RequestState | undefined): string {
  if (!req || req.status === "sent") return PRICE_PENDING;
  if (req.status === "rejected") return `Can't be priced: ${req.reason}.`;
  return "Couldn't ask the keeper to price this market. Try again shortly.";
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
  // The legs of a new proposal enter one at a time (LEG_STAGGER_MS apart). Only rows present at
  // mount do; a row that remounts later (after a removal) just appears.
  const [introMs] = useState(() => LEG_STAGGER_MS * proposal.legs.length + 400);
  const [intro, setIntro] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setIntro(false), introMs);
    return () => clearTimeout(t);
  }, [introMs]);

  const tickers = useMemo(() => [...new Set(proposal.legs.map((l) => l.eventTicker))], [proposal.legs]);
  const eventQueries = useEvents(tickers);
  const contracts = new Map<string, MarketContract>();
  for (const q of eventQueries) for (const c of q.data?.event.contracts ?? []) contracts.set(c.symbol, c);
  const marketIds = useMemo(() => proposal.legs.map((l) => keccak256(toBytes(l.symbol))), [proposal.legs]);
  const oracle = useOracleQuotes(marketIds);

  const requests = useMarketRequests(proposal.legs);
  const live = proposal.legs.map((l, i) => {
    const x = liveLeg(l, contracts.get(l.symbol), oracle.get(marketIds[i]!), now);
    return x.unpriced ? { ...x, blocked: unpricedText(requests.get(l.symbol)) } : x;
  });
  const legs = live.map((x) => x.leg);
  const tradeable = live.filter((x) => x.blocked === null);
  // Figures cover the legs that can be opened. When none can, show the hedge as proposed so the
  // user still sees what it would do, and say so.
  const counted = tradeable.length ? tradeable.map((x) => x.leg) : legs;
  const excluded = tradeable.length ? live.length - tradeable.length : 0;
  const totals = proposalTotals(counted);

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

  const leveraged = counted.some((l) => l.leverage > LEVERAGE_UNIT_N);
  const n = tradeable.length;
  const positions = `${n} position${n === 1 ? "" : "s"}`;

  return (
    <section className="flex flex-col gap-4" aria-labelledby={`${uid}-h`}>
      <h2 id={`${uid}-h`} className="sr-only">
        Proposed hedge
      </h2>
      {proposal.hedgingAgainst ? (
        <div>
          <p className="eyebrow">Hedging against</p>
          <p className="mt-1 text-[20px]">{proposal.hedgingAgainst}</p>
        </div>
      ) : null}
      {proposal.notes.length || proposal.source === "fixture" ? (
        <ul className="flex flex-col gap-1 text-[13px] text-muted" aria-label="Notes">
          {proposal.source === "fixture" ? <li>Gemini was unreachable; prices come from a saved snapshot.</li> : null}
          {proposal.notes.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      ) : null}

      {live.length ? (
        <ul className="card m-0 list-none p-0" aria-label="Positions">
          {live.map((x, i) => (
            <LegRow
              key={`${x.leg.symbol}-${i}`}
              live={x}
              enter={intro ? i : undefined}
              editable={editable}
              status={batch.legs[ran.indexOf(`${x.leg.symbol}:${x.leg.side}`)]}
              onSide={(side) => update(i, { side })}
              onMargin={(margin) => update(i, { margin })}
              onLeverage={(leverage) => update(i, { leverage })}
              onRemove={() => remove(i)}
            />
          ))}
        </ul>
      ) : null}

      {legs.length ? (
        <div className="card flex flex-col gap-4 p-4 md:p-6">
          {proposal.scenarios.length ? (
            <div className="flex flex-col gap-3">
              <h3 className="text-[16px]">If held to resolution</h3>
              <dl className="rows">
                {proposal.scenarios.map((s, i) => (
                  <div key={i}>
                    <dt>{s.name}</dt>
                    <dd className="num">{fmtSignedUsd(scenarioPnl(counted, s))}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
          <dl className="stats grid-cols-2 sm:grid-cols-4">
            <div>
              <dt>Cost</dt>
              <dd>${fmtUsdc(totals.total)}</dd>
            </div>
            <div>
              <dt>Max loss</dt>
              <dd className="text-danger">${fmtUsdc(totals.maxLoss)}</dd>
            </div>
            <div>
              <dt>Payout if all win</dt>
              <dd className="text-accent">${fmtUsdc(totals.payoutIfAllWin)}</dd>
            </div>
            <div>
              <dt>Borrowed</dt>
              <dd>${fmtUsdc(totals.borrowed)}</dd>
            </div>
          </dl>
          {tradeable.length === 0 ? (
            <p className="text-[13px] text-muted">
              {live.some((x) => x.blocked === PRICE_PENDING)
                ? "Starting on-chain price feeds. The legs unlock in about a minute."
                : "None of these legs can be opened right now."}
            </p>
          ) : excluded ? (
            <p className="text-[13px] text-muted">
              {live.some((x) => x.blocked === PRICE_PENDING) ? "Starting on-chain price feeds for the rest. " : ""}Totals leave out {excluded} leg{excluded === 1 ? "" : "s"} that can&apos;t be opened.
            </p>
          ) : null}
          {leveraged ? <p className="text-[13px] text-muted">A leveraged leg ends early if its price reaches the liquidation price.</p> : null}

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
                <button type="button" className="btn btn-primary btn-lg btn-block" disabled={locked || problem !== null || n === 0} onClick={openReview}>
                  Review {positions}
                </button>
                {problem && n > 0 ? <p className="text-[13px] text-muted">{problem}</p> : null}
              </>
            )
          ) : null}

          {review !== null && !started ? (
            <div className="note appear flex flex-col gap-3" role="region" aria-label="Confirm hedge">
              {moved ? (
                <p className="text-danger" role="alert">
                  Prices moved. Check the updated figures and confirm again.
                </p>
              ) : null}
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-1" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                <span>I can lose up to ${fmtUsdc(totals.maxLoss)}, and these positions may not fully offset my exposure.</span>
              </label>
              <p className="text-[13px] text-muted">
                {isMock ? "Demo mode: uses demo USDC." : `One USDC approval if needed, then ${n} transaction${n === 1 ? "" : "s"}.`}
              </p>
              <div className="flex flex-wrap gap-3">
                <button type="button" className="btn btn-primary" disabled={!ack || problem !== null} onClick={confirm}>
                  Open {positions}
                </button>
                <button type="button" className="btn btn-outline" onClick={() => setReview(null)}>
                  Back
                </button>
              </div>
            </div>
          ) : null}

          {started ? (
            <div className="note appear flex flex-col gap-2" role="status" aria-live="polite">
              {batch.phase === "approving" ? <p>Approving USDC…</p> : null}
              {batch.phase === "opening" ? (
                <p>
                  Opening {batch.legs.filter((l) => l.status === "opened").length + 1} of {batch.legs.length}…
                </p>
              ) : null}
              {batch.phase === "done" ? (
                <p>
                  {batch.filled ? "All positions open and filled." : "All positions open; waiting for fills."}{" "}
                  <Link className="link" href="/portfolio">
                    Portfolio
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

function LegRow({
  live,
  enter,
  editable,
  status,
  onSide,
  onMargin,
  onLeverage,
  onRemove,
}: {
  live: Live;
  enter?: number; // position in the entrance stagger, while the proposal is entering
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
  const levels = [...new Set([...LEVERAGE_STEPS.filter((l) => l < leg.maxLeverage), leg.maxLeverage])];
  const marginValue = parseUsdc(marginInput);
  const marginProblem = marginValue === null ? "Enter a USDC amount." : marginValue < MIN_MARGIN ? "Minimum 1 USDC." : null;
  const statusText = status
    ? status.status === "opened"
      ? `Opened${status.positionId !== undefined ? ` as #${status.positionId.toString()}` : ""}`
      : status.status === "opening"
        ? "Opening…"
        : status.status === "failed"
          ? `Failed: ${status.error ?? "unknown error"}`
          : "Waiting"
    : blocked === PRICE_PENDING
      ? null
      : blocked;

  return (
    <li
      className={`flex flex-col gap-3 border-t border-border p-4 first:border-t-0 md:px-6 ${blocked && !status ? "text-muted" : ""} ${enter !== undefined ? "appear" : ""}`}
      style={enter !== undefined ? { transitionDelay: `${enter * LEG_STAGGER_MS}ms` } : undefined}
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <IconTile small category={leg.category} image={leg.imageUrl} />
          <div className="min-w-0">
            <p className="truncate text-text">{leg.label}</p>
            <p className="truncate text-[12px] text-muted">
              {leg.eventTitle} · closes <span className="num">{fmtCloseTime(leg.expiry)}</span> · {leg.basisRisk === "direct" ? "Direct" : "Proxy"}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="seg w-[168px]" role="radiogroup" aria-label={`Side for ${leg.label}`}>
            {(["yes", "no"] as const).map((o) => (
              <label key={o} className="seg-item" data-tone={o}>
                <input type="radio" name={`${uid}-side`} checked={leg.side === o} disabled={!editable} onChange={() => onSide(o)} />
                {o === "yes" ? "Yes" : "No"}
                {leg.side === o ? <span className="num font-medium">{fmtPrice(leg.price)}</span> : null}
              </label>
            ))}
          </div>
          <label className="sr-only" htmlFor={`${uid}-m`}>
            Margin in USDC
          </label>
          <input
            id={`${uid}-m`}
            className="field num w-[96px]"
            inputMode="decimal"
            autoComplete="off"
            disabled={!editable}
            value={marginInput}
            aria-invalid={marginProblem ? true : undefined}
            title={marginProblem ?? "Margin in USDC"}
            onChange={(e) => {
              setMarginInput(e.target.value);
              const v = parseUsdc(e.target.value);
              if (v !== null && v >= MIN_MARGIN) onMargin(Number(v));
            }}
          />
          <label className="sr-only" htmlFor={`${uid}-l`}>
            Leverage
          </label>
          <select
            id={`${uid}-l`}
            className="field num w-[80px]"
            disabled={!editable || levels.length < 2}
            value={leg.leverage}
            onChange={(e) => onLeverage(Number(e.target.value))}
          >
            {levels.map((l) => (
              <option key={l} value={l}>
                {fmtLeverage(l)}
              </option>
            ))}
          </select>
          <p className="num w-[128px] whitespace-nowrap text-right text-[13px] leading-tight">
            <span className="block text-text">${fmtUsdc(preview.total)}</span>
            <span className="block text-muted">
              pays <span className="text-accent">${fmtUsdc(preview.payoutIfWin)}</span>
            </span>
          </p>
          {editable ? (
            <button type="button" className="btn btn-secondary px-3" onClick={onRemove} aria-label={`Remove ${leg.label}`}>
              Remove
            </button>
          ) : null}
        </div>
      </div>
      {statusText || marginProblem || preview.liqPrice > 0n ? (
        <p className="text-[12px] text-muted" aria-live="polite">
          {[marginProblem, statusText, preview.liqPrice > 0n ? `Liquidation at ${fmtPrice(preview.liqPrice)}` : null].filter(Boolean).join(" · ")}
        </p>
      ) : null}
    </li>
  );
}
