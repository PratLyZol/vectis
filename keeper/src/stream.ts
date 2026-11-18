// QuickNode Streams trigger path. A QuickNode stream posts our contracts' logs to the web app,
// which exposes them as a feed; the keeper polls that feed and hands open / close / liquidate
// requests to the same idempotent handler the RPC getLogs path uses. The RPC paths keep running,
// so this module only ever makes the keeper faster, never a dependency.
import { errText, logger } from "./log.js";

const log = logger("stream");

export const STREAM_TIMEOUT_MS = 3000;
export const STREAM_BACKOFF_MS = 10_000;
export const STREAM_PAGE = 200;
const RESYNC_EVERY_MS = 60_000;

export const TRIGGER_EVENTS = ["PositionOpened", "PositionClosed", "PositionLiquidated"] as const;
export type TriggerEvent = (typeof TRIGGER_EVENTS)[number];

export interface FeedEvent {
  seq: number;
  id?: string;
  blockNumber?: number;
  txHash?: string;
  logIndex?: number;
  address?: string | null;
  eventName?: string;
  positionId?: string | null;
  owner?: string | null;
  marketId?: string | null;
  args?: Record<string, unknown> | null;
  receivedAt?: string;
}

export interface FeedResponse {
  source?: string;
  events?: FeedEvent[];
  cursor?: number;
}

export interface Trigger {
  positionId: bigint;
  eventName: TriggerEvent;
  seq: number;
  /** Milliseconds between the webhook receiving the log and the keeper seeing it; null if unknown. */
  lagMs: number | null;
}

export interface CursorStore {
  getStreamCursor(): number | undefined;
  setStreamCursor(cursor: number): void;
}

const isSeq = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/**
 * Cursor to start from, given what was saved and the feed's newest seq (0 when the feed is empty).
 * Nothing saved: start at "now" so history is not replayed. Saved cursor ahead of the feed: the
 * feed's database was reset, so fall back to its latest.
 */
export function resolveCursor(stored: number | undefined, feedLatest: number): { cursor: number; reset: boolean } {
  if (!isSeq(stored)) return { cursor: feedLatest, reset: false };
  if (stored > feedLatest) return { cursor: feedLatest, reset: true };
  return { cursor: stored, reset: false };
}

/** Cursor after a page: never moves backwards, and covers every seq seen even if `cursor` is missing. */
export function advanceCursor(current: number, res: FeedResponse): number {
  let next = current;
  if (isSeq(res.cursor) && res.cursor > next) next = res.cursor;
  for (const ev of res.events ?? []) if (isSeq(ev?.seq) && ev.seq > next) next = ev.seq;
  return next;
}

/** Feed events that should trigger execution: the three request events, from our MarginManager only. */
export function toTriggers(events: FeedEvent[], marginManager: string, nowMs: number): Trigger[] {
  const mm = marginManager.toLowerCase();
  const out: Trigger[] = [];
  for (const ev of events) {
    if (!ev || typeof ev.address !== "string" || ev.address.toLowerCase() !== mm) continue;
    if (!(TRIGGER_EVENTS as readonly string[]).includes(ev.eventName ?? "")) continue;
    const rawId = ev.positionId ?? (ev.args as { id?: unknown } | null | undefined)?.id;
    if ((typeof rawId !== "string" && typeof rawId !== "number") || !/^\d+$/.test(String(rawId))) continue;
    const received = ev.receivedAt ? Date.parse(ev.receivedAt) : NaN;
    out.push({
      positionId: BigInt(rawId),
      eventName: ev.eventName as TriggerEvent,
      seq: ev.seq,
      lagMs: Number.isFinite(received) ? Math.max(0, nowMs - received) : null,
    });
  }
  return out;
}

export function describeTrigger(t: Trigger): string {
  const lag = t.lagMs === null ? "" : `, +${t.lagMs}ms`;
  return `${t.eventName} #${t.positionId} via QuickNode Stream (seq ${t.seq}${lag})`;
}

export class StreamWatcher {
  private cursor: number | null = null;
  private live: boolean | null = null; // null = not yet known, so the first state is always logged
  private needsSync = true;
  private lastSyncAt = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly pollMs: number,
    private readonly marginManager: string,
    private readonly store: CursorStore,
    private readonly onTrigger: (t: Trigger) => void,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  get isLive(): boolean {
    return this.live === true;
  }

  get position(): number | null {
    return this.cursor;
  }

  private async get(query: string): Promise<FeedResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/activity?${query}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as FeedResponse;
    if (!body || typeof body !== "object" || !Array.isArray(body.events)) throw new Error("malformed feed response");
    return body;
  }

  /** Align the cursor with the feed: initialise to "now", or reset if the feed went backwards. */
  private async sync(): Promise<FeedResponse> {
    const latest = await this.get("latest=1&limit=1");
    const feedLatest = advanceCursor(0, { events: latest.events });
    const stored = this.cursor ?? this.store.getStreamCursor();
    const { cursor, reset } = resolveCursor(stored, feedLatest);
    if (reset) log.warn("feed is behind the saved cursor (database reset?); resetting", { saved: stored, feedLatest });
    if (cursor !== this.cursor) {
      this.cursor = cursor;
      this.store.setStreamCursor(cursor);
    }
    this.needsSync = false;
    this.lastSyncAt = this.now();
    return latest;
  }

  private setLive(live: boolean, why?: string): void {
    if (this.live === live) return;
    this.live = live;
    if (live) log.info("stream feed live", { cursor: this.cursor ?? undefined });
    else log.warn("stream feed unavailable, using RPC polling", { why });
    if (!live) this.needsSync = true; // re-check for a reset once it comes back
  }

  /** One poll. Returns how long to wait before the next one. Never throws. */
  async tick(): Promise<number> {
    try {
      if (this.needsSync || this.cursor === null || this.now() - this.lastSyncAt >= RESYNC_EVERY_MS) {
        const latest = await this.sync();
        if (latest.source === "none") {
          this.setLive(false, 'feed source is "none"');
          return STREAM_BACKOFF_MS;
        }
      }
      // Drain full pages at once so a burst does not wait a poll interval per page.
      for (let page = 0; page < 10; page++) {
        const res = await this.get(`after=${this.cursor}&limit=${STREAM_PAGE}`);
        if (res.source === "none") {
          this.setLive(false, 'feed source is "none"');
          return STREAM_BACKOFF_MS;
        }
        this.setLive(true);
        const events = res.events ?? [];
        for (const t of toTriggers(events, this.marginManager, this.now())) {
          log.info(describeTrigger(t));
          try {
            this.onTrigger(t);
          } catch (err) {
            log.error("trigger handler threw", { id: t.positionId, err: errText(err) });
          }
        }
        const next = advanceCursor(this.cursor!, res);
        if (next !== this.cursor) {
          this.cursor = next;
          this.store.setStreamCursor(next);
        }
        if (events.length < STREAM_PAGE) break;
      }
      return this.pollMs;
    } catch (err) {
      this.setLive(false, errText(err, 120));
      return STREAM_BACKOFF_MS;
    }
  }
}
