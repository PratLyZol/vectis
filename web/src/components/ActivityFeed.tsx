"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isMock } from "@/config/contracts";
import { useMarketMeta, useWallet } from "@/hooks/useChain";
import { useNow } from "@/hooks/useMarketData";
import { describeActivity, relativeTime, type ActivityEvent, type ActivityResponse } from "@/lib/activity";
import { useDemoState } from "@/lib/demoStore";
import { shortHash } from "@/lib/format";

const EXPLORER_TX = "https://explorer.testnet.arc.io/tx/";
const ROWS = 20;
// wagmi contract reads and the settled-log query: what a new on-chain event makes stale.
const CHAIN_KEYS = new Set(["readContract", "readContracts", "settled"]);

/**
 * Recent contract events. Live mode reads the rows QuickNode Streams delivered to /api/activity;
 * demo mode lists the demo store's own actions. Nothing here is invented.
 */
export function ActivityFeed({ scope, heading }: { scope: "all" | "mine"; heading: string }) {
  const { address } = useWallet();
  const demoState = useDemoState();
  const meta = useMarketMeta();
  const queryClient = useQueryClient();
  const now = useNow(5_000);

  const owner = scope === "mine" ? address : undefined;
  const enabled = !isMock && (scope === "all" || Boolean(address));
  // The interval stops while the tab is hidden (react-query's default) and resumes on return.
  const { data } = useQuery({
    queryKey: ["activity", scope, owner ?? null],
    enabled,
    refetchInterval: 3_000,
    staleTime: 0,
    queryFn: async (): Promise<ActivityResponse> => {
      const params = new URLSearchParams({ latest: "1", limit: String(ROWS) });
      if (owner) params.set("owner", owner);
      const res = await fetch(`/api/activity?${params}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      return (await res.json()) as ActivityResponse;
    },
  });

  // A new row means the chain moved: refresh positions, balances and vault figures at once
  // rather than waiting for their own polling interval.
  const seen = useRef<number | null>(null);
  useEffect(() => {
    if (!data || data.source !== "quicknode-stream") return;
    const previous = seen.current;
    seen.current = data.cursor;
    if (previous !== null && data.cursor > previous) {
      void queryClient.invalidateQueries({ predicate: (q) => CHAIN_KEYS.has(String(q.queryKey[0])) });
    }
  }, [data, queryClient]);

  const live = !isMock && data?.source === "quicknode-stream";
  const events: ActivityEvent[] = isMock ? demoState.activity.slice(0, ROWS) : live ? (data?.events ?? []) : [];
  const headingId = `activity-${scope}`;

  // Rows that were recorded before this list was opened are simply there. Rows recorded after
  // it fade in, so a new event is noticed.
  const [openedAt] = useState(() => Date.now());
  const isNew = (e: ActivityEvent) => Date.parse(e.receivedAt) > openedAt;

  return (
    <section className="card p-4 md:p-5" aria-labelledby={headingId}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id={headingId} className="text-[17px]">
          {heading}
        </h2>
        <p className="text-[12px] text-muted">
          {isMock ? (
            "Demo actions in this browser"
          ) : live ? (
            <>
              <span aria-hidden="true" className="mr-1.5 inline-block size-1.5 rounded-full bg-accent align-middle" />
              Live from QuickNode Streams
            </>
          ) : null}
        </p>
      </div>

      {events.length === 0 ? (
        <p className="mt-3 text-[13px] text-muted">
          {isMock
            ? "Nothing yet. Open a position or deposit in the vault and it is listed here."
            : !enabled
              ? "Connect a wallet to see your activity."
              : data === undefined
                ? "Loading activity…"
                : live
                  ? "No contract events have arrived yet."
                  : "The event stream is not connected, so there is no activity to show."}
        </p>
      ) : (
        <ol className="m-0 mt-2 max-h-[264px] list-none overflow-y-auto p-0 lg:max-h-[min(560px,calc(100dvh-200px))]">
          {events.map((e) => {
            const market = e.marketId ? meta[e.marketId] : undefined;
            const where = [e.positionId !== null ? `Position #${e.positionId}` : null, (market?.kind === "combo" ? market.title : market?.label) ?? null]
              .filter(Boolean)
              .join(" · ");
            return (
              <li
                key={e.id}
                className={`border-t border-border py-2.5 first:border-t-0 ${isNew(e) ? "row-new" : ""}`}
              >
                <p className="text-[13px] text-text">{describeActivity(e.eventName, e.args)}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-muted">
                  {where ? <span className="min-w-0 truncate">{where}</span> : null}
                  <time dateTime={e.receivedAt} className="num">
                    {now > 0n ? relativeTime(e.receivedAt, Number(now) * 1000) : ""}
                  </time>
                  {e.txHash ? (
                    <a
                      className="link link-tap num ml-auto"
                      href={`${EXPLORER_TX}${e.txHash}`}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Transaction ${shortHash(e.txHash)} on the Arc explorer`}
                    >
                      {shortHash(e.txHash)}
                    </a>
                  ) : null}
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
