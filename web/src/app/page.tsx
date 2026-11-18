import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { ActivityFeed } from "@/components/ActivityFeed";
import { HeroPanel, LandingCombo, LandingMarkets, LiveNumbers } from "@/components/Landing";
import { LeverageDots } from "@/components/LeverageDots";
import { RevealOnScroll } from "@/components/RevealOnScroll";
import { TileField } from "@/components/TileField";
import { getMarkets } from "@/lib/gemini";

// Regenerated at most every 15 seconds; the browser then refreshes prices from /api/markets.
export const revalidate = 15;

export const metadata: Metadata = {
  title: { absolute: "Vectis: leveraged trading on Gemini prediction markets" },
  description:
    "Trade Gemini prediction markets with up to 5x leverage. Post USDC margin, borrow the rest from the Vectis vault, and settle on Arc testnet.",
};

/** Small stroke diagrams for the three steps. Decorative: the step text says the same thing. */
function Diagram({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 240 72"
      className="h-[72px] w-full max-w-[240px]"
      fill="none"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const STEPS: { title: string; body: string; diagram: ReactNode }[] = [
  {
    title: "Post margin",
    body: "Pick Yes or No on a Gemini market and post USDC. The margin is the most you can lose.",
    diagram: (
      <Diagram>
        {/* wallet -> one block of position */}
        <g>
          <rect x="8" y="22" width="52" height="30" className="stroke-border-2" />
          <path d="M44 37h8" className="stroke-muted" />
        </g>
        <g className="d" style={{ "--d": 0 } as React.CSSProperties}>
          <path d="M76 37h40m-8-7 8 7-8 7" className="stroke-muted" />
        </g>
        <g className="d" style={{ "--d": 1 } as React.CSSProperties}>
          <rect x="132" y="20" width="34" height="34" className="fill-yes-tint stroke-accent" />
        </g>
        <g className="d" style={{ "--d": 2 } as React.CSSProperties}>
          <rect x="170" y="20" width="62" height="34" className="stroke-border-2" strokeDasharray="4 5" />
        </g>
      </Diagram>
    ),
  },
  {
    title: "Borrow the rest",
    body: "The USDC vault lends the difference, up to 5x your margin, for a 1% fee on what you borrow. You see the liquidation price before you buy.",
    diagram: (
      <Diagram>
        {/* vault -> the rest of the position */}
        <g>
          <rect x="8" y="16" width="52" height="42" className="stroke-border-2" />
          <circle cx="34" cy="37" r="9" className="stroke-muted" />
          <path d="M34 28v-4M34 50v-4M43 37h4M21 37h4" className="stroke-muted" />
          <rect x="132" y="20" width="34" height="34" className="stroke-accent" />
        </g>
        <g className="d" style={{ "--d": 0 } as React.CSSProperties}>
          <path d="M76 37h40m-8-7 8 7-8 7" className="stroke-muted" />
        </g>
        <g className="d" style={{ "--d": 1 } as React.CSSProperties}>
          <rect x="170" y="20" width="62" height="34" className="fill-yes-tint stroke-accent" />
        </g>
      </Diagram>
    ),
  },
  {
    title: "Mirrored on Gemini, settled on Arc",
    body: "A keeper buys the contracts on Gemini and records the fill on Arc. When you sell, the vault is repaid first and the rest is yours.",
    diagram: (
      <Diagram>
        {/* Gemini <-> keeper <-> Arc */}
        <g>
          <rect x="8" y="20" width="62" height="34" className="stroke-border-2" />
          <path d="M22 44l9-10 8 6 11-12" className="stroke-muted" />
        </g>
        <g className="d" style={{ "--d": 0 } as React.CSSProperties}>
          <path d="M78 31h30m-7-6 7 6-7 6" className="stroke-muted" />
          <path d="M108 45H78m7-6-7 6 7 6" className="stroke-muted" />
        </g>
        <g className="d" style={{ "--d": 1 } as React.CSSProperties}>
          <circle cx="120" cy="38" r="5" className="fill-accent stroke-accent" />
        </g>
        <g className="d" style={{ "--d": 2 } as React.CSSProperties}>
          <path d="M132 31h30m-7-6 7 6-7 6" className="stroke-muted" />
          <path d="M162 45h-30m7-6-7 6 7 6" className="stroke-muted" />
        </g>
        <g className="d" style={{ "--d": 3 } as React.CSSProperties}>
          <rect x="170" y="20" width="62" height="34" className="stroke-accent" />
          <path d="M186 37h30M186 30h18M186 44h24" className="stroke-accent" />
        </g>
      </Diagram>
    ),
  },
];

const BUILT_ON: { name: string; role: string }[] = [
  { name: "Arc testnet", role: "Margin, lending and settlement contracts" },
  { name: "Gemini Prediction Markets", role: "The markets, prices and fills" },
  { name: "QuickNode Streams", role: "Contract events for the live activity feed" },
  { name: "USDC", role: "Margin, loans, fees and payouts" },
];

export default async function LandingPage() {
  const initial = await getMarkets();

  return (
    <>
      <RevealOnScroll />
      <section className="relative" aria-labelledby="hero-h">
        <TileField />
        <div className="over-field grid gap-10 pb-16 pt-4 md:pb-24 md:pt-10 lg:grid-cols-[minmax(0,1fr)_420px] lg:gap-16">
          <div className="min-w-0 lg:pt-10">
            <p className="eyebrow enter" style={{ "--i": 0 } as React.CSSProperties}>
              On Arc testnet · margined in USDC
            </p>
            <h1 id="hero-h" className="display mt-5">
              {/* Real spaces between the lines, so the heading reads as one sentence to screen
                  readers, search engines and copy-paste. The lines are blocks, so they do not show. */}
              <span className="enter-line">
                <span className="enter" style={{ "--i": 1 } as React.CSSProperties}>
                  Leverage for
                </span>
              </span>{" "}
              <span className="enter-line">
                <span className="enter" style={{ "--i": 2 } as React.CSSProperties}>
                  Gemini prediction
                </span>
              </span>{" "}
              <span className="enter-line">
                <span className="enter" style={{ "--i": 3 } as React.CSSProperties}>
                  markets, up to <span className="text-accent">5x</span>
                </span>
              </span>
            </h1>
            <p className="enter mt-6 max-w-[46ch] text-[17px] text-text-2 md:text-[19px]" style={{ "--i": 4 } as React.CSSProperties}>
              Post USDC margin, borrow the rest from the Vectis vault, and hold a bigger Yes or No position. The
              liquidation price is on the ticket before you buy.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/markets" className="btn btn-primary btn-lg enter px-6" style={{ "--i": 5 } as React.CSSProperties}>
                Open markets
              </Link>
              <Link href="/lend" className="btn btn-secondary btn-lg enter px-6" style={{ "--i": 6 } as React.CSSProperties}>
                Lend USDC
              </Link>
            </div>
          </div>
          <div className="min-w-0">
            <HeroPanel initial={initial} />
          </div>
        </div>
      </section>

      <section aria-labelledby="numbers-h" data-reveal="">
        <h2 id="numbers-h" className="sr-only">
          Live numbers
        </h2>
        <LiveNumbers initial={initial} />
      </section>

      <section className="section" aria-labelledby="how-h" data-reveal="">
        <div className="rv-clip">
          <p className="eyebrow">How it works</p>
          <h2 id="how-h" className="h-section mt-3 max-w-[20ch]">
            Three steps from margin to a settled position
          </h2>
        </div>
        <ol className="m-0 mt-10 grid list-none grid-cols-1 gap-4 p-0 md:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.title} className="card rv flex min-w-0 flex-col p-5 md:p-6" style={{ "--i": i } as React.CSSProperties}>
              {s.diagram}
              <p className="eyebrow mt-6">Step {i + 1}</p>
              <h3 className="mt-1 text-[18px]">{s.title}</h3>
              <p className="mt-2 text-[14px] text-text-2">{s.body}</p>
            </li>
          ))}
        </ol>
        <div className="rv mt-4" style={{ "--i": 3 } as React.CSSProperties}>
          <LeverageDots />
        </div>
        <dl className="m-0 mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="card rv p-5 md:p-6" style={{ "--i": 4 } as React.CSSProperties}>
            <dt className="text-[13px] text-muted">Maximum leverage</dt>
            <dd className="num m-0 mt-2 text-[15px] md:text-[17px]">min(5x, price ÷ $0.12)</dd>
            <dd className="m-0 mt-2 text-[14px] text-text-2">
              In steps of 0.5x and never below 1x. A 60¢ contract allows 5x, a 30¢ contract 2.5x. In the final hour
              before a market closes it is 1x.
            </dd>
          </div>
          <div className="card rv p-5 md:p-6" style={{ "--i": 5 } as React.CSSProperties}>
            <dt className="text-[13px] text-muted">Liquidation price</dt>
            <dd className="num m-0 mt-2 text-[15px] md:text-[17px]">
              borrowed per contract + <span className="text-danger">$0.04</span>
            </dd>
            <dd className="m-0 mt-2 text-[14px] text-text-2">
              If the bid for your side falls to this price, the position is sold and the vault is repaid. At 1x nothing
              is borrowed, so there is no liquidation price.
            </dd>
          </div>
        </dl>
      </section>

      <section className="section" aria-labelledby="markets-h" data-reveal="">
        <div className="rv-clip flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div>
            <p className="eyebrow">Live markets</p>
            <h2 id="markets-h" className="h-section mt-3">
              Markets open on Gemini now
            </h2>
          </div>
          <Link href="/markets" className="btn btn-secondary">
            See all markets
          </Link>
        </div>
        <div className="mt-8">
          <LandingMarkets initial={initial} />
        </div>
      </section>

      <section className="section grid gap-8 lg:grid-cols-2 lg:items-center lg:gap-16" aria-labelledby="combos-h" data-reveal="">
        <div className="rv-clip min-w-0">
          <p className="eyebrow">Combos</p>
          <h2 id="combos-h" className="h-section mt-3">
            Several outcomes in one leveraged position
          </h2>
          <p className="mt-4 max-w-[52ch] text-text-2">
            A combo pays $1 per contract only if every leg hits. Vectis prices it as the product of its legs&apos; prices
            on Gemini, so you can see the number before anyone quotes it. Pick two to six legs, one per event.
          </p>
          <Link href="/combos" className="btn btn-secondary mt-6">
            Build a combo
          </Link>
        </div>
        <div className="rv min-w-0" style={{ "--i": 2 } as React.CSSProperties}>
          <LandingCombo />
        </div>
      </section>

      <section className="section grid gap-8 lg:grid-cols-2 lg:gap-16" aria-labelledby="activity-h" data-reveal="">
        <div className="rv-clip min-w-0">
          <p className="eyebrow">On-chain activity</p>
          <h2 id="activity-h" className="h-section mt-3">
            Every open, fill and settlement, as it happens
          </h2>
          <p className="mt-4 max-w-[52ch] text-text-2">
            The margin and vault contracts emit an event for each step of a position. Those events are delivered to
            Vectis by a QuickNode stream and listed here with a link to the transaction.
          </p>
        </div>
        <div className="rv min-w-0" style={{ "--i": 2 } as React.CSSProperties}>
          <ActivityFeed scope="all" heading="Latest activity" />
        </div>
      </section>

      <section className="section" aria-labelledby="built-h" data-reveal="">
        <p className="eyebrow">Built on</p>
        <h2 id="built-h" className="sr-only">
          What Vectis is built on
        </h2>
        <ul className="m-0 mt-5 grid list-none grid-cols-1 gap-x-6 gap-y-6 rule-t p-0 pt-6 sm:grid-cols-2 lg:grid-cols-4">
          {BUILT_ON.map((b, i) => (
            <li key={b.name} className="rv min-w-0" style={{ "--i": i } as React.CSSProperties}>
              <p className="text-[17px] font-medium">{b.name}</p>
              <p className="mt-1 text-[13px] text-muted">{b.role}</p>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
