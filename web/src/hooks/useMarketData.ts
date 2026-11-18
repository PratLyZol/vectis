"use client";

import { useEffect, useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { Combo, CombosResponse } from "@/lib/combo";
import type { BookResponse, EventResponse, MarketsResponse } from "@/lib/types";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return (await res.json()) as T;
}

export function useMarkets(initialData?: MarketsResponse) {
  return useQuery({
    queryKey: ["markets"],
    queryFn: () => getJson<MarketsResponse>("/api/markets"),
    initialData,
    refetchInterval: 15_000,
  });
}

const eventQuery = (ticker: string) => ({
  queryKey: ["event", ticker] as const,
  queryFn: () => getJson<EventResponse>(`/api/markets/${encodeURIComponent(ticker)}`),
  refetchInterval: 15_000,
});

export function useEvent(ticker: string, initialData?: EventResponse, enabled = true) {
  return useQuery({ ...eventQuery(ticker), initialData, enabled });
}

export function useEvents(tickers: string[]) {
  return useQueries({ queries: tickers.map((t) => eventQuery(t)) });
}

export function useBook(symbol: string | undefined) {
  return useQuery({
    queryKey: ["book", symbol],
    queryFn: () => getJson<BookResponse>(`/api/book/${encodeURIComponent(symbol ?? "")}`),
    enabled: Boolean(symbol),
    refetchInterval: 5_000,
  });
}

const bookQuery = (symbol: string) => ({
  queryKey: ["book", symbol] as const,
  queryFn: () => getJson<BookResponse>(`/api/book/${encodeURIComponent(symbol)}`),
  refetchInterval: 5_000,
});

export type LegQuote = { yesBid: bigint | null; yesAsk: bigint | null };

/** Best YES-space bid and ask per contract, from each contract's order book. */
export function useLegQuotes(symbols: string[]): Map<string, LegQuote> {
  const unique = useMemo(() => [...new Set(symbols)].sort(), [symbols]);
  const books = useQueries({ queries: unique.map((s) => bookQuery(s)) });
  const stamp = books.map((b) => b.dataUpdatedAt).join(",");
  return useMemo(() => {
    const out = new Map<string, LegQuote>();
    unique.forEach((symbol, i) => {
      const book = books[i]?.data;
      if (!book) return;
      out.set(symbol, {
        yesBid: book.bids.length ? BigInt(Math.max(...book.bids.map((l) => l.price))) : null,
        yesAsk: book.asks.length ? BigInt(Math.min(...book.asks.map((l) => l.price))) : null,
      });
    });
    return out;
    // `stamp` changes whenever any book refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unique, stamp]);
}

export function useCombos() {
  return useQuery({
    queryKey: ["combos"],
    queryFn: () => getJson<CombosResponse>("/api/combos"),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

/** One combo from the API. `data` is null when the server does not know the symbol. */
export function useCombo(symbol: string, enabled = true) {
  return useQuery({
    queryKey: ["combo", symbol],
    enabled,
    refetchInterval: 10_000,
    queryFn: async (): Promise<Combo | null> => {
      const res = await fetch(`/api/combos/${encodeURIComponent(symbol)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      return (await res.json()) as Combo;
    },
  });
}

/** Unix seconds, ticking. 0 until mounted so server and first client render agree. */
export function useNow(intervalMs = 10_000): bigint {
  const [now, setNow] = useState(0n);
  useEffect(() => {
    const tick = () => setNow(BigInt(Math.floor(Date.now() / 1000)));
    tick();
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
