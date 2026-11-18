// Price history for the replay page. Server only: the saved snapshots stay out of the browser bundle.
import snapshots from "./fixtures-replays.json";
import { cached, getJson, isSafeId } from "./gemini";
import type { Candle, CandlesResponse, ReplayMarket } from "./replay";

type Snapshot = { symbol: string; title: string; label: string; day: string; candles: number[][] };
const SAVED = snapshots as Snapshot[];

/** Markets whose one-minute history was saved from Gemini, so they replay after Gemini drops them. */
export const savedReplays: ReplayMarket[] = SAVED.map(({ symbol, title, label, day }) => ({ symbol, title, label, day }));

const isCandle = (c: number[]): c is Candle => c.length === 5 && c.every((n) => Number.isFinite(n));

function fromGemini(body: unknown): Candle[] {
  if (!Array.isArray(body)) return [];
  const out: Candle[] = [];
  for (const row of body) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const [ms, o, h, l, c] = row as unknown[];
    if (![ms, o, h, l, c].every((n) => typeof n === "number" && Number.isFinite(n))) continue;
    const p = (n: unknown) => Math.round((n as number) * 1e6);
    out.push([Math.floor((ms as number) / 1000), p(o), p(h), p(l), p(c)]);
  }
  return out.sort((a, b) => a[0] - b[0]); // Gemini lists newest first
}

/** One-minute bars for a symbol. null: no such symbol, or no history. */
export async function getCandles(symbol: string): Promise<CandlesResponse | null> {
  if (!isSafeId(symbol)) return null;
  const saved = SAVED.find((s) => s.symbol === symbol);
  if (saved) return { symbol, source: "snapshot", candles: saved.candles.filter(isCandle) };
  return cached<CandlesResponse | null>(
    `candles/${symbol}`,
    30_000,
    async () => {
      const { status, body } = await getJson(`/v2/candles/${encodeURIComponent(symbol)}/1m`, 30);
      if (status === 404) return null;
      const candles = fromGemini(body);
      return candles.length >= 2 ? { symbol, source: "gemini", candles } : null;
    },
    () => null,
  );
}
