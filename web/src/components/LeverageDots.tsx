"use client";

import { useEffect, useRef, useState } from "react";
import { token, type Rgb } from "./TileField";

// A dot matrix that explains leverage: one price path, traced twice. The 1x trace is what the
// stake is worth with no loan; the 3x trace moves three times as far and stops at the
// liquidation row if it gets there. Three scripted paths play in turn.
//
// The numbers follow the protocol rules for a 60¢ contract bought at 3x: 20¢ of margin and 40¢
// borrowed per contract, sold at 44¢ (borrowed + 4¢), which leaves 4¢ of the 20¢: 20% of the stake.
// One canvas; the loop runs only while the figure is on screen.

const LEV = 3;
const LIQ = 0.2; // stake left at liquidation, as a share of margin
const V_MAX = 1.9; // top of the chart: stake worth 190% of margin
const V_MIN = -0.15;
const DRAW_MS = 2600;
const HOLD_MS = 2800;
const FADE_MS = 500;
const CYCLE_MS = DRAW_MS + HOLD_MS + FADE_MS;
const PULSE_MS = 900;

/** Price over time as a ratio to the entry price: [time 0..1, ratio]. */
const SCENARIOS: [number, number][][] = [
  [[0, 1], [0.18, 0.97], [0.4, 1.07], [0.6, 1.04], [0.82, 1.16], [1, 1.2]],
  [[0, 1], [0.18, 1.04], [0.42, 0.9], [0.6, 0.8], [0.72, 0.725], [0.86, 0.82], [1, 0.95]],
  [[0, 1], [0.2, 1.08], [0.4, 0.93], [0.6, 0.88], [0.8, 1.02], [1, 1.08]],
];

function ratio(points: [number, number][], t: number, seed: number): number {
  let i = 1;
  while (i < points.length - 1 && t > (points[i]?.[0] ?? 1)) i++;
  const [t0, r0] = points[i - 1] ?? [0, 1];
  const [t1, r1] = points[i] ?? [1, 1];
  const u = Math.min(1, Math.max(0, (t - t0) / (t1 - t0 || 1)));
  const s = u * u * (3 - 2 * u);
  // A small ripple so the trace steps like a price, pinned to zero at both ends.
  return r0 + (r1 - r0) * s + 0.008 * Math.sin(t * 37 + seed) * Math.sin(Math.PI * t);
}

type Dot = { c: number; r: number; at: number };
type Built = { one: Dot[]; lev: Dot[]; liqCol: number; end1: number; end3: number };
type Label = { text: string; style: React.CSSProperties };

const pct = (v: number) => {
  const p = Math.round((v - 1) * 100);
  return `${p >= 0 ? "+" : "−"}${Math.abs(p)}%`;
};

const rgba = ([r, g, b]: Rgb, a: number) => `rgba(${r},${g},${b},${a.toFixed(3)})`;

export function LeverageDots() {
  const ref = useRef<HTMLCanvasElement>(null);
  const [labels, setLabels] = useState<Label[]>([]);
  const [axis, setAxis] = useState<{ entry: number; liq: number } | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const cBase = token("--color-border-2", [51, 51, 51]);
    const cLine = token("--color-border", [34, 34, 34]);
    const cLev = token("--color-text", [255, 255, 255]);
    const cOne = token("--color-text-2", [207, 207, 207]);
    const cMuted = token("--color-muted", [128, 128, 128]);
    const cLiq = token("--color-danger", [166, 166, 166]);

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let width = 0;
    let height = 0;
    let gap = 14;
    let cols = 0;
    let rows = 0;
    let ox = 0;
    let oy = 0;
    let entryRow = 0;
    let liqRow = 0;
    let built: Built[] = [];
    let frame = 0;
    let lastT = 0;
    let clock = 0;
    let visible = false;
    let labelKey = "";

    const rowOf = (v: number) =>
      Math.min(rows - 1, Math.max(0, Math.round(((V_MAX - v) / (V_MAX - V_MIN)) * (rows - 1))));
    // The grid leans a little, as if printed on a curved sheet.
    const px = (c: number, r: number) =>
      ox + c * gap + gap * 0.22 * Math.sin((r / Math.max(1, rows - 1)) * Math.PI + 0.6) * Math.sin((c / Math.max(1, cols - 1)) * Math.PI * 2 + 0.4);
    const py = (r: number) => oy + r * gap;

    const push = (list: Dot[], c: number, row: number, prev: number) => {
      if (prev < 0 || prev === row) {
        list.push({ c, r: row, at: c });
        return;
      }
      // A jump of several rows becomes a vertical run, lit in order.
      const n = Math.abs(row - prev);
      const dir = Math.sign(row - prev);
      for (let k = 1; k <= n; k++) list.push({ c, r: prev + dir * k, at: c - 1 + k / n });
    };

    const build = (points: [number, number][], seed: number): Built => {
      const one: Dot[] = [];
      const lev: Dot[] = [];
      let liqCol = -1;
      let p1 = -1;
      let p3 = -1;
      let end1 = 1;
      let end3 = 1;
      for (let c = 0; c < cols; c++) {
        const r = ratio(points, cols > 1 ? c / (cols - 1) : 0, seed);
        const row1 = rowOf(r);
        push(one, c, row1, p1);
        p1 = row1;
        end1 = r;
        if (liqCol >= 0) continue;
        const e = 1 + LEV * (r - 1);
        if (e <= LIQ) {
          liqCol = c;
          end3 = LIQ;
          push(lev, c, liqRow, p3);
        } else {
          const row3 = Math.min(rowOf(e), liqRow - 1);
          push(lev, c, row3, p3);
          p3 = row3;
          end3 = e;
        }
      }
      return { one, lev, liqCol, end1, end3 };
    };

    const labelsFor = (b: Built): Label[] => {
      const lastOne = b.one[b.one.length - 1];
      const lastLev = b.lev[b.lev.length - 1];
      if (!lastOne || !lastLev) return [];
      const levAbove = lastLev.r <= lastOne.r;
      const out: Label[] = [{ text: `1x ${pct(b.end1)}`, style: { right: 8, top: py(lastOne.r) + (levAbove ? 10 : -28) } }];
      if (b.liqCol >= 0) {
        out.push({
          text: `3x liquidated ${pct(b.end3)}`,
          style: { left: px(lastLev.c, lastLev.r), top: py(lastLev.r) + 10, transform: "translateX(-100%)" },
        });
      } else {
        out.push({ text: `3x ${pct(b.end3)}`, style: { right: 8, top: py(lastLev.r) + (levAbove ? -28 : 10) } });
      }
      return out;
    };

    const dot = (c: number, r: number, size: number) => {
      const half = Math.floor(size / 2);
      ctx.fillRect(Math.round(px(c, r)) - half, Math.round(py(r)) - half, size, size);
    };

    const render = () => {
      if (cols === 0) return;
      const still = reduced.matches;
      const idx = still ? 0 : Math.floor(clock / CYCLE_MS) % SCENARIOS.length;
      const e = still ? DRAW_MS : clock % CYCLE_MS;
      const b = built[idx];
      if (!b) return;
      const head = Math.min(1, e / DRAW_MS) * (cols - 1) + 0.8;
      const fade = e > DRAW_MS + HOLD_MS ? 1 - (e - DRAW_MS - HOLD_MS) / FADE_MS : 1;
      const holding = e >= DRAW_MS && e <= DRAW_MS + HOLD_MS;

      const key = `${idx}:${holding}`;
      if (key !== labelKey) {
        labelKey = key;
        setLabels(holding ? labelsFor(b) : []);
      }

      ctx.clearRect(0, 0, width, height);

      // Contour lines between every fourth pair of columns.
      ctx.strokeStyle = rgba(cLine, 1);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let c = 3; c < cols - 1; c += 4) {
        for (let r = 0; r < rows; r++) {
          const x = (px(c, r) + px(c + 1, r)) / 2;
          if (r === 0) ctx.moveTo(x, 0);
          ctx.lineTo(x, py(r));
        }
        ctx.lineTo((px(c, rows - 1) + px(c + 1, rows - 1)) / 2, height);
      }
      ctx.stroke();

      ctx.fillStyle = rgba(cBase, 1);
      for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) dot(c, r, 2);

      // Entry row (the margin) and the liquidation row.
      ctx.fillStyle = rgba(cMuted, 0.55);
      for (let c = 0; c < cols; c += 2) dot(c, entryRow, 2);
      const tLiq = b.liqCol >= 0 ? (b.liqCol / (cols - 1)) * DRAW_MS : -1;
      const pulse = tLiq >= 0 && e >= tLiq && !still ? Math.max(0, 1 - (e - tLiq) / PULSE_MS) : 0;
      ctx.fillStyle = rgba(cLiq, 0.5 + 0.5 * pulse);
      for (let c = 0; c < cols; c++) dot(c, liqRow, 2);

      const trace = (list: Dot[], colour: Rgb, size: number, peak: number) => {
        for (const d of list) {
          const a = Math.min(1, (head - d.at) / 0.8);
          if (a <= 0) break; // the list is in drawing order
          ctx.fillStyle = rgba(colour, a * fade * peak);
          dot(d.c, d.r, size);
        }
      };
      trace(b.one, cOne, 3, 0.7);
      trace(b.lev, cLev, 5, 1);

      // A square around the dot where the 3x position was sold.
      const hit = b.lev[b.lev.length - 1];
      if (b.liqCol >= 0 && hit && head >= hit.at) {
        ctx.strokeStyle = rgba(cLev, fade);
        ctx.strokeRect(Math.round(px(hit.c, hit.r)) - 6.5, Math.round(py(hit.r)) - 6.5, 14, 14);
      }
    };

    const tick = (now: number) => {
      clock += Math.min(50, now - lastT);
      lastT = now;
      render();
      frame = requestAnimationFrame(tick);
    };
    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
    };
    const start = () => {
      if (frame || !visible || document.hidden || reduced.matches) return;
      lastT = performance.now();
      frame = requestAnimationFrame(tick);
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const box = canvas.getBoundingClientRect();
      width = Math.round(box.width);
      height = Math.round(box.height);
      if (width === 0 || height === 0) return;
      gap = width >= 640 ? 14 : 12;
      cols = Math.floor((width - 2 * gap) / gap) + 1;
      rows = Math.floor((height - 2 * gap) / gap) + 1;
      ox = (width - (cols - 1) * gap) / 2;
      oy = (height - (rows - 1) * gap) / 2;
      entryRow = rowOf(1);
      liqRow = rowOf(LIQ);
      built = SCENARIOS.map((s, i) => build(s, i * 2.1));
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      setAxis({ entry: py(entryRow), liq: py(liqRow) });
      labelKey = "";
      render();
    };

    const onVisibility = () => (document.hidden ? stop() : start());
    const onMotionChange = () => {
      stop();
      labelKey = "";
      render();
      start();
    };

    resize();
    const resizer = new ResizeObserver(resize);
    resizer.observe(canvas);
    const watcher = new IntersectionObserver(
      ([entry]) => {
        visible = Boolean(entry?.isIntersecting);
        if (visible) start();
        else stop();
      },
      { threshold: 0.15 },
    );
    watcher.observe(canvas);
    document.addEventListener("visibilitychange", onVisibility);
    reduced.addEventListener("change", onMotionChange);
    return () => {
      stop();
      resizer.disconnect();
      watcher.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      reduced.removeEventListener("change", onMotionChange);
    };
  }, []);

  return (
    <figure className="card m-0 p-5 md:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <p className="text-[13px] text-muted">The same price move, with and without a loan</p>
        <p className="num flex items-center gap-4 text-[12px] text-text-2" aria-hidden="true">
          <span className="flex items-center gap-2">
            <span className="inline-block size-[5px] bg-text" />
            3x
          </span>
          <span className="flex items-center gap-2">
            <span className="inline-block size-[3px] bg-text-2 opacity-70" />
            1x
          </span>
        </p>
      </div>
      <div className="relative mt-4 h-[216px] border border-border md:h-[272px]" aria-hidden="true">
        <canvas ref={ref} className="absolute inset-0 h-full w-full" />
        {axis ? (
          <>
            <span className="num absolute left-2 bg-surface px-1 text-[11px] text-muted" style={{ top: axis.entry - 24 }}>
              Your margin
            </span>
            <span className="num absolute left-2 bg-surface px-1 text-[11px] text-danger" style={{ top: axis.liq - 24 }}>
              Liquidation
            </span>
          </>
        ) : null}
        {labels.map((l) => (
          <span key={l.text} className="fade-in num absolute whitespace-nowrap bg-surface px-1 text-[12px] text-text" style={l.style}>
            {l.text}
          </span>
        ))}
      </div>
      <figcaption className="mt-4 max-w-[70ch] text-[14px] text-text-2">
        At 3x your stake gains and loses three times as fast as the price moves, and the position is sold if it
        reaches its liquidation price. Example paths for a 60¢ contract, not market data.
      </figcaption>
    </figure>
  );
}
