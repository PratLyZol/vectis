"use client";

import { useId, useState } from "react";
import { isMock } from "@/config/contracts";
import { useSpendableUsdc, useVault, useWallet } from "@/hooks/useChain";
import { fmtPercentBps, fmtUnits6, fmtUsdc, parseUsdc } from "@/lib/format";
import { OPEN_FEE_BPS } from "@/lib/math";

/** A balance as plain input text: no grouping, no trailing zeros. */
const plain = (v: bigint) => {
  const s = fmtUnits6(v, 6).replaceAll(",", "");
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
};

const FEE_PERCENT = Number(OPEN_FEE_BPS) / 100; // 1

export function VaultCard({ id, className = "mx-auto mt-8" }: { id?: string; className?: string }) {
  const uid = useId();
  const vault = useVault();
  const wallet = useWallet();
  const balance = useSpendableUsdc();
  const [input, setInput] = useState("");

  const utilBps = vault.totalAssets > 0n ? (vault.totalBorrowed * 10_000n) / vault.totalAssets : 0n;
  const utilPct = Math.min(100, Number(utilBps) / 100);
  const amount = parseUsdc(input);
  const hasAmount = amount !== null && amount > 0n;

  // Each button is checked against its own limit; the line under them explains a blocked one.
  const depositProblem = !hasAmount
    ? "Enter an amount in USDC."
    : balance !== undefined && amount > balance
      ? "The amount is more than your USDC balance, so it cannot be deposited."
      : null;
  const withdrawProblem = !hasAmount
    ? "Enter an amount in USDC."
    : amount > vault.userAssets
      ? "The amount is more than your deposit, so it cannot be withdrawn."
      : amount > vault.maxWithdraw
        ? `Only $${fmtUsdc(vault.maxWithdraw)} can be withdrawn now. The rest is lent to open positions.`
        : null;
  const message =
    input === "" ? null : !hasAmount ? depositProblem : depositProblem && withdrawProblem ? depositProblem : null;

  const needsWallet = !isMock && !wallet.connected;
  const needsChain = !isMock && wallet.connected && wallet.wrongChain;
  const busy = vault.busy !== null;
  const loaded = (v: string) => (vault.loaded ? v : "…");

  const run = async (kind: "deposit" | "withdraw") => {
    if (amount === null) return;
    const ok = kind === "deposit" ? await vault.deposit(amount) : await vault.withdraw(amount);
    if (ok) setInput("");
  };

  return (
    <section
      id={id}
      className={`card flex w-full max-w-[420px] scroll-mt-24 flex-col gap-5 p-4 md:p-6 ${className}`}
      aria-labelledby={`${uid}-h`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={`${uid}-h`} className="text-[18px]">
          USDC vault
        </h2>
        <span className="num text-[12px] text-muted">Arc testnet</span>
      </div>

      <div>
        <p className="text-[13px] text-muted">Lender fee</p>
        {/* A fee per loan, not a yearly rate: there is no history to annualise. */}
        <p className="figure mt-1 text-[40px] text-accent">{FEE_PERCENT}%</p>
        <p className="mt-2 text-[13px] text-text-2">
          Lenders earn {FEE_PERCENT}% of every dollar borrowed, paid when a position opens. It is a fee on each loan,
          not a yearly rate.
        </p>
      </div>

      <dl key={vault.loaded ? "loaded" : "loading"} className="stats fade-in grid-cols-2">
        <div className="min-w-0">
          <dt>Total deposits</dt>
          <dd>{loaded(`$${fmtUsdc(vault.totalAssets)}`)}</dd>
        </div>
        <div className="min-w-0">
          <dt>Your deposit</dt>
          <dd>{needsWallet ? "n/a" : `$${fmtUsdc(vault.userAssets)}`}</dd>
        </div>
        <div className="min-w-0">
          <dt>Fees earned by lenders</dt>
          <dd>{vault.totalFees === undefined ? "n/a" : `$${fmtUsdc(vault.totalFees)}`}</dd>
        </div>
        <div className="min-w-0">
          <dt>Share price</dt>
          <dd>{loaded(fmtUnits6(vault.sharePrice, 6))}</dd>
        </div>
      </dl>

      {vault.userShares > 0n ? (
        <p className="note appear" role="status">
          You hold{" "}
          <span className="num text-text">{fmtUnits6((vault.userShares * 1_000_000n) / vault.shareUnit, 2)}</span> vault
          shares, worth <span className="num text-text">${fmtUsdc(vault.userAssets)}</span> now. Their value rises as
          traders pay open fees.
        </p>
      ) : null}

      <div>
        <div className="flex items-baseline justify-between gap-3 text-[13px]">
          <span id={`${uid}-util`} className="text-muted">
            Lent to traders
          </span>
          <span className="num text-text-2">{loaded(fmtPercentBps(utilBps))}</span>
        </div>
        <div
          role="meter"
          aria-labelledby={`${uid}-util`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(utilPct)}
          aria-valuetext={fmtPercentBps(utilBps)}
          className="bar mt-3"
        >
          <span style={{ transform: `translateX(${utilPct - 100}%)` }} />
        </div>
        <p className="mt-3 text-[12px] text-muted">
          Lent USDC cannot be withdrawn until those positions close. A position that settles below its debt is a loss to
          the vault.
        </p>
      </div>

      <div>
        <div className="flex items-center justify-between gap-4">
          <label className="text-[16px] font-medium" htmlFor={`${uid}-amount`}>
            Amount
          </label>
          <div className="flex min-w-0 items-baseline justify-end gap-1">
            <span className="figure text-[40px] text-muted" aria-hidden="true">
              $
            </span>
            <input
              id={`${uid}-amount`}
              className="amount"
              style={{ width: `${Math.max(1, input.length)}ch` }}
              inputMode="decimal"
              autoComplete="off"
              placeholder="0"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              aria-describedby={`${uid}-msg`}
            />
          </div>
        </div>
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className="btn btn-secondary px-3 text-[13px] font-medium"
            disabled={balance === undefined || balance === 0n}
            onClick={() => balance !== undefined && setInput(plain(balance))}
          >
            {isMock ? "Demo balance" : "Wallet"}{" "}
            <span className="num">{balance === undefined ? "n/a" : `$${fmtUsdc(balance)}`}</span>
          </button>
          <button
            type="button"
            className="btn btn-secondary px-3 text-[13px] font-medium"
            disabled={vault.maxWithdraw === 0n}
            onClick={() => setInput(plain(vault.maxWithdraw))}
          >
            Withdrawable <span className="num">${fmtUsdc(vault.maxWithdraw)}</span>
          </button>
        </div>
      </div>

      <div className="mt-auto">
        {needsWallet ? (
          <button
            type="button"
            className="btn btn-primary btn-48 btn-block"
            onClick={wallet.connect}
            disabled={wallet.connecting || !wallet.hasConnector}
          >
            Connect wallet
          </button>
        ) : needsChain ? (
          <button
            type="button"
            className="btn btn-primary btn-48 btn-block"
            onClick={wallet.switchToArc}
            disabled={wallet.switching}
          >
            Switch to Arc Testnet
          </button>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className="btn btn-secondary btn-48"
              onClick={() => void run("withdraw")}
              disabled={busy || withdrawProblem !== null}
            >
              {vault.busy === "withdraw" ? "Withdrawing…" : "Withdraw"}
            </button>
            <button
              type="button"
              className="btn btn-primary btn-48"
              onClick={() => void run("deposit")}
              disabled={busy || depositProblem !== null}
            >
              {vault.busy === "approve" ? "Approving USDC…" : vault.busy === "deposit" ? "Depositing…" : "Deposit"}
            </button>
          </div>
        )}
        <p id={`${uid}-msg`} className="mt-3 min-h-[20px] text-[13px] text-muted" aria-live="polite">
          {needsWallet ? (wallet.hasConnector ? null : "No browser wallet was found.") : needsChain ? null : message}
        </p>
        {vault.error ? (
          <p className="note appear mt-2 text-danger" role="alert">
            {vault.error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
