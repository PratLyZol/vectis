import { describe, expect, it, vi } from "vitest";
import { InFlight } from "../src/inflight.js";
import {
  STREAM_BACKOFF_MS,
  StreamWatcher,
  advanceCursor,
  describeTrigger,
  resolveCursor,
  toTriggers,
  type FeedEvent,
  type FeedResponse,
  type Trigger,
} from "../src/stream.js";

const MM = "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9";
const OTHER = "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0";
const NOW = Date.parse("2026-11-15T06:00:00.000Z");

function ev(seq: number, eventName: string, positionId: string | null, over: Partial<FeedEvent> = {}): FeedEvent {
  return {
    seq,
    id: `31337:0xabc:${seq}`,
    address: MM.toLowerCase(),
    eventName,
    positionId,
    args: {},
    receivedAt: new Date(NOW - 420).toISOString(),
    ...over,
  };
}

describe("resolveCursor", () => {
  it("starts at the feed's latest when nothing is saved", () => {
    expect(resolveCursor(undefined, 345)).toEqual({ cursor: 345, reset: false });
    expect(resolveCursor(undefined, 0)).toEqual({ cursor: 0, reset: false });
  });
  it("resumes from the saved cursor when the feed is at or ahead of it", () => {
    expect(resolveCursor(300, 345)).toEqual({ cursor: 300, reset: false });
    expect(resolveCursor(345, 345)).toEqual({ cursor: 345, reset: false });
  });
  it("resets to the feed's latest when the saved cursor is ahead (database reset)", () => {
    expect(resolveCursor(900, 12)).toEqual({ cursor: 12, reset: true });
    expect(resolveCursor(900, 0)).toEqual({ cursor: 0, reset: true });
  });
  it("ignores a corrupt saved cursor", () => {
    expect(resolveCursor(Number.NaN, 7)).toEqual({ cursor: 7, reset: false });
    expect(resolveCursor(-3, 7)).toEqual({ cursor: 7, reset: false });
  });
});

describe("advanceCursor", () => {
  it("moves to the response cursor and never backwards", () => {
    expect(advanceCursor(10, { events: [ev(11, "Deposit", null), ev(12, "Deposit", null)], cursor: 12 })).toBe(12);
    expect(advanceCursor(10, { events: [], cursor: 10 })).toBe(10);
    expect(advanceCursor(10, { events: [], cursor: 4 })).toBe(10);
  });
  it("covers every seq seen even if the cursor field is missing or stale", () => {
    expect(advanceCursor(10, { events: [ev(11, "Deposit", null), ev(15, "Deposit", null)] })).toBe(15);
    expect(advanceCursor(10, { events: [ev(15, "Deposit", null)], cursor: 12 })).toBe(15);
  });
});

describe("toTriggers", () => {
  it("maps the three request events to their position ids", () => {
    const out = toTriggers(
      [ev(1, "PositionOpened", "12"), ev(2, "PositionClosed", "12"), ev(3, "PositionLiquidated", "7")],
      MM,
      NOW,
    );
    expect(out).toEqual([
      { positionId: 12n, eventName: "PositionOpened", seq: 1, lagMs: 420 },
      { positionId: 12n, eventName: "PositionClosed", seq: 2, lagMs: 420 },
      { positionId: 7n, eventName: "PositionLiquidated", seq: 3, lagMs: 420 },
    ]);
  });
  it("ignores other event names", () => {
    const names = ["FillRecorded", "PositionSettled", "Deposit", "Withdraw", "Borrowed", "Repaid"];
    expect(toTriggers(names.map((n, i) => ev(i, n, "1")), MM, NOW)).toEqual([]);
  });
  it("filters by MarginManager address, case-insensitively", () => {
    const events = [
      ev(1, "PositionOpened", "1", { address: OTHER }),
      ev(2, "PositionOpened", "2", { address: MM.toUpperCase().replace("0X", "0x") }),
      ev(3, "PositionOpened", "3", { address: MM }),
      ev(4, "PositionOpened", "4", { address: null }),
    ];
    expect(toTriggers(events, MM.toLowerCase(), NOW).map((t) => t.positionId)).toEqual([2n, 3n]);
  });
  it("falls back to args.id and skips events with no usable id", () => {
    const events = [
      ev(1, "PositionOpened", null, { args: { id: "9" } }),
      ev(2, "PositionOpened", null),
      ev(3, "PositionOpened", "abc"),
      ev(4, "PositionOpened", "-1"),
    ];
    expect(toTriggers(events, MM, NOW).map((t) => t.positionId)).toEqual([9n]);
  });
  it("reports unknown lag as null and formats the log line", () => {
    const [t] = toTriggers([ev(345, "PositionOpened", "12", { receivedAt: undefined })], MM, NOW);
    expect(t!.lagMs).toBeNull();
    expect(describeTrigger(t!)).toBe("PositionOpened #12 via QuickNode Stream (seq 345)");
    const [u] = toTriggers([ev(345, "PositionOpened", "12")], MM, NOW);
    expect(describeTrigger(u!)).toBe("PositionOpened #12 via QuickNode Stream (seq 345, +420ms)");
  });
});

/** Stub feed backed by an array, implementing the /api/activity contract. */
function stubFeed(rows: FeedEvent[], opts: { source?: string; fail?: boolean } = {}) {
  const state = { rows, source: opts.source ?? "quicknode-stream", fail: opts.fail ?? false, calls: [] as string[] };
  const fetchImpl = (async (url: string | URL | Request) => {
    const u = new URL(String(url));
    state.calls.push(u.search);
    if (state.fail) throw new Error("connect ECONNREFUSED");
    let body: FeedResponse;
    if (u.searchParams.get("latest")) {
      const last = state.rows[state.rows.length - 1];
      body = { source: state.source, events: last ? [last] : [], cursor: last?.seq ?? 0 };
    } else {
      const after = Number(u.searchParams.get("after"));
      const limit = Number(u.searchParams.get("limit"));
      const events = state.rows.filter((r) => r.seq > after).slice(0, limit);
      body = { source: state.source, events, cursor: events.length ? events[events.length - 1]!.seq : after };
    }
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { state, fetchImpl };
}

function memoryStore(initial?: number) {
  let value = initial;
  return { getStreamCursor: () => value, setStreamCursor: (c: number) => void (value = c), get value() { return value; } };
}

describe("StreamWatcher", () => {
  const make = (rows: FeedEvent[], saved?: number, opts?: { source?: string; fail?: boolean }) => {
    const feed = stubFeed(rows, opts);
    const store = memoryStore(saved);
    const triggers: Trigger[] = [];
    const w = new StreamWatcher("http://app.invalid", 1500, MM, store, (t) => triggers.push(t), feed.fetchImpl, () => NOW);
    return { ...feed, store, triggers, w };
  };

  it("starts at 'now' on first run: history is not replayed, new events are", async () => {
    const t = make([ev(1, "PositionOpened", "1"), ev(2, "PositionOpened", "2")]);
    expect(await t.w.tick()).toBe(1500);
    expect(t.triggers).toEqual([]);
    expect(t.store.value).toBe(2);
    t.state.rows.push(ev(3, "PositionClosed", "1"), ev(4, "Deposit", null), ev(5, "PositionOpened", "9", { address: OTHER }));
    await t.w.tick();
    expect(t.triggers.map((x) => `${x.eventName}#${x.positionId}`)).toEqual(["PositionClosed#1"]);
    expect(t.store.value).toBe(5); // non-trigger rows still advance the cursor
    await t.w.tick();
    expect(t.triggers).toHaveLength(1); // nothing is delivered twice
  });

  it("resumes from the saved cursor after a restart", async () => {
    const t = make([ev(1, "PositionOpened", "1"), ev(2, "PositionOpened", "2"), ev(3, "PositionOpened", "3")], 1);
    await t.w.tick();
    expect(t.triggers.map((x) => x.positionId)).toEqual([2n, 3n]);
    expect(t.store.value).toBe(3);
  });

  it("resets when the saved cursor is ahead of the feed", async () => {
    const t = make([ev(1, "PositionOpened", "1")], 500);
    await t.w.tick();
    expect(t.store.value).toBe(1);
    expect(t.triggers).toEqual([]);
    t.state.rows.push(ev(2, "PositionOpened", "2"));
    await t.w.tick();
    expect(t.triggers.map((x) => x.positionId)).toEqual([2n]);
  });

  it("drains more than one page in a single tick", async () => {
    const rows = Array.from({ length: 450 }, (_, i) => ev(i + 1, "PositionOpened", String(i + 1)));
    const t = make(rows, 0);
    // saved cursor 0 is valid: replay from the start
    await t.w.tick();
    expect(t.triggers).toHaveLength(450);
    expect(t.store.value).toBe(450);
  });

  it("backs off when the feed errors or reports no source, and recovers", async () => {
    const t = make([ev(1, "PositionOpened", "1")], undefined, { fail: true });
    expect(await t.w.tick()).toBe(STREAM_BACKOFF_MS);
    expect(t.w.isLive).toBe(false);
    t.state.fail = false;
    t.state.source = "none";
    expect(await t.w.tick()).toBe(STREAM_BACKOFF_MS);
    expect(t.w.isLive).toBe(false);
    t.state.source = "quicknode-stream";
    expect(await t.w.tick()).toBe(1500);
    expect(t.w.isLive).toBe(true);
    t.state.rows.push(ev(2, "PositionOpened", "2"));
    await t.w.tick();
    expect(t.triggers.map((x) => x.positionId)).toEqual([2n]);
  });

  it("logs availability once per state change, not once per poll", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const t = make([], undefined, { fail: true });
      await t.w.tick();
      await t.w.tick();
      await t.w.tick();
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("stream feed unavailable"))).toHaveLength(1);
      t.state.fail = false;
      await t.w.tick();
      await t.w.tick();
      expect(info.mock.calls.filter((c) => String(c[0]).includes("stream feed live"))).toHaveLength(1);
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });

  it("survives a handler that throws", async () => {
    const feed = stubFeed([ev(1, "PositionOpened", "1"), ev(2, "PositionOpened", "2")]);
    const store = memoryStore(0);
    const seen: bigint[] = [];
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const w = new StreamWatcher("http://app.invalid", 1500, MM, store, (t) => {
      seen.push(t.positionId);
      throw new Error("boom");
    }, feed.fetchImpl, () => NOW);
    expect(await w.tick()).toBe(1500);
    err.mockRestore();
    expect(seen).toEqual([1n, 2n]);
    expect(store.value).toBe(2);
  });
});

describe("InFlight", () => {
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  };

  it("never runs the same key concurrently and folds duplicates into one re-run", async () => {
    const guard = new InFlight();
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    const gates = [deferred(), deferred()];
    const fn = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      const gate = gates[runs++];
      await gate?.promise;
      active--;
    };
    const first = guard.run("12", fn); // e.g. stream path
    const second = guard.run("12", fn); // e.g. getLogs path, same event
    const third = guard.run("12", fn);
    expect(await second).toBe(false);
    expect(await third).toBe(false);
    expect(runs).toBe(1);
    gates[0]!.resolve();
    await Promise.resolve();
    await Promise.resolve();
    gates[1]!.resolve();
    expect(await first).toBe(true);
    expect(runs).toBe(2); // exactly one re-read for the two folded calls
    expect(maxActive).toBe(1);
    expect(guard.has("12")).toBe(false);
  });

  it("runs different keys independently", async () => {
    const guard = new InFlight();
    const gate = deferred();
    const order: string[] = [];
    const a = guard.run("1", async () => {
      await gate.promise;
      order.push("a");
    });
    const b = guard.run("2", async () => void order.push("b"));
    expect(await b).toBe(true);
    gate.resolve();
    expect(await a).toBe(true);
    expect(order).toEqual(["b", "a"]);
  });

  it("releases the key when the handler throws", async () => {
    const guard = new InFlight();
    await expect(guard.run("1", async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(guard.has("1")).toBe(false);
    expect(await guard.run("1", async () => undefined)).toBe(true);
  });
});
