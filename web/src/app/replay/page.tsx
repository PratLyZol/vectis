import type { Metadata } from "next";
import { PositionReplay } from "@/components/PositionReplay";
import { getEvent, isSafeId } from "@/lib/gemini";
import type { ReplayMarket } from "@/lib/replay";
import { savedReplays } from "@/lib/replays.server";

export const metadata: Metadata = {
  title: "Replay",
  description:
    "Replay a leveraged position on a Gemini prediction market's real price history and watch it gain or reach its liquidation price.",
};

type Props = { searchParams: Promise<{ symbol?: string | string[]; t?: string | string[] }> };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function ReplayPage({ searchParams }: Props) {
  const q = await searchParams;
  const symbol = one(q.symbol);
  const ticker = one(q.t);
  const markets: ReplayMarket[] = [...savedReplays];

  // Arriving from a market page: put that market first, with its live history.
  if (symbol && ticker && isSafeId(symbol) && isSafeId(ticker) && !markets.some((m) => m.symbol === symbol)) {
    const event = (await getEvent(ticker))?.event;
    const contract = event?.contracts.find((c) => c.symbol === symbol);
    if (event && contract) markets.unshift({ symbol, title: event.title, label: contract.label });
  }
  const initial = markets.find((m) => m.symbol === symbol)?.symbol ?? markets[0]?.symbol;

  return (
    <>
      <h1 className="text-[28px] md:text-[36px]">Replay</h1>
      {initial ? <PositionReplay markets={markets} initialSymbol={initial} /> : null}
      <p className="mt-4 max-w-[80ch] text-[12px] text-muted">
        Entries and exits use each one-minute bar&apos;s closing price, with no spread. A liquidation sells at the
        liquidation price, or at the bar&apos;s close when the price ended the minute below it. The step-down to 1x
        in a market&apos;s final hour is not applied here.
      </p>
    </>
  );
}
