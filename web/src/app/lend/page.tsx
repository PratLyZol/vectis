import type { Metadata } from "next";
import Link from "next/link";
import { RevealOnScroll } from "@/components/RevealOnScroll";
import { VaultCard } from "@/components/VaultCard";
import { fmtUnits6, fmtUsdc } from "@/lib/format";
import { OPEN_FEE_BPS, openFee } from "@/lib/math";

export const metadata: Metadata = {
  title: "Lend USDC",
  description:
    "Supply USDC to the Vectis vault. Traders borrow it to open leveraged positions and pay lenders 1% of the amount borrowed. The risks are listed beside the earnings.",
};

const USDC = 1_000_000n;
const FEE_PERCENT = Number(OPEN_FEE_BPS) / 100;

// The worked example. Every figure below is computed from these four inputs with the same
// integer rules the contracts use, so the page cannot drift from the arithmetic.
const VAULT_BEFORE = 10_000n * USDC; // USDC in the vault
const YOUR_DEPOSIT = 1_000n * USDC; // your part of it
const TRADER_MARGIN = 100n * USDC;
const TRADER_LEVERAGE = 30n; // tenths: 3x

const size = (TRADER_MARGIN * TRADER_LEVERAGE) / 10n;
const borrowed = size - TRADER_MARGIN;
const fee = openFee(borrowed);
const vaultAfter = VAULT_BEFORE + fee;
// Shares do not change when a fee arrives, so each share is worth vaultAfter / VAULT_BEFORE.
const sharePriceAfter = (vaultAfter * USDC) / VAULT_BEFORE;
const yourValueAfter = (YOUR_DEPOSIT * vaultAfter) / VAULT_BEFORE;
const yourGain = yourValueAfter - YOUR_DEPOSIT;
const yourSharePercent = Number((YOUR_DEPOSIT * 100n) / VAULT_BEFORE);

const RISKS: { title: string; body: string }[] = [
  {
    title: "A price gap can cost lenders money",
    body: "A position is sold when its price reaches the liquidation price, which sits $0.04 above the debt per contract. If the price jumps past that in one move, as it can when a result is announced, the sale may not cover the loan. The shortfall is written off against the vault, and every lender's shares are worth less.",
  },
  {
    title: "Lent USDC cannot be withdrawn until it is repaid",
    body: "You can withdraw only the USDC that is sitting idle in the vault. If most of it is lent to open positions, you wait until those positions close.",
  },
  {
    title: "Testnet, unaudited",
    body: "Vectis is a hackathon build on Arc testnet. The contracts have not been audited and testnet USDC has no value. Do not treat anything here as a savings product.",
  },
];

export default function LendPage() {
  return (
    <>
      <RevealOnScroll />
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-start lg:gap-16">
        <div className="min-w-0">
          <p className="eyebrow enter">For lenders</p>
          <h1
            className="enter mt-4 text-[30px] font-light md:text-[40px]"
            style={{ letterSpacing: "-0.02em", lineHeight: 1.1, "--i": 1 } as React.CSSProperties}
          >
            Lend USDC to prediction-market traders and earn {FEE_PERCENT}% of what they borrow
          </h1>
          <p className="enter mt-5 max-w-[56ch] text-[17px] text-text-2" style={{ "--i": 2 } as React.CSSProperties}>
            Traders on Vectis post margin and borrow the rest of their position from one shared USDC vault. Each time a
            position opens, the trader pays {FEE_PERCENT}% of the amount borrowed into the vault. That fee belongs to the
            lenders.
          </p>
          <a href="#deposit" className="btn btn-primary btn-lg enter mt-7 px-6 lg:hidden" style={{ "--i": 3 } as React.CSSProperties}>
            Deposit USDC
          </a>

          <section className="mt-14" aria-labelledby="how-h" data-reveal="">
            <h2 id="how-h" className="rv-clip text-[24px] md:text-[28px]">
              How lenders earn
            </h2>
            <ol className="m-0 mt-6 grid list-none gap-4 p-0 sm:grid-cols-3">
              <li className="card rv p-5" style={{ "--i": 0 } as React.CSSProperties}>
                <p className="eyebrow">Step 1</p>
                <h3 className="mt-1 text-[17px]">Deposit USDC</h3>
                <p className="mt-2 text-[14px] text-text-2">
                  You receive vault shares for your deposit. The shares are your claim on the vault.
                </p>
              </li>
              <li className="card rv p-5" style={{ "--i": 1 } as React.CSSProperties}>
                <p className="eyebrow">Step 2</p>
                <h3 className="mt-1 text-[17px]">Traders borrow and pay the fee</h3>
                <p className="mt-2 text-[14px] text-text-2">
                  The fee goes into the vault and no new shares are created for it, so each share is worth a little more.
                </p>
              </li>
              <li className="card rv p-5" style={{ "--i": 2 } as React.CSSProperties}>
                <p className="eyebrow">Step 3</p>
                <h3 className="mt-1 text-[17px]">Withdraw at the share price</h3>
                <p className="mt-2 text-[14px] text-text-2">
                  Your shares convert back to USDC at the current share price, whenever the vault has idle USDC.
                </p>
              </li>
            </ol>
          </section>

          <section className="mt-14" aria-labelledby="example-h" data-reveal="">
            <h2 id="example-h" className="rv-clip text-[24px] md:text-[28px]">
              A worked example
            </h2>
            <p className="rv mt-3 max-w-[56ch] text-text-2">
              One position opening, with round numbers. This is arithmetic, not a forecast: what lenders earn depends
              entirely on how much traders borrow.
            </p>
            <dl className="rows card rv mt-6 p-5 md:p-6" style={{ "--i": 1 } as React.CSSProperties}>
              <div>
                <dt>The vault holds</dt>
                <dd className="num">${fmtUsdc(VAULT_BEFORE)}</dd>
              </div>
              <div>
                <dt>Of which you supplied ({yourSharePercent}% of the shares)</dt>
                <dd className="num">${fmtUsdc(YOUR_DEPOSIT)}</dd>
              </div>
              <div>
                <dt>
                  A trader posts ${fmtUsdc(TRADER_MARGIN, 0)} margin at {Number(TRADER_LEVERAGE) / 10}x and borrows
                </dt>
                <dd className="num">${fmtUsdc(borrowed)}</dd>
              </div>
              <div>
                <dt>
                  Open fee paid into the vault ({FEE_PERCENT}% of ${fmtUsdc(borrowed, 0)})
                </dt>
                <dd className="num text-accent">${fmtUsdc(fee)}</dd>
              </div>
              <div>
                <dt>The vault is now worth</dt>
                <dd className="num">${fmtUsdc(vaultAfter)}</dd>
              </div>
              <div>
                <dt>Share price, from 1.000000</dt>
                <dd className="num">{fmtUnits6(sharePriceAfter, 6)}</dd>
              </div>
              <div>
                <dt className="font-medium text-text">Your shares are now worth</dt>
                <dd className="num text-accent">
                  ${fmtUsdc(yourValueAfter)} <span className="text-muted">(+${fmtUsdc(yourGain)})</span>
                </dd>
              </div>
            </dl>
            <p className="rv mt-3 max-w-[56ch] text-[13px] text-muted" style={{ "--i": 2 } as React.CSSProperties}>
              The loan itself is repaid when the position closes. A position at 1x borrows nothing and pays no fee.
            </p>
          </section>

          <section className="mt-14" aria-labelledby="risks-h" data-reveal="">
            <h2 id="risks-h" className="rv-clip text-[24px] md:text-[28px]">
              The risks, as plainly as the earnings
            </h2>
            <ul className="m-0 mt-6 grid list-none gap-4 p-0">
              {RISKS.map((r, i) => (
                <li key={r.title} className="card rv p-5 md:p-6" style={{ "--i": i } as React.CSSProperties}>
                  <h3 className="text-[17px]">
                    <span className="text-danger">Risk:</span> {r.title}
                  </h3>
                  <p className="mt-2 max-w-[62ch] text-[14px] text-text-2">{r.body}</p>
                </li>
              ))}
            </ul>
          </section>

          <section className="mt-14" aria-labelledby="start-h" data-reveal="">
            <h2 id="start-h" className="rv-clip text-[24px] md:text-[28px]">
              Start lending
            </h2>
            <p className="rv mt-3 max-w-[56ch] text-text-2">
              There are no accounts. Connect a wallet on Arc testnet, enter an amount in the vault panel and press
              Deposit. Your shares and their current value appear in the panel as soon as the deposit confirms.
            </p>
            <div className="rv mt-6 flex flex-wrap gap-3" style={{ "--i": 1 } as React.CSSProperties}>
              <a href="#deposit" className="btn btn-primary lg:hidden">
                Deposit USDC
              </a>
              <Link href="/markets" className="btn btn-secondary">
                See what traders borrow for
              </Link>
            </div>
          </section>
        </div>

        <div className="min-w-0 lg:sticky lg:top-[88px]">
          <div className="enter enter-panel" style={{ "--i": 3 } as React.CSSProperties}>
            <VaultCard id="deposit" className="mx-auto lg:mx-0" />
          </div>
          <p className="mx-auto mt-3 max-w-[420px] text-[12px] text-muted lg:mx-0">
            The figures in this panel are read from the vault. The same panel is on the{" "}
            <Link className="link" href="/vault">
              vault page
            </Link>
            .
          </p>
        </div>
      </div>
    </>
  );
}
