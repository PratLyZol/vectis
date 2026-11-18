"use client";

// Replays a hypothetical leveraged position on a market's real Gemini price history: the price
// plays forward bar by bar, the PnL steps alongside it, and the run ends when the position is
// liquidated or the history runs out. The position is computed by lib/replay with the contract
// rules; this file only draws it.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { fmtCents, fmtLeverage, fmtPrice, fmtSignedUsd, fmtUsdc } from "@/lib/format";
import { SIDE_YES, type Side } from "@/lib/math";
import {
  findScenario,
  sideBar,
  simulate,
  type CandlesResponse,
  type ReplayMarket,
  type Scenario,
  type Sim,
  type SideBar,
} from "@/lib/replay";
import { SideToggle } from "./SideToggle";
import { token, type Rgb } from "./TileField";

const MARGIN = 100_000_000n; // 100 USDC, hypothetical
const LEVERAGE_STEPS = [10, 15, 20, 30, 40, 50];
const PLAY_MS = 14_000; // a full history at normal speed
const PULSE_MS = 900;
const GUTTER = 54; // price axis
const PNL_H = 70;
const SHOCK = 50_000; // a move of 5 cents within one bar is announced
const FLASH_MS = 1_400; // how long an announcement holds before it leaves

type Phase = "idle" | "playing" | "paused" | "done";
/** An event announcing itself over the chart: the chart takes a wash and the label floats up. */
type Flash = {
  id: number;
  text: string;
  sub: string;
  tone: "up" | "down";
  strong: boolean;
  /** `enter` for a frame so the transition has a start, then `shown`, then `out`. */
  phase: "enter" | "shown" | "out";
};
type View = { bars: SideBar[]; sim: Sim | null; phase: Phase; side: Side };

const rgba = ([r, g, b]: Rgb, a = 1) => `rgba(${r},${g},${b},${a})`;
const pctOfMargin = (v: bigint) => {
  const p = Number((v * 10_000n) / MARGIN) / 100;
  return `${p > 0 ? "+" : p < 0 ? "-" : ""}${Math.abs(p).toFixed(Math.abs(p) >= 100 ? 0 : 1)}%`;
};
const clock = (t: number) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function PositionReplay({ markets, initialSymbol }: { markets: ReplayMarket[]; initialSymbol: string }) {
  const uid = useId();
  const [symbol, setSymbol] = useState(initialSymbol);
  const [data, setData] = useState<CandlesResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [side, setSide] = useState<Side>(SIDE_YES);
  const [leverage, setLeverage] = useState(30);
  const [entryIndex, setEntryIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [cursor, setCursor] = useState(0);
  const [fast, setFast] = useState(false);
  const [flashes, setFlashes] = useState<Flash[]>([]);
  const flashSeq = useRef(0);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef<() => void>(() => {});
  const viewRef = useRef<View>({ bars: [], sim: null, phase: "idle", side: SIDE_YES });
  const playhead = useRef(0);
  const rate = useRef(0); // bars per millisecond
  const doneAt = useRef(0);
  const fastRef = useRef(false);

  const market = markets.find((m) => m.symbol === symbol);
  const candles = useMemo(() => (data?.symbol === symbol ? data.candles : []), [data, symbol]);
  const bars = useMemo(() => candles.map((c) => sideBar(c, side)), [candles, side]);
  const sim = useMemo(
    () => (candles.length > 1 ? simulate(candles, side, BigInt(leverage), entryIndex, MARGIN) : null),
    [candles, side, leverage, entryIndex],
  );
  const scenarios = useMemo(
    () => ({ gain: findScenario(candles, "gain", MARGIN), liquidation: findScenario(candles, "liquidation", MARGIN) }),
    [candles],
  );

  // Load the history, then set up the most telling entry it has.
  useEffect(() => {
    const abort = new AbortController();
    fetch(`/api/candles/${encodeURIComponent(symbol)}`, { signal: abort.signal })
      .then((r) => (r.ok ? (r.json() as Promise<CandlesResponse>) : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        const first = findScenario(d.candles, "gain", MARGIN) ?? findScenario(d.candles, "liquidation", MARGIN);
        setData(d);
        setFailed(false);
        setSide(first?.side ?? SIDE_YES);
        setLeverage(first ? Number(first.leverage) : 30);
        setEntryIndex(first?.entryIndex ?? Math.floor(d.candles.length * 0.1));
        setPhase("idle");
      })
      .catch((e: unknown) => {
        if (!abort.signal.aborted) setFailed(Boolean(e));
      });
    return () => abort.abort();
  }, [symbol]);

  // A new announcement pushes the previous one out, so a fast run of events never stacks labels.
  const flash = useCallback((f: Omit<Flash, "id" | "phase">) => {
    const id = (flashSeq.current += 1);
    setFlashes((held) => [
      ...held.filter((x) => x.phase !== "enter").slice(-3).map((x) => ({ ...x, phase: "out" as const })),
      { ...f, id, phase: "enter" },
    ]);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => setFlashes((held) => held.map((x) => (x.id === id && x.phase === "enter" ? { ...x, phase: "shown" } : x)))),
    );
    window.setTimeout(() => setFlashes((held) => held.map((x) => (x.id === id ? { ...x, phase: "out" } : x))), FLASH_MS);
  }, []);

  /** Announce what happened in bars (from, to]: the entry, the biggest shock move, or the ending. */
  const announce = useCallback(
    (from: number, to: number, ended: boolean) => {
      const { bars: b, sim: s } = viewRef.current;
      if (!s) return;
      const sideName = s.side === SIDE_YES ? "YES" : "NO";
      if (ended) {
        flash({
          text: `${s.outcome === "liquidated" ? "LIQUIDATED" : "SOLD"} ${fmtSignedUsd(s.pnl)}`,
          sub: `at ${fmtCents(Number(s.exitPrice))}`,
          tone: s.pnl >= 0n ? "up" : "down",
          strong: true,
        });
        return;
      }
      let best: Omit<Flash, "id" | "phase"> | null = null;
      let bestMove = 0;
      for (let i = from + 1; i <= to; i++) {
        if (i === s.entryIndex) {
          best = { text: `BUY ${sideName} ${fmtLeverage(s.leverage)}`, sub: `at ${fmtCents(Number(s.open.refPrice))}`, tone: "up", strong: false };
          bestMove = Infinity;
          continue;
        }
        const now = b[i];
        const prev = b[i - 1];
        const a = s.steps[i];
        const z = s.steps[i - 1];
        if (i < s.entryIndex || !now || !prev || !a || !z) continue;
        const move = now.close - prev.close;
        if (Math.abs(move) < SHOCK || Math.abs(move) <= bestMove) continue;
        bestMove = Math.abs(move);
        best = {
          text: `${move > 0 ? "+" : "-"}${fmtCents(Math.abs(move))} IN A MINUTE`,
          sub: `PnL ${fmtSignedUsd(a.pnl - z.pnl)}`,
          tone: move > 0 ? "up" : "down",
          strong: false,
        };
      }
      if (best) flash(best);
    },
    [flash],
  );

  const start = useCallback(
    (entry: number) => {
      const n = candles.length;
      if (n < 2) return;
      const from = Math.max(0, entry - Math.max(3, Math.floor(n * 0.06)));
      playhead.current = from;
      rate.current = Math.max(1, n - 1 - from) / PLAY_MS;
      setCursor(from);
      setFlashes([]);
      // Reduced motion: show the result without the run.
      const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      setPhase(still ? "done" : "playing");
      // An entry on the first bar is never crossed by the playhead, so it is announced here.
      if (!still && from === entry) requestAnimationFrame(() => announce(entry - 1, entry, false));
    },
    [candles.length, announce],
  );

  const apply = (s: Scenario) => {
    setSide(s.side);
    setLeverage(Number(s.leverage));
    setEntryIndex(s.entryIndex);
    start(s.entryIndex);
  };

  const moveEntry = (i: number) => {
    setEntryIndex(Math.min(Math.max(0, i), Math.max(0, candles.length - 2)));
    setPhase("idle");
  };

  // The canvas: set up once, redrawn from viewRef.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const cText = token("--color-text", [255, 255, 255]);
    const cMuted = token("--color-muted", [128, 128, 128]);
    const cLine = token("--color-border", [34, 34, 34]);
    const cLine2 = token("--color-border-2", [51, 51, 51]);
    const cGround = token("--color-surface", [10, 10, 10]);
    const cLiq = token("--color-danger", [166, 166, 166]);
    const font = `11px ${getComputedStyle(canvas).fontFamily}`;
    let width = 0;
    let height = 0;

    const draw = () => {
      const { bars: b, sim: s, phase: ph } = viewRef.current;
      ctx.clearRect(0, 0, width, height);
      const n = b.length;
      if (n < 2 || width === 0) return;

      const plotW = width - GUTTER;
      const priceH = height - PNL_H - 16;
      const bw = plotW / n;
      const liq = s ? Number(s.open.liqPrice) : 0;
      let lo = Infinity;
      let hi = -Infinity;
      for (const bar of b) {
        if (bar.low < lo) lo = bar.low;
        if (bar.high > hi) hi = bar.high;
      }
      if (liq > 0) lo = Math.min(lo, liq);
      lo = Math.max(0, lo - 50_000);
      hi = Math.min(1_000_000, hi + 50_000);
      const x = (i: number) => (i + 0.5) * bw;
      const y = (p: number) => 8 + (1 - (p - lo) / (hi - lo)) * (priceH - 16);
      const snap = (v: number) => Math.round(v) + 0.5;

      // Price grid and axis.
      const span = hi - lo;
      const tick = span > 500_000 ? 250_000 : span > 200_000 ? 100_000 : 50_000;
      ctx.font = font;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      for (let p = Math.ceil(lo / tick) * tick; p <= hi; p += tick) {
        ctx.strokeStyle = rgba(cLine);
        ctx.beginPath();
        ctx.moveTo(0, snap(y(p)));
        ctx.lineTo(plotW, snap(y(p)));
        ctx.stroke();
        ctx.fillStyle = rgba(cMuted);
        ctx.fillText(fmtCents(p), plotW + 8, y(p));
      }

      const entry = s?.entryIndex ?? 0;
      const end = s?.endIndex ?? n - 1;
      const head = ph === "idle" ? n - 1 : ph === "done" ? end : Math.min(Math.floor(playhead.current), end);

      // A stepped line through the closes of bars [from, to].
      const path = (from: number, to: number, colour: string, w: number) => {
        if (to < from) return;
        ctx.strokeStyle = colour;
        ctx.lineWidth = w;
        ctx.beginPath();
        for (let i = from; i <= to; i++) {
          const bar = b[i];
          if (!bar) continue;
          const py = y(bar.close);
          if (i === from) ctx.moveTo(x(i) - bw / 2, py);
          else ctx.lineTo(x(i) - bw / 2, py);
          ctx.lineTo(x(i) + bw / 2, py);
        }
        ctx.stroke();
      };

      // Liquidation zone, from the entry to the right edge.
      if (s && liq > 0) {
        const pulse = ph === "done" && s.outcome === "liquidated" ? Math.max(0, 1 - (performance.now() - doneAt.current) / PULSE_MS) : 0;
        ctx.fillStyle = rgba(cLiq, 0.07 + 0.25 * pulse);
        ctx.fillRect(x(entry), y(liq), plotW - x(entry), priceH - y(liq));
        ctx.strokeStyle = rgba(cLiq);
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(x(entry), snap(y(liq)));
        ctx.lineTo(plotW, snap(y(liq)));
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = rgba(cLiq);
        ctx.textAlign = "right";
        ctx.fillText(`Liquidation ${fmtCents(liq)}`, plotW - 6, y(liq) + (y(liq) > priceH - 22 ? -9 : 10));
      }

      if (ph === "idle") {
        path(0, n - 1, rgba(cMuted, 0.8), 1);
      } else {
        path(0, Math.min(head, entry), rgba(cMuted, 0.8), 1);
        if (head >= entry) path(entry, head, rgba(cText), 2);
        if (ph === "done") path(end, n - 1, rgba(cMuted, 0.45), 1); // what the market did afterwards
      }

      // A boxed label that stays inside the plot.
      const tag = (text: string, tx: number, ty: number, solid: boolean) => {
        const w = ctx.measureText(text).width + 12;
        const left = Math.min(Math.max(2, tx), plotW - w - 2);
        const top = Math.min(Math.max(2, ty), priceH - 20);
        ctx.fillStyle = solid ? rgba(cText) : rgba(cGround, 0.92);
        ctx.fillRect(left, top, w, 18);
        if (!solid) {
          ctx.strokeStyle = rgba(cLine2);
          ctx.lineWidth = 1;
          ctx.strokeRect(left + 0.5, top + 0.5, w - 1, 17);
        }
        ctx.fillStyle = solid ? rgba(cGround) : rgba(cText);
        ctx.textAlign = "left";
        ctx.fillText(text, left + 6, top + 9.5);
      };

      if (s && head >= entry) {
        const entryPrice = Number(s.open.refPrice);
        const ex = x(entry);
        const ey = y(entryPrice);
        ctx.strokeStyle = rgba(cLine2);
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(snap(ex), 0);
        ctx.lineTo(snap(ex), height);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = rgba(cText);
        ctx.fillRect(Math.round(ex) - 4, Math.round(ey) - 4, 8, 8);
        tag(`Buy ${s.side === SIDE_YES ? "Yes" : "No"} ${fmtLeverage(s.leverage)} at ${fmtCents(entryPrice)}`, ex + 10, ey - 28, false);

        if (ph !== "idle") {
          const now = b[head];
          const price = ph === "done" ? Number(s.exitPrice) : (now?.close ?? entryPrice);
          const hx = x(head);
          const hy = y(price);
          if (ph === "done") {
            ctx.strokeStyle = rgba(cText);
            ctx.lineWidth = 1;
            ctx.strokeRect(Math.round(hx) - 7.5, Math.round(hy) - 7.5, 15, 15);
            tag(`${s.outcome === "liquidated" ? "Liquidated" : "Sold"} at ${fmtCents(price)}`, hx - 60, hy + 14, true);
          }
          ctx.fillStyle = rgba(cText);
          ctx.fillRect(Math.round(hx) - 3, Math.round(hy) - 3, 6, 6);
          // Current price on the axis.
          ctx.fillRect(plotW + 2, hy - 9, GUTTER - 2, 18);
          ctx.fillStyle = rgba(cGround);
          ctx.textAlign = "left";
          ctx.fillText(fmtCents(price), plotW + 8, hy + 0.5);
        }
      }

      // PnL pane: leveraged against 1x, around a zero line.
      const top = priceH + 16;
      const mid = top + PNL_H / 2;
      ctx.strokeStyle = rgba(cLine);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, snap(top - 8));
      ctx.lineTo(width, snap(top - 8));
      ctx.moveTo(0, snap(mid));
      ctx.lineTo(plotW, snap(mid));
      ctx.stroke();
      ctx.fillStyle = rgba(cMuted);
      ctx.textAlign = "left";
      ctx.fillText("PnL", plotW + 8, top + 6);
      ctx.fillText("$0", plotW + 8, mid);
      if (s && ph !== "idle" && head >= entry) {
        let peak = 1;
        for (let i = entry; i <= end; i++) {
          const st = s.steps[i];
          if (st) peak = Math.max(peak, Math.abs(Number(st.pnl)), Math.abs(Number(st.pnl1x)));
        }
        const py = (v: bigint) => mid - (Number(v) / peak) * (PNL_H / 2 - 4);
        const curve = (pick: (i: number) => bigint, colour: string, w: number, fill: boolean) => {
          ctx.beginPath();
          ctx.moveTo(x(entry) - bw / 2, mid);
          for (let i = entry; i <= head; i++) {
            ctx.lineTo(x(i) - bw / 2, py(pick(i)));
            ctx.lineTo(x(i) + bw / 2, py(pick(i)));
          }
          if (fill) {
            ctx.lineTo(x(head) + bw / 2, mid);
            ctx.closePath();
            ctx.fillStyle = rgba(cText, 0.12);
            ctx.fill();
            return;
          }
          ctx.strokeStyle = colour;
          ctx.lineWidth = w;
          ctx.stroke();
        };
        curve((i) => s.steps[i]?.pnl ?? 0n, "", 0, true);
        curve((i) => s.steps[i]?.pnl1x ?? 0n, rgba(cMuted), 1, false);
        curve((i) => s.steps[i]?.pnl ?? 0n, rgba(cText), 1.5, false);
      }
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const box = canvas.getBoundingClientRect();
      width = Math.round(box.width);
      height = Math.round(box.height);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    };
    drawRef.current = draw;
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  // Keep the canvas in step with React state.
  useEffect(() => {
    viewRef.current = { bars, sim, phase, side };
    fastRef.current = fast;
    drawRef.current();
  });

  // The run: advance the playhead until the position ends.
  useEffect(() => {
    if (phase !== "playing") return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(50, now - last); // a hidden tab does not skip ahead
      last = now;
      const end = viewRef.current.sim?.endIndex ?? 0;
      const before = Math.floor(playhead.current);
      playhead.current += dt * rate.current * (fastRef.current ? 3 : 1);
      if (playhead.current >= end) {
        playhead.current = end;
        setCursor(end);
        announce(before, end, true);
        setPhase("done");
        return;
      }
      const bar = Math.floor(playhead.current);
      if (bar > before) announce(before, bar, false);
      setCursor(bar);
      drawRef.current();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [phase, announce]);

  // After a liquidation the zone flashes once.
  useEffect(() => {
    if (phase !== "done") return;
    doneAt.current = performance.now();
    let frame = 0;
    const tick = () => {
      drawRef.current();
      if (performance.now() - doneAt.current < PULSE_MS) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [phase]);

  const onChartClick = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const plotW = box.width - GUTTER;
    if (candles.length < 2 || plotW <= 0) return;
    moveEntry(Math.floor(((e.clientX - box.left) / plotW) * candles.length));
  };

  const shown = phase === "idle" ? entryIndex : phase === "done" ? (sim?.endIndex ?? 0) : Math.max(cursor, 0);
  const step = sim?.steps[shown];
  const maxLev = sim ? Number(sim.maxLeverage) : 10;
  const lev = sim ? Number(sim.leverage) : leverage;
  const chips = [...new Set([...LEVERAGE_STEPS.filter((l) => l < maxLev), maxLev])];
  const entryBar = bars[entryIndex];
  const lastStep = sim?.steps[sim.steps.length - 1];
  const status =
    !step || step.status === "before" ? "Before entry" : step.status === "open" ? "Open" : step.status === "liquidated" ? "Liquidated" : "Sold";

  return (
    <div className="card mt-8 p-5 md:p-6">
      <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)] lg:gap-8">
        <div className="flex min-w-0 flex-col gap-5">
          <div>
            <label className="label" htmlFor={`${uid}-market`}>
              Market
            </label>
            <select
              id={`${uid}-market`}
              className="field mt-2 w-full"
              value={symbol}
              onChange={(e) => {
                setPhase("idle");
                setSymbol(e.target.value);
              }}
            >
              {markets.map((m) => (
                <option key={m.symbol} value={m.symbol}>
                  {m.title}: {m.label}
                  {m.day ? ` (${m.day})` : ""}
                </option>
              ))}
            </select>
          </div>

          <div role="group" aria-label="Find an entry in this market's history" className="grid grid-cols-2 gap-2">
            <button type="button" className="btn btn-secondary px-2" disabled={!scenarios.gain} onClick={() => scenarios.gain && apply(scenarios.gain)}>
              Show a gain
            </button>
            <button
              type="button"
              className="btn btn-secondary px-2"
              disabled={!scenarios.liquidation}
              onClick={() => scenarios.liquidation && apply(scenarios.liquidation)}
            >
              Show a liquidation
            </button>
          </div>

          <SideToggle
            legend="Side"
            name={`${uid}-side`}
            side={side}
            onChange={(s) => {
              setSide(s);
              setPhase("idle");
            }}
          />

          <div>
            <div className="flex items-baseline justify-between">
              <span id={`${uid}-lev`} className="label">
                Leverage
              </span>
              <span className="num text-[12px] text-muted">max {fmtLeverage(maxLev)} at this price</span>
            </div>
            <div
              className="mt-2 grid gap-2"
              style={{ gridTemplateColumns: `repeat(${chips.length}, minmax(0, 1fr))` }}
              role="group"
              aria-labelledby={`${uid}-lev`}
            >
              {chips.map((l) => (
                <button
                  key={l}
                  type="button"
                  className={`btn num px-0 font-medium ${lev === l ? "btn-solid" : "btn-outline"}`}
                  aria-pressed={lev === l}
                  onClick={() => {
                    setLeverage(l);
                    setPhase("idle");
                  }}
                >
                  {fmtLeverage(l)}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-baseline justify-between gap-3">
              <label className="label" htmlFor={`${uid}-entry`}>
                Entry
              </label>
              <span className="num text-[12px] text-muted">
                {entryBar ? `${clock(entryBar.t)} at ${fmtCents(entryBar.close)}` : ""}
              </span>
            </div>
            <input
              id={`${uid}-entry`}
              type="range"
              className="mt-3 w-full accent-[var(--color-text)]"
              min={0}
              max={Math.max(0, candles.length - 2)}
              value={entryIndex}
              onChange={(e) => moveEntry(Number(e.target.value))}
            />
            <p className="mt-2 text-[12px] text-muted">Or click the chart. Margin is 100 USDC in every replay.</p>
          </div>
        </div>

        <div className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 text-[13px] text-muted">
              {failed
                ? "Gemini has no price history for this market."
                : data?.symbol !== symbol
                  ? "Loading prices…"
                  : `${candles.length} one-minute bars from Gemini${data.source === "snapshot" ? `, saved ${market?.day ?? ""}` : ", live"}`}
            </p>
            <div className="flex items-center gap-2">
              <button type="button" className="btn btn-outline px-3" aria-pressed={fast} onClick={() => setFast((f) => !f)}>
                Fast
              </button>
              <button
                type="button"
                className="btn btn-primary min-w-[96px] px-4"
                disabled={!sim}
                onClick={() => {
                  if (phase === "playing") setPhase("paused");
                  else if (phase === "paused") setPhase("playing");
                  else start(entryIndex);
                }}
              >
                {phase === "playing" ? "Pause" : phase === "paused" ? "Resume" : phase === "done" ? "Play again" : "Play"}
              </button>
            </div>
          </div>

          <div className="relative mt-4">
            <canvas
              ref={canvasRef}
              className="num block h-[320px] w-full cursor-crosshair border border-border md:h-[360px]"
              onPointerDown={onChartClick}
              role="img"
              aria-label={`Price of ${market?.title ?? "the market"} over time, with the position's entry, liquidation price and profit or loss.`}
            />
            {/* Decorative, and never in the way of a click on the chart. The result is also in the text below. */}
            <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
              {flashes
                .filter((f) => f.phase !== "out")
                .map((f) => (
                  <div key={f.id} className="replay-wash" data-tone={f.tone} data-strong={f.strong || undefined} />
                ))}
              {flashes.map((f) => (
                <div
                  key={`t${f.id}`}
                  className="replay-flash num"
                  data-tone={f.tone}
                  onTransitionEnd={(e) => {
                    if (e.propertyName === "opacity" && f.phase === "out") setFlashes((held) => held.filter((x) => x.id !== f.id));
                  }}
                  style={{
                    opacity: f.phase === "shown" ? 1 : 0,
                    transform:
                      f.phase === "enter"
                        ? "translate(-50%, 14px) scale(0.94)"
                        : f.phase === "shown"
                          ? "translate(-50%, 0) scale(1)"
                          : "translate(-50%, -30px) scale(1)",
                  }}
                >
                  {f.text}
                  <span className="ml-3 text-[15px] text-text-2">{f.sub}</span>
                </div>
              ))}
            </div>
          </div>

          <dl className="stats mt-4 grid-cols-2 sm:grid-cols-3 xl:grid-cols-6" aria-live="off">
            <div>
              <dt>Status</dt>
              <dd>{status}</dd>
            </div>
            <div>
              <dt>Price</dt>
              <dd>{step ? fmtCents(phase === "done" && sim ? Number(sim.exitPrice) : step.mark) : "n/a"}</dd>
            </div>
            <div>
              <dt>Position value</dt>
              <dd>{step ? `$${fmtUsdc(step.equity)}` : "n/a"}</dd>
            </div>
            <div>
              <dt>PnL at {fmtLeverage(lev)}</dt>
              <dd>{step ? `${fmtSignedUsd(step.pnl)} (${pctOfMargin(step.pnl)})` : "n/a"}</dd>
            </div>
            <div>
              <dt>Same trade at 1x</dt>
              <dd className="text-text-2">{step ? fmtSignedUsd(step.pnl1x) : "n/a"}</dd>
            </div>
            <div>
              <dt>Liquidation price</dt>
              <dd>{sim && sim.open.liqPrice > 0n ? fmtPrice(sim.open.liqPrice) : "None at 1x"}</dd>
            </div>
          </dl>

          <div className="mt-4 min-h-[92px]" role="status">
            {phase === "done" && sim ? (
              <div className="fade-in">
                <p className="text-[22px] md:text-[26px]">
                  {sim.outcome === "liquidated" ? "Liquidated" : "Sold"} at {fmtCents(Number(sim.exitPrice))}:{" "}
                  <span className="num">
                    {fmtSignedUsd(sim.pnl)} ({pctOfMargin(sim.pnl)})
                  </span>
                </p>
                <p className="mt-2 max-w-[70ch] text-[14px] text-text-2">
                  {sim.outcome === "liquidated"
                    ? `Of the $100 margin, $${fmtUsdc(sim.payout)} came back. Held at 1x to the end of this history, the same trade ends at ${fmtSignedUsd(lastStep?.pnl1x ?? 0n)}. `
                    : `The same trade at 1x made ${fmtSignedUsd(lastStep?.pnl1x ?? 0n)}. `}
                  {sim.vaultLoss > 0n
                    ? `Lenders lose $${fmtUsdc(sim.vaultLoss)}: the price jumped past the liquidation price within one bar.`
                    : sim.open.borrowed > 0n
                      ? `Lenders were repaid the $${fmtUsdc(sim.open.borrowed)} they lent and kept the $${fmtUsdc(sim.open.fee)} open fee.`
                      : "Nothing was borrowed."}
                </p>
              </div>
            ) : (
              <p className="max-w-[70ch] text-[14px] text-muted">
                {sim
                  ? `${fmtLeverage(lev)} on 100 USDC buys $${fmtUsdc(sim.open.size)} of ${side === SIDE_YES ? "Yes" : "No"} at ${fmtCents(Number(sim.open.refPrice))}, borrowing $${fmtUsdc(sim.open.borrowed)} for a $${fmtUsdc(sim.open.fee)} fee.${phase === "idle" ? " Press Play to run the market forward from here." : ""}`
                  : "Pick an entry before the last bar."}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
