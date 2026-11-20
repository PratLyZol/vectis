// Synthesized soundtrack for the trailer: drone, pulse, hits on the cuts, key clicks, a riser and a closing chord.
import { writeFileSync } from "node:fs";
const SR = 44100, DUR = 43.2, N = Math.round(SR * DUR);
const L = new Float32Array(N), R = new Float32Array(N);
let seed = 1; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
const add = (at, len, fn, pan = 0) => { const s = Math.floor(at * SR); for (let i = 0; i < len * SR && s + i < N; i++) { const v = fn(i / SR); L[s + i] += v * (1 - pan) ; R[s + i] += v * (1 + pan); } };
const TAU = Math.PI * 2;
// drone
add(0, 36.8, (t) => { const env = Math.min(1, t / 3) * Math.min(1, (36.8 - t) / 0.4); return env * 0.11 * (Math.sin(TAU * 55 * t) + 0.5 * Math.sin(TAU * 82.4 * t + Math.sin(t * 0.7)) + 0.25 * Math.sin(TAU * 110.3 * t)) * (0.8 + 0.2 * Math.sin(t * 1.3)); });
// pulse: sixteenth ticks from 3.2 to 27.6, getting louder
for (let t = 3.2; t < 27.6; t += 0.15) add(t, 0.03, (x) => rnd() * Math.exp(-x * 220) * (0.05 + 0.1 * (t - 3.2) / 24.4), Math.sin(t * 5) * 0.4);
// sub kick every 0.6s from 7.6
for (let t = 7.6; t < 27.6; t += 0.6) add(t, 0.3, (x) => 0.32 * Math.sin(TAU * (48 + 60 * Math.exp(-x * 30)) * x) * Math.exp(-x * 11));
// hits on cuts
const hit = (at, g = 1) => add(at, 1.2, (x) => g * (0.5 * Math.sin(TAU * (38 + 90 * Math.exp(-x * 18)) * x) * Math.exp(-x * 4) + 0.22 * rnd() * Math.exp(-x * 14)));
for (const c of [3.2, 7.6, 9.4, 10.6, 12.1, 13.6, 17, 20.6, 23.6, 25.6, 27.6]) hit(c, 0.8);
hit(24.7, 1.5); hit(30, 0.9); hit(32.8, 0.8); hit(36.8, 1.2);
// hedge scene: soft typing, then a slow pulse under the proposal
for (let t = 27.8; t < 29.4; t += 0.075) add(t, 0.05, (x) => 0.16 * (rnd() * Math.exp(-x * 200) + Math.sin(TAU * 1500 * x) * Math.exp(-x * 120) * 0.4), Math.sin(t * 9) * 0.3);
for (let t = 30; t < 36.8; t += 0.6) add(t, 0.3, (x) => 0.2 * Math.sin(TAU * (48 + 60 * Math.exp(-x * 30)) * x) * Math.exp(-x * 11));
// key clicks
const click = (at) => add(at, 0.12, (x) => 0.45 * (rnd() * Math.exp(-x * 160) + Math.sin(TAU * 1900 * x) * Math.exp(-x * 90) * 0.5 + Math.sin(TAU * 140 * x) * Math.exp(-x * 40)));
for (const k of [1.3, 10.82, 11.08, 11.34, 12.32, 12.58]) click(k);
// slabs landing
[17.5, 18.15, 18.55, 18.95, 19.35].forEach((t, i) => add(t, 0.4, (x) => 0.3 * Math.sin(TAU * (110 * Math.pow(1.122, i * 2)) * x) * Math.exp(-x * 9)));
// riser into the liquidation
add(20.6, 4.1, (x) => { const p = x / 4.1; return 0.1 * p * p * (rnd() * 0.5 + Math.sin(TAU * (200 + 900 * p * p) * x)); });
// closing chord
for (const [f, g] of [[110, 1], [164.8, 0.7], [220, 0.6], [329.6, 0.35], [440, 0.2]]) add(36.8, 6.4, (x) => 0.09 * g * Math.sin(TAU * f * x + 0.3 * Math.sin(TAU * 0.2 * x)) * Math.min(1, x / 0.05) * Math.exp(-x * 0.45) * Math.min(1, (6.4 - x) / 0.8));
// ---- sound effects on the standout visual moments ----
// one-pole lowpassed noise; cutoff in Hz may change per call
const lpNoise = () => { let y = 0; return (fc) => { const a = 1 - Math.exp(-TAU * fc / SR); y += a * (rnd() - y); return y; }; };
// phase-accumulating sine so frequency can sweep smoothly
const osc = () => { let ph = 0; return (f) => { ph += TAU * f / SR; return Math.sin(ph); }; };
const env = (x, a, len) => Math.min(1, x / a) * Math.max(0, Math.min(1, (len - x) / (len * 0.4)));
// short bright FM ping
const ping = (at, f, g = 0.12, pan = 0) => add(at, 0.9, (x) => g * Math.sin(TAU * f * x + 1.6 * Math.exp(-x * 9) * Math.sin(TAU * f * 2.01 * x)) * Math.min(1, x / 0.003) * Math.exp(-x * 5.5), pan);
// whoosh: filtered noise with rising cutoff and level, plus an optional pitched sweep
const whoosh = (at, len, f0, f1, g, pan0 = 0, pan1 = 0, tone = 0) => { const n = lpNoise(), o = osc(); const s = Math.floor(at * SR);
  for (let i = 0; i < len * SR && s + i < N; i++) { const p = i / (len * SR), fc = f0 * Math.pow(f1 / f0, p);
    const v = g * Math.pow(p, 1.6) * Math.min(1, (1 - p) * 25) * (n(fc) * 2.2 + tone * o(fc * 0.25)); const pan = pan0 + (pan1 - pan0) * p; L[s + i] += v * (1 - pan); R[s + i] += v * (1 + pan); } };
// digital glitch: bit-crushed, sample-held square stutters
const glitch = (at, len, g = 0.1) => { for (let t = at; t < at + len; t += 0.045) { const f = 300 + 1800 * Math.abs(rnd()), hold = 2 + Math.floor(Math.abs(rnd()) * 14), pan = rnd() * 0.7, dur = 0.018 + Math.abs(rnd()) * 0.025; let hv = 0;
  add(t, dur, (x) => { const k = Math.floor(x * SR); if (k % hold === 0) hv = Math.round((Math.sign(Math.sin(TAU * f * x)) * 0.6 + rnd() * 0.4) * 4) / 4; return g * hv * Math.min(1, (dur - x) / 0.003); }, pan); } };
// 0-3.2 keycap: shimmer on the flip, whoosh through the zoom into the cut
ping(1.3, 1760, 0.1, -0.2); ping(1.34, 2637, 0.06, 0.25); ping(1.4, 3520, 0.035, 0);
add(1.37, 1.1, (x) => 0.03 * Math.sin(TAU * (900 + 1400 * x) * x) * Math.exp(-x * 3) * Math.min(1, x / 0.05));
whoosh(2.45, 0.75, 300, 7000, 0.16, 0, 0, 0.3);
// 3.2-7.6 grid: glitch bursts, faint tone following the sweep
glitch(3.2, 0.35, 0.09); glitch(5.3, 0.3, 0.08);
{ const o = osc(); add(3.5, 3.4, (x) => 0.035 * o(330 * Math.pow(2, x / 3.4)) * env(x, 0.6, 3.4), 0); }
// 9.4-10.6 tunnel: accelerating whoosh with a doppler-ish rising/falling tone
whoosh(9.4, 1.2, 200, 9000, 0.2, -0.3, 0.3, 0.5);
{ const o = osc(); add(9.4, 1.2, (x) => { const p = x / 1.2; return 0.05 * p * p * o(180 + 700 * p * p * p) * Math.min(1, (1.2 - x) / 0.05); }); }
// 10.6-13.6 typing: confirm tones for YES (up, bright) and NO (down, lower)
ping(11.6, 1046.5, 0.08, -0.1); ping(11.68, 1568, 0.07, 0.1);
ping(12.85, 659.3, 0.08, 0.1); ping(12.93, 440, 0.08, -0.1);
// 13.6-17 torus: slow pad swell
for (const [f, g] of [[82.4, 1], [123.5, 0.6], [164.8, 0.45], [247, 0.2]]) add(13.6, 3.4, (x) => 0.045 * g * Math.sin(TAU * f * x + 0.4 * Math.sin(TAU * 0.35 * x)) * Math.pow(Math.sin(Math.PI * x / 3.4), 2) * (0.85 + 0.15 * Math.sin(TAU * 1.7 * x)), 0);
// 17-20.6 slabs: weighty thud under each landing, rumble during the shake
for (const t of [17.5, 18.15, 18.55, 18.95, 19.35]) { const n = lpNoise(); add(t, 0.35, (x) => 0.32 * Math.sin(TAU * (34 + 70 * Math.exp(-x * 25)) * x) * Math.exp(-x * 12) + 0.18 * n(600) * 4 * Math.exp(-x * 30)); }
{ const n = lpNoise(), o = osc(); add(20.05, 0.6, (x) => { const p = x / 0.55; return Math.min(1, (0.6 - x) / 0.03) * 0.22 * p * (n(180) * 5 + 0.5 * o(31 + 6 * Math.sin(TAU * 11 * x))); }); }
// 20.6-23.6 "1x IS HISTORY": impact on landing, panning filtered sweep for the dissolve
hit(20.65, 0.7); { const n = lpNoise(); add(20.65, 0.5, (x) => 0.12 * n(2500) * 3 * Math.exp(-x * 10)); }
{ const n = lpNoise(); const len = 1.5; add(22.0, len, (x) => { const p = x / len, v = 0.1 * Math.sin(Math.PI * p) * n(500 + 5500 * p) * 2.5; return v; }, 0); }
{ const n = lpNoise(), s = Math.floor(22.0 * SR), len = 1.5; for (let i = 0; i < len * SR; i++) { const p = i / (len * SR), v = 0.07 * Math.sin(Math.PI * p) * n(800 + 6000 * p) * 3, pan = -0.85 + 1.7 * p; L[s + i] += v * (1 - pan); R[s + i] += v * (1 + pan); } }
// 25.6-27.6 profit counter: rising count-up ticks then a bell
for (let t = 25.6, k = 0; t < 26.9; k++) { const p = (t - 25.6) / 1.3; ping(t, 1200 + 1400 * p, 0.03, Math.sin(k * 1.7) * 0.3); t += 0.075 - 0.045 * p; }
for (const [f, g] of [[1568, 1], [3136, 0.4], [4704, 0.15]]) add(26.9, 1.6, (x) => 0.1 * g * Math.sin(TAU * f * x) * Math.min(1, x / 0.002) * Math.exp(-x * 3.2));
// 27.6-32.8 hedge agent: sonar blips, row thunks, two-note confirm chord
for (const t of [29.45, 29.65, 29.85]) add(t, 0.35, (x) => 0.06 * Math.sin(TAU * 1320 * x) * Math.min(1, x / 0.004) * Math.exp(-x * 14) * (1 + 0.5 * Math.sin(TAU * 25 * x)), (t - 29.65) * 3);
for (const t of [30.0, 30.3]) { const n = lpNoise(); add(t, 0.2, (x) => 0.2 * Math.sin(TAU * (90 + 120 * Math.exp(-x * 40)) * x) * Math.exp(-x * 22) + 0.08 * n(1200) * 3 * Math.exp(-x * 50)); }
for (const [f, d] of [[523.3, 0], [784, 0.12]]) for (const m of [1, 1.5]) add(31.1 + d, 1.4, (x) => 0.05 / m * Math.sin(TAU * f * m * x + 0.6 * Math.exp(-x * 6) * Math.sin(TAU * f * 2 * x)) * Math.min(1, x / 0.005) * Math.exp(-x * 2.2));
// 32.8-36.8 claim: low swell
add(32.8, 4.0, (x) => 0.05 * Math.sin(TAU * 41.2 * x) * Math.pow(Math.sin(Math.PI * x / 4.0), 2));
// 36.8-43.2 logo: sweep under the reveal, bright ping on "5x"
whoosh(37.1, 1.2, 250, 5000, 0.09, -0.4, 0.4, 0.3);
ping(38.5, 2093, 0.1, 0); ping(38.53, 3136, 0.05, 0.2);
// 23.6-25.6 liquidation: dip to near silence, then boom with falling sweep and alarm tail
{ const a = Math.floor(24.56 * SR), b = Math.floor(24.7 * SR); for (let i = a; i < b; i++) { const p = (i - a) / (b - a), g = Math.max(0.04, 1 - Math.min(1, p / 0.35)); L[i] *= g; R[i] *= g; } }
{ const o = osc(); add(24.7, 1.6, (x) => 0.55 * o(28 + 140 * Math.exp(-x * 5)) * Math.exp(-x * 2.6) * Math.min(1, x / 0.002)); }
{ const n = lpNoise(); add(24.7, 0.9, (x) => 0.3 * n(5000 * Math.exp(-x * 4) + 200) * 2.5 * Math.exp(-x * 5)); }
{ const o = osc(); add(24.7, 1.0, (x) => 0.1 * o(1600 * Math.exp(-x * 2.2) + 80) * Math.exp(-x * 2.5)); }
add(24.78, 0.6, (x) => { const f = Math.floor(x / 0.075) % 2 ? 740 : 988, s = Math.sin(TAU * f * x); return 0.09 * Math.tanh(s * 4) * Math.min(1, x / 0.01) * Math.min(1, (0.6 - x) / 0.15); }, 0.15);
const buf = Buffer.alloc(44 + N * 4);
buf.write("RIFF", 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write("WAVEfmt ", 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) { buf.writeInt16LE(Math.round(Math.tanh(L[i] * 1.4) * 30000), 44 + i * 4); buf.writeInt16LE(Math.round(Math.tanh(R[i] * 1.4) * 30000), 46 + i * 4); }
writeFileSync(process.argv[2], buf);
