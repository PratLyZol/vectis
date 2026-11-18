"use client";

import { useEffect, useRef } from "react";

// A square grid filling its container (the landing hero), behind the content. The tile under the pointer lights up,
// its neighbours light faintly, and lit tiles fade, so a moving pointer leaves a decaying trail.
// One canvas, no per-tile DOM; the animation loop runs only while a tile is lit.

export type Rgb = [number, number, number];

/** Read a colour token from the theme, so the canvas never carries its own palette. */
export function token(name: string, fallback: Rgb): Rgb {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(raw)?.[1];
  if (!hex) return fallback;
  return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as Rgb;
}
const FADE_MS = 850;
const PEAK_FILL = 0.34;
const PEAK_EDGE = 0.6;
const GRID_ALPHA = 1; // the border token is already close to the ground colour
const NEIGHBOURS: [number, number, number][] = [
  [1, 0, 0.36],
  [-1, 0, 0.36],
  [0, 1, 0.36],
  [0, -1, 0.36],
  [1, 1, 0.16],
  [1, -1, 0.16],
  [-1, 1, 0.16],
  [-1, -1, 0.16],
];

type Lit = { start: number; peak: number };

const tileSize = (w: number) => (w >= 1024 ? 52 : w >= 640 ? 44 : 36);

/** Deterministic per tile: about 1 in 12 lights in the danger colour. */
const isAccent = (col: number, row: number) => {
  let h = Math.imul(col + 374_761, 668_265_263) ^ Math.imul(row + 1_274_126, 2_246_822_519);
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
  return ((h ^ (h >>> 16)) >>> 0) % 12 === 0;
};

/** Brightness of a lit tile at `now`: eases out from its peak to zero over FADE_MS. */
const level = (l: Lit, now: number) => {
  const t = (now - l.start) / FADE_MS;
  return t >= 1 ? 0 : l.peak * (1 - t) * (1 - t);
};

export function TileField() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    // Lit tiles take the accent; the occasional tile takes danger; lines take the border token.
    const accent = token("--color-accent", [255, 255, 255]);
    const danger = token("--color-danger", [255, 255, 255]);
    const [gr, gg, gb] = token("--color-border", [40, 40, 40]);
    const grid = `rgb(${gr},${gg},${gb})`;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const lit = new Map<string, Lit>();
    let width = 0;
    let height = 0;
    let size = 52;
    let frame = 0;
    let last: { x: number; y: number; t: number } | null = null;

    const draw = (now: number) => {
      ctx.clearRect(0, 0, width, height);

      // Resting grid: faint 1px lines.
      ctx.globalAlpha = GRID_ALPHA;
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= width; x += size) {
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, height);
      }
      for (let y = 0; y <= height; y += size) {
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(width, y + 0.5);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;

      for (const [key, l] of lit) {
        const v = level(l, now);
        if (v <= 0.004) {
          lit.delete(key);
          continue;
        }
        const [c, r] = key.split(",").map(Number) as [number, number];
        const [red, green, blue] = isAccent(c, r) ? danger : accent;
        const x = c * size;
        const y = r * size;
        ctx.fillStyle = `rgba(${red},${green},${blue},${(PEAK_FILL * v).toFixed(3)})`;
        ctx.fillRect(x + 1, y + 1, size - 1, size - 1);
        ctx.strokeStyle = `rgba(${red},${green},${blue},${(PEAK_EDGE * v).toFixed(3)})`;
        ctx.strokeRect(x + 0.5, y + 0.5, size, size);
      }
    };

    const loop = (now: number) => {
      draw(now);
      frame = lit.size > 0 && !document.hidden ? requestAnimationFrame(loop) : 0;
    };
    const wake = () => {
      if (!frame && !document.hidden) frame = requestAnimationFrame(loop);
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const box = canvas.getBoundingClientRect();
      width = Math.round(box.width);
      height = Math.round(box.height);
      if (width === 0 || height === 0) return;
      size = tileSize(width);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      lit.clear();
      last = null;
      draw(performance.now());
    };

    const light = (col: number, row: number, peak: number, now: number) => {
      if (col < 0 || row < 0 || col * size > width || row * size > height) return;
      const key = `${col},${row}`;
      const current = lit.get(key);
      if (!current || level(current, now) < peak) lit.set(key, { start: now, peak });
    };

    const lightAt = (x: number, y: number, now: number) => {
      const col = Math.floor(x / size);
      const row = Math.floor(y / size);
      light(col, row, 1, now);
      for (const [dc, dr, peak] of NEIGHBOURS) light(col + dc, row + dr, peak, now);
    };

    const onMove = (e: PointerEvent) => {
      // Touch has no hover: the grid stays at rest. Reduced motion: no lighting.
      if (e.pointerType === "touch" || reduced.matches) return;
      const now = performance.now();
      // Pointer position inside the canvas, which scrolls with the page.
      const box = canvas.getBoundingClientRect();
      const x = e.clientX - box.left;
      const y = e.clientY - box.top;
      if (x < -size || y < -size || x > width + size || y > height + size) {
        last = null;
        return;
      }
      // Walk from the previous sample so a fast pointer lights every tile on its path.
      if (last && now - last.t < 120) {
        const dx = x - last.x;
        const dy = y - last.y;
        const steps = Math.min(64, Math.ceil(Math.hypot(dx, dy) / (size / 2)));
        for (let i = 1; i < steps; i++) lightAt(last.x + (dx * i) / steps, last.y + (dy * i) / steps, now);
      }
      lightAt(x, y, now);
      last = { x, y, t: now };
      wake();
    };

    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(frame);
        frame = 0;
        last = null;
      } else if (lit.size > 0) wake();
    };

    const onMotionChange = () => {
      lit.clear();
      draw(performance.now());
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    reduced.addEventListener("change", onMotionChange);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("visibilitychange", onVisibility);
      reduced.removeEventListener("change", onMotionChange);
    };
  }, []);

  return <canvas ref={ref} aria-hidden="true" className="tile-field" />;
}
