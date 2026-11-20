"use client";

import { useEffect, useRef, useState } from "react";
import { DURATION, H, W, buildAssets, drawTrailer, type Assets } from "@/lib/trailer";

declare global {
  interface Window {
    /** For the capture script: render one frame at full size and return it as a JPEG data URL. */
    __trailer?: { duration: number; frame: (t: number) => string };
  }
}

export function Trailer() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const state = useRef({ t: 0, playing: true, last: 0 });
  const [paused, setPaused] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const cv = canvas.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const capture = new URLSearchParams(window.location.search).has("capture");
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let assets: Assets | null = null;
    let dead = false;
    const s = state.current;

    const size = () => {
      const scale = capture ? 1 : Math.min(window.innerWidth / W, window.innerHeight / H) * Math.min(window.devicePixelRatio || 1, 2);
      cv.width = Math.round(W * scale);
      cv.height = Math.round(H * scale);
      if (assets) drawTrailer(ctx, s.t, assets);
    };

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (!assets) return;
      if (s.playing) {
        s.t += Math.min(0.1, (now - s.last) / 1000);
        if (s.t >= DURATION) {
          s.t = DURATION;
          s.playing = false;
          setPaused(true);
        }
        drawTrailer(ctx, s.t, assets);
      }
      s.last = now;
    };

    const css = getComputedStyle(document.documentElement);
    const fonts = {
      sans: `${css.getPropertyValue("--font-host-grotesk").trim() || "sans-serif"}, sans-serif`,
      mono: `${css.getPropertyValue("--font-geist-mono").trim() || "monospace"}, monospace`,
    };
    Promise.all([document.fonts.load(`500 100px ${fonts.sans}`), document.fonts.load(`400 100px ${fonts.sans}`), document.fonts.load(`500 100px ${fonts.mono}`), document.fonts.load(`400 100px ${fonts.mono}`)])
      .catch(() => null)
      .then(() => {
        if (dead) return;
        const a = buildAssets(fonts);
        assets = a;
        size();
        if (capture) {
          window.__trailer = {
            duration: DURATION,
            frame: (t) => {
              drawTrailer(ctx, t, a);
              return cv.toDataURL("image/jpeg", 0.95);
            },
          };
        } else if (reduce) {
          // No autoplay: hold on the title until the viewer asks for it.
          s.t = 43.8;
          s.playing = false;
          setPaused(true);
          drawTrailer(ctx, s.t, a);
          raf = requestAnimationFrame(tick);
        } else {
          s.last = performance.now();
          raf = requestAnimationFrame(tick);
        }
        setReady(true);
      });

    const toggle = () => {
      if (s.t >= DURATION || (reduce && !s.playing && s.t === 43.8)) s.t = 0;
      s.playing = !s.playing;
      s.last = performance.now();
      setPaused(!s.playing);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === " ") {
        e.preventDefault();
        toggle();
      } else if (e.key === "r" || e.key === "R") {
        s.t = 0;
        s.playing = true;
        s.last = performance.now();
        setPaused(false);
      } else if (e.key === "f" || e.key === "F") {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void cv.parentElement?.requestFullscreen();
      }
    };
    window.addEventListener("resize", size);
    window.addEventListener("keydown", key);
    cv.addEventListener("click", toggle);
    return () => {
      dead = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", size);
      window.removeEventListener("keydown", key);
      cv.removeEventListener("click", toggle);
      delete window.__trailer;
    };
  }, []);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black" data-ready={ready}>
      <canvas ref={canvas} className="max-h-full max-w-full cursor-pointer" style={{ aspectRatio: `${W} / ${H}` }} role="img" aria-label="Vectis trailer: leverage for prediction markets, up to 5x, with margin and lending in USDC on Arc testnet, and a hedge agent that shows its work as it turns a described risk into proposed positions." />
      <p className="pointer-events-none absolute bottom-4 left-0 right-0 text-center font-mono text-[12px] text-muted transition-opacity duration-200" style={{ opacity: paused ? 1 : 0 }}>
        Click or Space to play. R restarts. F is full screen.
      </p>
    </div>
  );
}
