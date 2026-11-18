// Contract events delivered by QuickNode Streams, read back for the activity feed and the keeper.
import { neon } from "@neondatabase/serverless";
import { NextResponse, type NextRequest } from "next/server";
import { contracts, isMock } from "@/config/contracts";
import type { ActivityEvent, ActivityResponse } from "@/lib/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const respond = (body: ActivityResponse) =>
  NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });

const clampInt = (v: string | null, fallback: number, min: number, max: number) => {
  if (v === null || !/^\d{1,15}$/.test(v)) return fallback;
  return Math.min(max, Math.max(min, Number(v)));
};

type Row = {
  seq: string | number;
  id: string;
  block_number: string | number;
  tx_hash: string;
  log_index: number;
  address: string;
  event_name: string;
  position_id: string | null;
  owner: string | null;
  market_id: string | null;
  args: Record<string, unknown> | null;
  received_at: string | Date;
};

const toEvent = (r: Row): ActivityEvent => ({
  seq: Number(r.seq),
  id: r.id,
  blockNumber: Number(r.block_number),
  txHash: r.tx_hash,
  logIndex: Number(r.log_index),
  address: r.address,
  eventName: r.event_name,
  positionId: r.position_id === null ? null : String(r.position_id),
  owner: r.owner,
  marketId: r.market_id,
  args: r.args ?? {},
  receivedAt: new Date(r.received_at).toISOString(),
});

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const after = clampInt(sp.get("after"), 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = clampInt(sp.get("limit"), 50, 1, 200);
  const latest = sp.get("latest") === "1";
  const ownerParam = sp.get("owner");
  const owner = ownerParam && /^0x[0-9a-fA-F]{40}$/.test(ownerParam) ? ownerParam.toLowerCase() : null;
  const none: ActivityResponse = { source: "none", events: [], cursor: after };

  const url = process.env.DATABASE_URL;
  // Nothing is deployed yet (zero addresses), a malformed owner, or no database: no events.
  if (!url || isMock || (ownerParam && !owner)) return respond(none);

  // Only the current deployment's contracts, so a redeploy never shows stale events.
  const sources = [contracts.marginManager.toLowerCase(), contracts.lendingVault.toLowerCase()];

  try {
    const sql = neon(url);
    // Fill, liquidation and settlement events carry no owner, so an owner filter also takes every
    // event of the positions that owner opened.
    const rows = (
      latest
        ? await sql`
            SELECT seq, id, block_number, tx_hash, log_index, address, event_name, position_id, owner, market_id, args, received_at
            FROM stream_events e
            WHERE e.address = ANY(${sources})
              AND (${owner}::text IS NULL OR e.owner = ${owner} OR (e.position_id IS NOT NULL AND e.position_id IN (
                SELECT o.position_id FROM stream_events o
                WHERE o.owner = ${owner} AND o.event_name = 'PositionOpened' AND o.address = ANY(${sources}))))
            ORDER BY e.seq DESC
            LIMIT ${limit}`
        : await sql`
            SELECT seq, id, block_number, tx_hash, log_index, address, event_name, position_id, owner, market_id, args, received_at
            FROM stream_events e
            WHERE e.address = ANY(${sources})
              AND e.seq > ${after}
              AND (${owner}::text IS NULL OR e.owner = ${owner} OR (e.position_id IS NOT NULL AND e.position_id IN (
                SELECT o.position_id FROM stream_events o
                WHERE o.owner = ${owner} AND o.event_name = 'PositionOpened' AND o.address = ANY(${sources}))))
            ORDER BY e.seq ASC
            LIMIT ${limit}`
    ) as Row[];
    const events = rows.map(toEvent);
    const cursor = events.reduce((max, e) => (e.seq > max ? e.seq : max), after);
    return respond({ source: "quicknode-stream", events, cursor });
  } catch {
    return respond(none);
  }
}
