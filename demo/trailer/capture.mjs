// Render the /trailer page frame by frame with headless Chrome (DevTools protocol, no packages).
// usage: node capture.mjs frames <outDir> t1,t2,...   |   node capture.mjs video <out.mp4> [fps]
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [mode, outPath, arg] = process.argv.slice(2);
const PORT = 9333;
const URL_ = "http://localhost:3111/trailer?capture=1";

const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(tmpdir(), "vectis-trailer-chrome")}`,
  "--window-size=1920,1080", "--hide-scrollbars", "--no-first-run", "about:blank",
], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL_)}`, { method: "PUT" });
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error("Chrome did not start");
}

try {
  const ws = new WebSocket(await target());
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  };
  const evaluate = (expression) => new Promise((res, rej) => {
    const n = ++id;
    waiting.set(n, (m) => (m.error || m.result?.exceptionDetails ? rej(new Error(JSON.stringify(m.error ?? m.result.exceptionDetails))) : res(m.result.result.value)));
    ws.send(JSON.stringify({ id: n, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  });
  for (let i = 0; i < 150 && !(await evaluate("!!window.__trailer")); i++) await sleep(200);
  const duration = await evaluate("window.__trailer.duration");
  const frame = async (t) => Buffer.from((await evaluate(`window.__trailer.frame(${t})`)).split(",")[1], "base64");

  if (mode === "frames") {
    mkdirSync(outPath, { recursive: true });
    for (const t of arg.split(",").map(Number)) writeFileSync(join(outPath, `f${t.toFixed(2).padStart(5, "0")}.jpg`), await frame(t));
  } else {
    const fps = Number(arg ?? 30);
    const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-c:v", "mjpeg", "-framerate", String(fps), "-i", "-",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", "-preset", "medium", "-movflags", "+faststart", outPath], { stdio: ["pipe", "inherit", "inherit"] });
    const total = Math.round(duration * fps);
    for (let i = 0; i < total; i++) {
      if (!ff.stdin.write(await frame(i / fps))) await new Promise((r) => ff.stdin.once("drain", r));
    }
    ff.stdin.end();
    await new Promise((r) => ff.on("close", r));
    console.log(`${total} frames`);
  }
  ws.close();
} finally {
  chrome.kill();
}
