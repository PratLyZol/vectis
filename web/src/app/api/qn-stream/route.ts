// QuickNode Streams destination. The stream POSTs our contracts' logs here; they are verified,
// decoded and stored in Postgres for the activity feed and the keeper.
import { neon } from "@neondatabase/serverless";
import { NextResponse } from "next/server";
import { addresses } from "@/config/addresses";
import { decodeStreamLog, extractLogs, verifyStreamSignature, type StreamRow } from "@/lib/stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: Request) {
  const token = process.env.QN_STREAM_SECURITY_TOKEN;
  if (!token) return json({ ok: false, error: "stream token not configured" }, 503);

  // The raw body is what the signature covers, so read it before parsing.
  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) return json({ ok: false, error: "payload too large" }, 413);

  const check = verifyStreamSignature({
    nonce: req.headers.get("x-qn-nonce"),
    timestamp: req.headers.get("x-qn-timestamp"),
    signature: req.headers.get("x-qn-signature"),
    rawBody,
    token,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  if (!check.ok) return json({ ok: false, error: "invalid signature" }, 401);

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ ok: false, error: "body is not JSON" }, 400);
  }

  const logs = extractLogs(payload);
  const rows = logs
    .map((log) => decodeStreamLog(log, addresses))
    .filter((row): row is StreamRow => row !== null);
  if (rows.length === 0) return json({ ok: true, stored: 0, received: logs.length });

  const url = process.env.DATABASE_URL;
  // A non-2xx makes QuickNode retry the batch, which is what we want if rows could not be saved.
  if (!url) return json({ ok: false, error: "database not configured" }, 500);

  try {
    const sql = neon(url);
    const results = await sql.transaction(
      rows.map(
        (r) => sql`
          INSERT INTO stream_events
            (id, chain_id, block_number, tx_hash, log_index, address, event_name, position_id, owner, market_id, args)
          VALUES
            (${r.id}, ${r.chainId}, ${r.blockNumber}, ${r.txHash}, ${r.logIndex}, ${r.address}, ${r.eventName},
             ${r.positionId}::numeric, ${r.owner}, ${r.marketId}, ${JSON.stringify(r.args)}::jsonb)
          ON CONFLICT (id) DO NOTHING
          RETURNING seq`,
      ),
    );
    const stored = results.reduce((n, inserted) => n + (Array.isArray(inserted) ? inserted.length : 0), 0);
    return json({ ok: true, stored, received: logs.length });
  } catch {
    return json({ ok: false, error: "database write failed" }, 500);
  }
}
