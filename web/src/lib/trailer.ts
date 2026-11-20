// The Vectis trailer: one canvas frame as a pure function of time, so the page can play it and a
// capture script can render the same frames one by one. Drawn in a fixed 1920x1080 space.
// The figures in the chart scene are the two saved replays shown on /replay.

export const W = 1920;
export const H = 1080;
export const DURATION = 46.8;

export type Fonts = { sans: string; mono: string };
type Pt = [number, number];
type P3 = [number, number, number];
export type Assets = { fonts: Fonts; history: Pt[]; historyW: number };

const clamp = (x: number) => Math.min(1, Math.max(0, x));
const seg = (t: number, a: number, b: number) => clamp((t - a) / (b - a));
const out = (x: number) => 1 - Math.pow(1 - x, 4);
const inOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const white = (a: number) => `rgba(255,255,255,${clamp(a).toFixed(3)})`;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// Point clouds, fixed at load so every render of a frame is identical.
const SPHERE: P3[] = Array.from({ length: 1500 }, (_, i) => {
  const y = 1 - (2 * (i + 0.5)) / 1500;
  const r = Math.sqrt(1 - y * y);
  const a = i * 2.39996323;
  return [Math.cos(a) * r, y, Math.sin(a) * r];
});
const TORUS: P3[] = (() => {
  const r = rng(7);
  return Array.from({ length: 2600 }, () => {
    const u = r() * Math.PI * 2;
    const v = r() * Math.PI * 2;
    const k = 1 + 0.42 * Math.cos(v);
    return [k * Math.cos(u), 0.42 * Math.sin(v), k * Math.sin(u)] as P3;
  });
})();
const TUNNEL: P3[] = (() => {
  const r = rng(11);
  return Array.from({ length: 1100 }, () => [Math.floor(r() * 28) * ((Math.PI * 2) / 28), r(), 0.85 + r() * 0.3] as P3);
})();
const SCATTER: Pt[] = (() => {
  const r = rng(23);
  return Array.from({ length: 6000 }, () => [r() * 2 - 1, r() * 2 - 1] as Pt);
})();
const HORIZON: P3[] = (() => {
  const r = rng(31);
  return Array.from({ length: 1500 }, () => [r(), r() * r(), r()] as P3);
})();

function project(p: P3, rotY: number, rotX: number, dist: number, scale: number, cx = W / 2, cy = H / 2): P3 {
  const [x, y, z] = p;
  const x1 = x * Math.cos(rotY) + z * Math.sin(rotY);
  const z1 = -x * Math.sin(rotY) + z * Math.cos(rotY);
  const y1 = y * Math.cos(rotX) - z1 * Math.sin(rotX);
  const z2 = y * Math.sin(rotX) + z1 * Math.cos(rotX);
  const f = dist / (dist + z2);
  return [cx + x1 * f * scale, cy + y1 * f * scale, f];
}

type Ctx = CanvasRenderingContext2D;

function dot(c: Ctx, x: number, y: number, size: number, alpha: number) {
  if (alpha <= 0.01) return;
  c.fillStyle = white(alpha);
  c.fillRect(x - size / 2, y - size / 2, size, size);
}

function label(c: Ctx, s: string, x: number, y: number, font: string, color: string, align: CanvasTextAlign = "center", spacing = 0) {
  c.font = font;
  c.fillStyle = color;
  c.textAlign = align;
  c.textBaseline = "middle";
  (c as Ctx & { letterSpacing: string }).letterSpacing = `${spacing}px`;
  // Canvas adds the spacing after the last glyph too; shift centred text back by half of it.
  c.fillText(s, align === "center" ? x + spacing / 2 : x, y);
}

function hud(c: Ctx, t: number, f: Fonts, left: string, alpha = 1) {
  const col = `rgba(128,128,128,${alpha})`;
  label(c, left, 64, 60, `400 20px ${f.mono}`, col, "left", 3);
  label(c, `T+${t.toFixed(2).padStart(5, "0")}`, W - 64, 60, `400 20px ${f.mono}`, col, "right", 3);
  c.strokeStyle = col;
  c.lineWidth = 2;
  for (const [x, y, sx, sy] of [[40, 40, 1, 1], [W - 40, 40, -1, 1], [40, H - 40, 1, -1], [W - 40, H - 40, -1, -1]] as const) {
    c.beginPath();
    c.moveTo(x + 18 * sx, y);
    c.lineTo(x, y);
    c.lineTo(x, y + 18 * sy);
    c.stroke();
  }
}

/** Short bursts of white bars, the same for a given frame. */
function glitch(c: Ctx, t: number, amount: number) {
  if (amount <= 0) return;
  const r = rng(Math.floor(t * 14) + 99);
  const n = Math.floor(r() * 4 * amount);
  for (let i = 0; i < n; i++) {
    const w = 60 + r() * 320;
    c.fillStyle = white(0.25 + r() * 0.75);
    c.fillRect(r() * (W - w), r() * H, w, 6 + r() * 16);
  }
}

function keycap(c: Ctx, cx: number, cy: number, size: number, text: string, press: number, f: Fonts, alpha = 1) {
  const depth = size * 0.11;
  const top = cy - size / 2 - depth * (1 - press);
  const x = cx - size / 2;
  c.save();
  c.globalAlpha = alpha;
  c.fillStyle = "#111";
  c.strokeStyle = "#444";
  c.lineWidth = 2;
  c.fillRect(x, cy - size / 2, size, size);
  c.strokeRect(x, cy - size / 2, size, size);
  const v = Math.round(press * 255);
  c.fillStyle = `rgb(${v},${v},${v})`;
  c.strokeStyle = "#fff";
  c.lineWidth = 3;
  c.fillRect(x, top, size, size);
  c.strokeRect(x, top, size, size);
  label(c, text, cx, top + size / 2 + size * 0.02, `500 ${Math.round(size * 0.34)}px ${f.mono}`, press > 0.5 ? "#000" : "#fff");
  c.restore();
}

/** Press curve for a key struck at `at`: down fast, held, then up. */
const strike = (t: number, at: number, hold = 0.22) => Math.min(seg(t, at, at + 0.07), 1 - seg(t, at + hold, at + hold + 0.22));

// 0.0 to 3.2: one key. 1x becomes 5x.
function sceneKey(c: Ctx, t: number, f: Fonts) {
  const zoom = 1 + Math.pow(seg(t, 2.75, 3.2), 3) * 7;
  const a = out(seg(t, 0.15, 0.8)) * (1 - seg(t, 2.95, 3.2));
  const p = strike(t, 1.3, 0.3);
  c.save();
  c.translate(W / 2, H / 2);
  c.scale((0.94 + 0.06 * out(seg(t, 0.15, 0.9))) * zoom, (0.94 + 0.06 * out(seg(t, 0.15, 0.9))) * zoom);
  c.translate(-W / 2, -H / 2);
  const ring = seg(t, 1.37, 2.5);
  if (ring > 0 && ring < 1) {
    const s = 280 + out(ring) * 900;
    c.strokeStyle = white((1 - ring) * 0.6);
    c.lineWidth = 2;
    c.strokeRect(W / 2 - s / 2, H / 2 - s / 2, s, s);
  }
  keycap(c, W / 2, H / 2, 280, t < 1.36 ? "1x" : "5x", p, f, a);
  label(c, "LEVERAGE", W / 2, H / 2 + 250, `400 24px ${f.mono}`, `rgba(128,128,128,${out(seg(t, 1.9, 2.4)) * a})`, "center", 14);
  c.restore();
}

// 3.2 to 7.6: the dot matrix. One price path, traced at 1x and at 5x.
function sceneGrid(c: Ctx, t: number, f: Fonts) {
  const cols = 84;
  const rows = 44;
  const rotY = -0.4 + inOut(seg(t, 0, 4.4)) * 0.62;
  const scale = 500 + t * 14;
  const head = inOut(seg(t, 0.3, 3.7)) * (cols - 1);
  const u = (i: number) => 0.4 * (0.13 * (i / (cols - 1)) + 0.05 * Math.sin(i * 0.23) + 0.03 * Math.sin(i * 0.61 + 1));
  const rowOf = (v: number) => Math.round((0.5 - v) * (rows - 1));
  const at = (i: number, j: number) => project([(i / (cols - 1) - 0.5) * 3.4, (j / (rows - 1) - 0.5) * 1.8, 0], rotY, 0.24, 3, scale);
  for (let i = 0; i < cols; i++) {
    const r1 = rowOf(u(i));
    const r5 = rowOf(Math.max(-0.4, Math.min(0.4, u(i) * 5)));
    for (let j = 0; j < rows; j++) {
      const [x, y, k] = at(i, j);
      const lit = i <= head;
      if (lit && j === r5) dot(c, x, y, 11 * k, 1);
      else if (lit && j === r1) dot(c, x, y, 7 * k, 0.55);
      else if (j === rowOf(0)) dot(c, x, y, 5 * k, 0.6);
      else dot(c, x, y, 4.4 * k, 0.3);
    }
  }
  const hi = Math.floor(head);
  const [x5, y5] = at(hi, rowOf(Math.max(-0.4, Math.min(0.4, u(hi) * 5))));
  const [x1, y1] = at(hi, rowOf(u(hi)));
  label(c, "5x", x5 + 22, y5 - 22, `500 34px ${f.mono}`, "#fff", "left");
  label(c, "1x", x1 + 22, y1 + 26, `400 26px ${f.mono}`, "#9a9a9a", "left");
  hud(c, t + 3.2, f, "ONE PRICE PATH / TWO POSITIONS");
  glitch(c, t, t < 0.35 ? 1 : t > 2.1 && t < 2.4 ? 0.8 : 0);
}

// 7.6 to 10.6: every market ends at $1 or $0, then the run toward expiry.
function sceneSphere(c: Ctx, t: number, f: Fonts) {
  if (t < 1.8) {
    const scale = 270 + out(seg(t, 0, 1.8)) * 60;
    for (const p of SPHERE) {
      const [x, y, k] = project(p, t * 0.9, 0.25, 3.2, scale);
      dot(c, x, y, 5 * k * k, k > 1 ? 0.95 : 0.22);
    }
    const a = out(seg(t, 0.25, 0.7));
    label(c, "$1", W / 2, H / 2 - scale - 58, `500 44px ${f.mono}`, white(a));
    label(c, "$0", W / 2, H / 2 + scale + 58, `500 44px ${f.mono}`, white(a));
    label(c, "EVERY MARKET SETTLES AT ONE OR THE OTHER", W / 2, H - 70, `400 22px ${f.mono}`, `rgba(128,128,128,${a})`, "center", 8);
    hud(c, t + 7.6, f, "PREDICTION MARKET");
    return;
  }
  const speed = 0.55 + (t - 1.8) * 0.5;
  for (const [a, z0, r] of TUNNEL) {
    const z = ((((z0 - (t - 1.8) * speed) % 1) + 1) % 1) * 9 + 0.15;
    const k = 1 / z;
    dot(c, W / 2 + Math.cos(a + z * 0.12) * r * 620 * k, H / 2 + Math.sin(a + z * 0.12) * r * 620 * k, Math.min(18, 6 * k + 1.5), Math.min(1, 0.25 + k * 1.6) * seg(z, 0.15, 0.5));
  }
  glitch(c, t, t < 2.0 ? 1 : 0);
}

// 10.6 to 13.6: the two sides, typed.
function sceneKeys(c: Ctx, t: number, f: Fonts) {
  const second = t >= 1.5;
  const keys = second ? ["N", "O"] : ["Y", "E", "S"];
  const start = second ? 1.72 : 0.22;
  const size = 250;
  const gap = 46;
  const total = keys.length * size + (keys.length - 1) * gap;
  const local = second ? t - 1.5 : t;
  c.save();
  c.translate(W / 2, H / 2);
  const z = 1 + local * 0.05;
  c.scale(z, z);
  c.translate(-W / 2, -H / 2);
  keys.forEach((k, i) => {
    const at = start + i * 0.26;
    // A struck key stays lit, so the word reads once the last key lands.
    const p = Math.max(strike(t, at), t > at + 0.3 ? 0.999 : 0);
    keycap(c, W / 2 - total / 2 + size / 2 + i * (size + gap), H / 2, size, k, p, f);
  });
  c.restore();
  hud(c, t + 10.6, f, second ? "SIDE / NO" : "SIDE / YES");
  glitch(c, t, local < 0.12 ? 1 : 0);
}

// 13.6 to 17.0: the vault.
function sceneTorus(c: Ctx, t: number, f: Fonts) {
  const scale = 230 + t * 20;
  for (const p of TORUS) {
    const [x, y, k] = project(p, t * 0.8, 1.05 + Math.sin(t * 0.7) * 0.12, 3.4, scale, W / 2, 490);
    dot(c, x, y, 4.6 * k * k, k > 1 ? 0.9 : 0.2);
  }
  const a = out(seg(t, 0.3, 0.8));
  label(c, "LENDERS SUPPLY THE USDC", W / 2, H - 70, `400 22px ${f.mono}`, `rgba(128,128,128,${a})`, "center", 8);
  hud(c, t + 13.6, f, "LENDING VAULT");
  glitch(c, t, t < 0.15 ? 1 : 0);
}

function slab(c: Ctx, cx: number, y: number, filled: boolean, alpha: number) {
  const a = 250;
  const b = 78;
  const h = 62;
  const faces: [Pt[], string][] = [
    [[[cx - a, y - h], [cx, y + b - h], [cx, y + b], [cx - a, y]], "#b0b0b0"],
    [[[cx + a, y - h], [cx, y + b - h], [cx, y + b], [cx + a, y]], "#6e6e6e"],
    [[[cx, y - b - h], [cx + a, y - h], [cx, y + b - h], [cx - a, y - h]], "#ffffff"],
  ];
  c.save();
  c.globalAlpha = alpha;
  c.lineWidth = 2.5;
  c.lineJoin = "miter";
  c.strokeStyle = "#fff";
  for (const [pts, fill] of faces) {
    c.beginPath();
    pts.forEach(([x, yy], i) => (i ? c.lineTo(x, yy) : c.moveTo(x, yy)));
    c.closePath();
    c.fillStyle = filled ? fill : "#000";
    c.fill();
    if (!filled) c.stroke();
  }
  c.restore();
}

// 17.0 to 20.6: your margin, then the loan stacked on it.
function sceneStack(c: Ctx, t: number, f: Fonts) {
  const drops = [0.2, 0.85, 1.25, 1.65, 2.05];
  const cx = 760;
  const shake = t > 3.05 ? Math.sin(t * 90) * 7 * seg(t, 3.05, 3.6) : 0;
  let landed = 0;
  drops.forEach((at, i) => {
    const p = seg(t, at, at + 0.3);
    if (p <= 0) return;
    if (p >= 1) landed = i + 1;
    slab(c, cx + shake * (i % 2 ? 1 : -1), 830 - i * 84 - (1 - out(p)) * 420, i === 0, p);
  });
  const a = out(seg(t, 0.5, 0.9));
  label(c, "YOUR MARGIN", cx - 300, 830, `400 22px ${f.mono}`, white(a), "right", 5);
  if (landed >= 2) {
    const top = 830 - (landed - 1) * 84 - 30;
    c.strokeStyle = "#808080";
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(cx - 290, 730);
    c.lineTo(cx - 310, 730);
    c.lineTo(cx - 310, top);
    c.lineTo(cx - 290, top);
    c.stroke();
    label(c, "BORROWED", cx - 334, (730 + top) / 2, `400 22px ${f.mono}`, "#808080", "right", 5);
  }
  if (landed >= 1) {
    const since = t - ((drops[landed - 1] ?? 0) + 0.3);
    const pop = 1 + (1 - out(seg(since, 0, 0.25))) * 0.12;
    c.save();
    c.translate(1400, 560);
    c.scale(pop, pop);
    label(c, `${landed}x`, 0, 0, `500 300px ${f.mono}`, "#fff");
    c.restore();
  }
  hud(c, t + 17, f, "MARGIN + LOAN");
  glitch(c, t, t < 0.12 || t > 3.35 ? 1 : 0);
}

// 20.6 to 23.6: the line, then it blows away as dots.
function sceneHistory(c: Ctx, t: number, A: Assets) {
  const g = c.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, 1100);
  g.addColorStop(0, white(0.16 * out(seg(t, 0, 0.5)) * (1 - seg(t, 2.2, 3))));
  g.addColorStop(1, white(0));
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);
  const s = 1 + t * 0.018;
  c.save();
  c.translate(W / 2, H / 2);
  c.scale(s, s);
  if (t < 1.4) {
    label(c, "1x IS HISTORY", 0, 0, `500 170px ${A.fonts.sans}`, white(out(seg(t, 0.05, 0.4))), "center", -3);
  } else {
    const d = (t - 1.4) / 1.5;
    A.history.forEach(([x, y], i) => {
      const [rx, ry] = SCATTER[i % SCATTER.length] ?? [0, 0];
      // The dissolve sweeps left to right; each dot leaves when the front reaches it.
      const local = clamp(d * 1.7 - (x / A.historyW + 0.5) * 0.7);
      const e = local * local;
      dot(c, x - e * (500 + rx * 380) + rx * e * 60, y + ry * e * 420 - e * 90, 5 * (1 - local * 0.5), 1 - local);
    });
  }
  c.restore();
}

function path(c: Ctx, y: (x: number) => number, progress: number, color: string) {
  const x0 = 150;
  const x1 = W - 330;
  const n = 110;
  c.strokeStyle = color;
  c.lineWidth = 5;
  c.lineJoin = "miter";
  c.beginPath();
  const last = Math.floor(progress * n);
  for (let i = 0; i <= last; i++) {
    const x = x0 + ((x1 - x0) * i) / n;
    const yy = y(i / n);
    if (i === 0) c.moveTo(x, yy);
    else {
      c.lineTo(x, yy); // stepped, like the replay chart
    }
    if (i < last) c.lineTo(x0 + ((x1 - x0) * (i + 1)) / n, yy);
  }
  c.stroke();
  return [x0 + ((x1 - x0) * last) / n, y(last / n)] as Pt;
}

// 23.6 to 27.6: the two endings. Figures from the saved replays on /replay.
function sceneChart(c: Ctx, t: number, f: Fonts) {
  if (t < 2) {
    const LIQ = 880;
    const y = (x: number) => 560 + 46 * Math.sin(x * 9) + 26 * Math.sin(x * 23 + 1) + Math.pow(seg(x, 0.66, 1), 2) * 372;
    const hit = t >= 1.1;
    c.fillStyle = hit ? "#fff" : "#000";
    c.fillRect(0, 0, W, H);
    const ink = hit ? "#000" : "#fff";
    c.setLineDash([14, 12]);
    c.strokeStyle = hit ? "#000" : "#808080";
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(150, LIQ);
    c.lineTo(W - 150, LIQ);
    c.stroke();
    c.setLineDash([]);
    label(c, "LIQUIDATION 34¢", 150, LIQ + 30, `400 22px ${f.mono}`, hit ? "#000" : "#808080", "left", 4);
    const [hx, hy] = path(c, y, out(seg(t, 0, 1.1)) * 0.985 + 0.015, ink);
    c.fillStyle = ink;
    c.fillRect(hx - 9, hy - 9, 18, 18);
    if (hit) {
      const pop = 1 + (1 - out(seg(t, 1.1, 1.4))) * 0.1;
      c.save();
      c.translate(W / 2, 250);
      c.scale(pop, pop);
      label(c, "LIQUIDATED", 0, 0, `500 210px ${f.sans}`, "#000", "center", -5);
      c.restore();
      label(c, "-$69.16   3.5x YES   $100 MARGIN", W / 2, 400, `500 34px ${f.mono}`, "#000", "center", 4);
    } else {
      label(c, "BUY YES 3.5x AT 42¢", 150, 250, `500 34px ${f.mono}`, white(out(seg(t, 0.05, 0.3))), "left", 4);
      hud(c, t + 23.6, f, "REPLAY / BTC PRICE AT 7PM");
    }
    return;
  }
  const u = t - 2;
  const y = (x: number) => 800 - 30 * Math.sin(x * 11) - 18 * Math.sin(x * 27) - Math.pow(x, 2.2) * 480;
  const p = out(seg(u, 0, 1.3));
  const [hx, hy] = path(c, y, p * 0.985 + 0.015, "#fff");
  c.fillStyle = "#fff";
  c.fillRect(hx - 9, hy - 9, 18, 18);
  label(c, "BUY YES 4.5x AT 54¢", 150, 250, `500 34px ${f.mono}`, white(out(seg(u, 0.05, 0.3))), "left", 4);
  label(c, `+$${(113.16 * p).toFixed(2)}`, 150, 400, `500 200px ${f.mono}`, "#fff", "left", -6);
  label(c, "THE SAME TRADE AT 1x: +$25.92", 150, 540, `400 26px ${f.mono}`, `rgba(128,128,128,${out(seg(u, 1.0, 1.4))})`, "left", 4);
  hud(c, t + 23.6, f, "REPLAY / BRENT CRUDE");
  glitch(c, u, u < 0.12 ? 1 : 0);
}

// 27.6 to 36.4: the hedge agent. A typed exposure, the agent's trace, then proposed positions.
// The prompt, the trace and both legs come from a real run of the agent on production on 2026-11-20.
const HEDGE_PROMPT = "I HOLD 20 ETH AND I'M WORRIED ABOUT A DROP BEFORE THE END OF THE MONTH. BUDGET $500.";
const HEDGE_LEGS: [string, string, string, string][] = [
  ["NO", "ETH on November 30: $1,750 or above", "$300  1x", "DIRECT"],
  ["NO", "ETH on November 30: $1,500 or above", "$200  1x", "DIRECT"],
];

// The trace rows, in order. A step's detail lands HEDGE_DONE after the row enters.
const HEDGE_TRACE: ({ kind: "thought"; text: string } | { kind: "step"; label: string; detail: string })[] = [
  { kind: "thought", text: "Find ETH markets." },
  { kind: "step", label: 'Searching markets for "ETH"', detail: "25 events" },
  { kind: "thought", text: "The Nov 30 event fits the horizon. Get full ladder." },
  { kind: "step", label: "Reading ETH price on November 30", detail: "8 contracts" },
  { kind: "step", label: 'Pricing No on "$1,750 or above" at 1x', detail: "max 4x" },
  { kind: "step", label: 'Pricing No on "$1,500 or above" at 1x', detail: "max 1x" },
  { kind: "step", label: "Validating the proposal against live prices", detail: "2 legs" },
];
const HEDGE_ROW0 = 2.0; // first row enters
const HEDGE_STAGGER = 0.4;
const HEDGE_DONE = 0.25;
const HEDGE_COLLAPSE = 5.2; // rows fold away into the summary line
const HEDGE_LEGS_AT = 6.0;
const HEDGE_SECONDS = 13;
const HEDGE_STEPS = HEDGE_TRACE.filter((r) => r.kind === "step").length;

function hedgeTrace(c: Ctx, t: number, f: Fonts) {
  const lastDone = HEDGE_ROW0 + (HEDGE_TRACE.length - 1) * HEDGE_STAGGER + HEDGE_DONE;
  const fold = inOut(seg(t, HEDGE_COLLAPSE, HEDGE_COLLAPSE + 0.3));
  const headY = 310;
  // Header: a node, the title and the elapsed counter, then the one-line summary in its place.
  const head = out(seg(t, 1.8, 2.1)) * (1 - seg(t, HEDGE_COLLAPSE, HEDGE_COLLAPSE + 0.2));
  if (head > 0) {
    const secs = Math.floor(HEDGE_SECONDS * seg(t, 1.8, lastDone));
    const on = t < lastDone && Math.floor(t * 4) % 2 === 0;
    c.save();
    c.globalAlpha = head;
    c.strokeStyle = "#fff";
    c.lineWidth = 2;
    c.strokeRect(151, headY - 7, 14, 14);
    if (on || t >= lastDone) {
      c.fillStyle = "#fff";
      c.fillRect(151, headY - 7, 14, 14);
    }
    label(c, "AGENT TRACE", 190, headY, `400 22px ${f.mono}`, "#808080", "left", 6);
    label(c, `${secs}s`, W - 150, headY, `500 26px ${f.mono}`, "#fff", "right", 2);
    c.restore();
  }
  const sum = out(seg(t, HEDGE_COLLAPSE + 0.15, HEDGE_COLLAPSE + 0.45));
  if (sum > 0) {
    c.fillStyle = white(sum);
    c.fillRect(151, headY - 7, 14, 14);
    label(c, "WORKED FOR " + HEDGE_SECONDS + "s · " + HEDGE_STEPS + " STEPS", 190, headY, `400 22px ${f.mono}`, `rgba(128,128,128,${sum})`, "left", 6);
  }
  if (fold >= 1) return;
  // Rows on a rail: steps have a square node (outlined while running, filled when done).
  const lift = fold * 40;
  const rows: number[] = [];
  let y = 380;
  for (const row of HEDGE_TRACE) {
    const h = row.kind === "step" ? 76 : 60;
    rows.push(y + h / 2);
    y += h;
  }
  // The rail runs down to the newest row, under the nodes.
  const shown = HEDGE_TRACE.filter((_, i) => t >= HEDGE_ROW0 + i * HEDGE_STAGGER).length;
  if (shown > 0) {
    c.fillStyle = `rgba(80,80,80,${1 - fold})`;
    c.fillRect(157, 350 - lift, 2, (rows[shown - 1] ?? 350) - 350);
  }
  HEDGE_TRACE.forEach((row, i) => {
    const at = HEDGE_ROW0 + i * HEDGE_STAGGER;
    const p = out(seg(t, at, at + 0.3));
    const cy = rows[i] ?? 0;
    if (p <= 0) return;
    const ry = cy + (1 - p) * 16 - lift;
    c.save();
    c.globalAlpha = p * (1 - fold);
    if (row.kind === "thought") {
      const words = row.text.split(" ");
      const n = Math.ceil(seg(t, at, at + 0.45) * words.length);
      label(c, words.slice(0, n).join(" "), 200, ry, `400 26px ${f.sans}`, "#8c8c8c", "left", 0);
    } else {
      const done = t >= at + HEDGE_DONE;
      c.fillStyle = "#000";
      c.fillRect(151, ry - 7, 14, 14);
      c.strokeStyle = "#fff";
      c.lineWidth = 2;
      c.strokeRect(151, ry - 7, 14, 14);
      if (done) {
        c.fillStyle = "#fff";
        c.fillRect(151, ry - 7, 14, 14);
      }
      label(c, row.label, 200, ry, `500 36px ${f.sans}`, "#fff", "left", -0.5);
      const d = out(seg(t, at + HEDGE_DONE, at + HEDGE_DONE + 0.2));
      if (d > 0) label(c, row.detail, W - 150, ry, `400 24px ${f.mono}`, `rgba(128,128,128,${d})`, "right", 3);
    }
    c.restore();
  });
}

function sceneHedge(c: Ctx, t: number, f: Fonts) {
  const typed = Math.floor(seg(t, 0.2, 1.8) * HEDGE_PROMPT.length);
  const lift = inOut(seg(t, 1.8, 2.2)) * 60;
  const text = `> ${HEDGE_PROMPT.slice(0, typed)}`;
  label(c, text, 150, 300 - lift, `500 26px ${f.mono}`, "#fff", "left", 3);
  if (t < 2.2 && Math.floor(t * 5) % 2 === 0) {
    c.font = `500 26px ${f.mono}`;
    (c as Ctx & { letterSpacing: string }).letterSpacing = "3px";
    c.fillStyle = "#fff";
    c.fillRect(150 + c.measureText(text).width + 6, 300 - lift - 17, 16, 34);
  }
  hedgeTrace(c, t, f);
  HEDGE_LEGS.forEach(([side, title, size, kind], i) => {
    const p = out(seg(t, HEDGE_LEGS_AT + i * 0.3, HEDGE_LEGS_AT + 0.5 + i * 0.3));
    if (p <= 0) return;
    const y = 420 + i * 170;
    const x = 150 + (1 - p) * 70;
    c.save();
    c.globalAlpha = p;
    c.fillStyle = "#fff";
    c.fillRect(x, y - 36, 130, 72);
    label(c, side, x + 65, y + 2, `500 34px ${f.mono}`, "#000", "center", 2);
    label(c, title, x + 170, y - 4, `500 56px ${f.sans}`, "#fff", "left", -1);
    label(c, size, W - 150, y - 16, `500 46px ${f.mono}`, "#fff", "right", 0);
    label(c, kind, W - 150, y + 34, `400 20px ${f.mono}`, "#808080", "right", 5);
    c.strokeStyle = "#333";
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(150, y + 84);
    c.lineTo(W - 150, y + 84);
    c.stroke();
    c.restore();
  });
  const close = out(seg(t, 7.1, 7.5));
  label(c, "ONE APPROVAL OPENS BOTH", 150, 850 + (1 - close) * 30, `500 84px ${f.sans}`, white(close), "left", -2);
  label(c, "YOU REVIEW AND CONFIRM EVERY POSITION", 150, 940, `400 22px ${f.mono}`, `rgba(128,128,128,${out(seg(t, 7.5, 7.9))})`, "left", 6);
  hud(c, t + 27.6, f, "HEDGE AGENT / PLAIN ENGLISH IN, POSITIONS OUT");
  glitch(c, t, t < 0.12 || (t > HEDGE_LEGS_AT && t < HEDGE_LEGS_AT + 0.15) ? 1 : 0);
}

function horizon(c: Ctx, t: number, alpha: number) {
  const R = 3000;
  const cy = 800 + R;
  for (const [u, v, w] of HORIZON) {
    const a = -Math.PI / 2 + (u - 0.5) * 0.74;
    const r = R + v * 150 - 4;
    const tw = 0.55 + 0.45 * Math.sin(t * 2.4 + w * 40);
    const mid = 1 - Math.abs(u - 0.5) * 1.5;
    dot(c, W / 2 + Math.cos(a) * r, cy + Math.sin(a) * r, 3 + (1 - v) * 4, alpha * tw * mid * (1 - v * 0.8));
  }
  c.fillStyle = "#000";
  c.beginPath();
  c.arc(W / 2, cy, R - 6, 0, Math.PI * 2);
  c.fill();
}

// 36.4 to 40.4: the claim.
function sceneClaim(c: Ctx, t: number, f: Fonts) {
  horizon(c, t, out(seg(t, 0, 0.8)));
  const s = 1.18 - inOut(seg(t, 0, 4)) * 0.26;
  c.save();
  c.translate(W / 2, 470);
  c.scale(s, s);
  label(c, "PREDICTION MARKETS NOW HAVE LEVERAGE", 0, 0, `500 58px ${f.sans}`, white(out(seg(t, 0.1, 0.6)) * (1 - seg(t, 3.6, 4))), "center", 5);
  c.restore();
}

function mark(c: Ctx, x: number, y: number, s: number) {
  // The site's mark: a baseline, a fulcrum and a lever.
  const k = s / 20;
  c.lineCap = "square";
  c.strokeStyle = "#808080";
  c.lineWidth = 1.5 * k;
  c.beginPath();
  c.moveTo(x + 2 * k, y + 16.5 * k);
  c.lineTo(x + 18 * k, y + 16.5 * k);
  c.stroke();
  c.strokeStyle = "#fff";
  c.beginPath();
  c.moveTo(x + 7 * k, y + 16.5 * k);
  c.lineTo(x + 10 * k, y + 11 * k);
  c.lineTo(x + 13 * k, y + 16.5 * k);
  c.stroke();
  c.lineWidth = 2 * k;
  c.beginPath();
  c.moveTo(x + 3 * k, y + 13.5 * k);
  c.lineTo(x + 17 * k, y + 4.5 * k);
  c.stroke();
}

// 40.4 to 46.8: the name.
function sceneLogo(c: Ctx, t: number, f: Fonts) {
  horizon(c, t + 4, 1 - seg(t, 0.6, 2.2));
  const reveal = inOut(seg(t, 0.3, 1.5));
  const five = out(seg(t, 1.7, 2.1));
  c.font = `500 190px ${f.sans}`;
  (c as Ctx & { letterSpacing: string }).letterSpacing = "-6px";
  const word = c.measureText("Vectis").width;
  const m = 150;
  const total = m + 40 + word + 300;
  const x = W / 2 - total / 2 + (1 - inOut(seg(t, 1.5, 2.1))) * 150;
  c.save();
  c.beginPath();
  c.rect(x - 20, 300, (m + 40 + word + 40) * reveal, 400);
  c.clip();
  mark(c, x, 440 - 6, m);
  label(c, "Vectis", x + m + 40, 500, `500 190px ${f.sans}`, "#fff", "left", -6);
  c.restore();
  label(c, "5x", x + m + 40 + word + 50 + (1 - five) * 40, 512, `400 170px ${f.mono}`, white(five * 0.62), "left", -6);
  label(c, "Leverage for prediction markets", W / 2, 690, `400 40px ${f.sans}`, white(out(seg(t, 2.5, 3))), "center", 0);
  label(c, "GEMINI PREDICTION MARKETS  /  USDC ON ARC TESTNET  /  VECTIS-MAUVE.VERCEL.APP", W / 2, 960, `400 20px ${f.mono}`, `rgba(128,128,128,${out(seg(t, 3.1, 3.6))})`, "center", 4);
  c.fillStyle = `rgba(0,0,0,${seg(t, 5.6, 6.3)})`;
  c.fillRect(0, 0, W, H);
}

/** Scene starts. Each cut gets a short white flash. */
const CUTS = [3.2, 7.6, 9.4, 10.6, 12.1, 13.6, 17, 20.6, 23.6, 25.6, 27.6, 36.4];

export function drawTrailer(c: Ctx, time: number, A: Assets) {
  const t = Math.min(Math.max(time, 0), DURATION);
  const f = A.fonts;
  c.save();
  c.setTransform(c.canvas.width / W, 0, 0, c.canvas.height / H, 0, 0);
  c.fillStyle = "#000";
  c.fillRect(0, 0, W, H);
  if (t < 3.2) sceneKey(c, t, f);
  else if (t < 7.6) sceneGrid(c, t - 3.2, f);
  else if (t < 10.6) sceneSphere(c, t - 7.6, f);
  else if (t < 13.6) sceneKeys(c, t - 10.6, f);
  else if (t < 17) sceneTorus(c, t - 13.6, f);
  else if (t < 20.6) sceneStack(c, t - 17, f);
  else if (t < 23.6) sceneHistory(c, t - 20.6, A);
  else if (t < 27.6) sceneChart(c, t - 23.6, f);
  else if (t < 36.4) sceneHedge(c, t - 27.6, f);
  else if (t < 40.4) sceneClaim(c, t - 36.4, f);
  else sceneLogo(c, t - 40.4, f);
  for (const cut of CUTS) {
    const d = t - cut;
    if (d >= 0 && d < 0.1) {
      c.fillStyle = white((1 - d / 0.1) * 0.55);
      c.fillRect(0, 0, W, H);
    }
  }
  c.restore();
}

/** Sample a line of text into dot positions, centred on the origin. Needs the fonts loaded. */
export function buildAssets(fonts: Fonts): Assets {
  const cv = document.createElement("canvas");
  cv.width = 1700;
  cv.height = 260;
  const c = cv.getContext("2d", { willReadFrequently: true });
  const history: Pt[] = [];
  if (c) {
    label(c, "1x IS HISTORY", cv.width / 2, cv.height / 2, `500 170px ${fonts.sans}`, "#fff", "center", -3);
    const px = c.getImageData(0, 0, cv.width, cv.height).data;
    for (let y = 0; y < cv.height; y += 4) {
      for (let x = 0; x < cv.width; x += 4) {
        if ((px[(y * cv.width + x) * 4 + 3] ?? 0) > 128) history.push([x - cv.width / 2, y - cv.height / 2]);
      }
    }
  }
  return { fonts, history, historyW: 1300 };
}
