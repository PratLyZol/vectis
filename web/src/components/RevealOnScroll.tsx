"use client";

import { useEffect } from "react";

/**
 * One-time scroll reveal for the landing page and /lend. Sections marked `data-reveal` that start below
 * the fold are set to "pending" (hidden by CSS) and switched to "visible" the first time they
 * come into view. Sections already on screen, and every section without script, stay visible.
 */
export function RevealOnScroll() {
  useEffect(() => {
    const pending = new Set<HTMLElement>();
    for (const el of document.querySelectorAll<HTMLElement>("[data-reveal]")) {
      if (el.getBoundingClientRect().top < window.innerHeight) continue;
      el.dataset.reveal = "pending";
      pending.add(el);
    }
    if (pending.size === 0) return;

    // A section is revealed once its top is 100px inside the viewport, or once it has been
    // scrolled past (a jump to the end of the page must not leave anything hidden above).
    let frame = 0;
    const check = () => {
      frame = 0;
      for (const el of pending) {
        if (el.getBoundingClientRect().top < window.innerHeight - 100) {
          el.dataset.reveal = "visible";
          pending.delete(el);
        }
      }
      if (pending.size === 0) stop();
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    const stop = () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return stop;
  }, []);
  return null;
}
