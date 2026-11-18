// Synthesized soundtrack for the trailer: drone, pulse, hits on the cuts, key clicks, a riser and a closing chord.
import { writeFileSync } from "node:fs";
const SR = 44100, DUR = 38, N = SR * DUR;
const L = new Float32Array(N), R = new Float32Array(N);
let seed = 1; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
const add = (at, len, fn, pan = 0) => { const s = Math.floor(at * SR); for (let i = 0; i < len * SR && s + i < N; i++) { const v = fn(i / SR); L[s + i] += v * (1 - pan) ; R[s + i] += v * (1 + pan); } };
const TAU = Math.PI * 2;
// drone
add(0, 31.6, (t) => { const env = Math.min(1, t / 3) * Math.min(1, (31.6 - t) / 0.4); return env * 0.11 * (Math.sin(TAU * 55 * t) + 0.5 * Math.sin(TAU * 82.4 * t + Math.sin(t * 0.7)) + 0.25 * Math.sin(TAU * 110.3 * t)) * (0.8 + 0.2 * Math.sin(t * 1.3)); });
// pulse: sixteenth ticks from 3.2 to 27.6, getting louder
for (let t = 3.2; t < 27.6; t += 0.15) add(t, 0.03, (x) => rnd() * Math.exp(-x * 220) * (0.05 + 0.1 * (t - 3.2) / 24.4), Math.sin(t * 5) * 0.4);
// sub kick every 0.6s from 7.6
for (let t = 7.6; t < 27.6; t += 0.6) add(t, 0.3, (x) => 0.32 * Math.sin(TAU * (48 + 60 * Math.exp(-x * 30)) * x) * Math.exp(-x * 11));
// hits on cuts
const hit = (at, g = 1) => add(at, 1.2, (x) => g * (0.5 * Math.sin(TAU * (38 + 90 * Math.exp(-x * 18)) * x) * Math.exp(-x * 4) + 0.22 * rnd() * Math.exp(-x * 14)));
for (const c of [3.2, 7.6, 9.4, 10.6, 12.1, 13.6, 17, 20.6, 23.6, 25.6, 27.6]) hit(c, 0.8);
hit(24.7, 1.5); hit(31.6, 1.2);
// key clicks
const click = (at) => add(at, 0.12, (x) => 0.45 * (rnd() * Math.exp(-x * 160) + Math.sin(TAU * 1900 * x) * Math.exp(-x * 90) * 0.5 + Math.sin(TAU * 140 * x) * Math.exp(-x * 40)));
for (const k of [1.3, 10.82, 11.08, 11.34, 12.32, 12.58]) click(k);
// slabs landing
[17.5, 18.15, 18.55, 18.95, 19.35].forEach((t, i) => add(t, 0.4, (x) => 0.3 * Math.sin(TAU * (110 * Math.pow(1.122, i * 2)) * x) * Math.exp(-x * 9)));
// riser into the liquidation
add(20.6, 4.1, (x) => { const p = x / 4.1; return 0.1 * p * p * (rnd() * 0.5 + Math.sin(TAU * (200 + 900 * p * p) * x)); });
// closing chord
for (const [f, g] of [[110, 1], [164.8, 0.7], [220, 0.6], [329.6, 0.35], [440, 0.2]]) add(31.6, 6.4, (x) => 0.09 * g * Math.sin(TAU * f * x + 0.3 * Math.sin(TAU * 0.2 * x)) * Math.min(1, x / 0.05) * Math.exp(-x * 0.45) * Math.min(1, (6.4 - x) / 0.8));
const buf = Buffer.alloc(44 + N * 4);
buf.write("RIFF", 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write("WAVEfmt ", 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) { buf.writeInt16LE(Math.round(Math.tanh(L[i] * 1.4) * 30000), 44 + i * 4); buf.writeInt16LE(Math.round(Math.tanh(R[i] * 1.4) * 30000), 46 + i * 4); }
writeFileSync(process.argv[2], buf);
