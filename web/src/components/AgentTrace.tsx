"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { HedgeStepKind } from "@/lib/types";

// One row of the agent's trace, in arrival order. Tool rows carry server template labels; thought
// rows carry model free text, rendered as plain text only.
export type TraceItem =
  | { type: "tool"; id: number; label: string; detail?: string; done: boolean }
  | { type: "thought"; id: number; text: string };

// What the agent is doing right now, while the request is in flight.
export type TraceLive = {
  startedAt: number;
  active: { id: number; kind: HedgeStepKind; label: string; since: number } | null;
  idleSince: number; // when the last step finished (or the request started)
  announce: string; // the last real step label, for screen readers
};

// Shown on the status line between steps and during a long model step. Real step labels from
// the server take over whenever a tool runs.
const VERBS = [
  "Sizing up the exposure",
  "Scanning markets",
  "Reading the ladder",
  "Checking the book",
  "Pricing legs",
  "Weighing leverage",
  "Stress-testing the hedge",
];
const VERB_MS = 2_000;
const WORD_MS = 30;
const REVEAL_MAX_MS = 1_200;

export const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

function useClock(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** The live status line: pulse, the current step with a shimmer, elapsed seconds. */
function LiveHeader({ live, rows }: { live: TraceLive; rows: number }) {
  const now = useClock(500);
  const { active } = live;
  // A running tool shows its label; a model step shows "Thinking" for its first VERB_MS, then
  // hands over to the rotating verbs, as does the gap between steps.
  const real = active && (active.kind === "tool" || now - active.since < VERB_MS);
  const verbFrom = active ? active.since + VERB_MS : live.idleSince;
  const verb = VERBS[(rows + Math.floor(Math.max(0, now - verbFrom) / VERB_MS)) % VERBS.length]!;
  const text = `${real ? active.label : verb}…`;
  const seconds = Math.max(0, Math.floor((now - live.startedAt) / 1000));
  return (
    <div className="flex items-center gap-3 text-[15px]" role="status">
      <span className="agent-pulse shrink-0 text-text" aria-hidden="true" />
      {/* Screen readers hear real step labels only, not the rotating verbs or thoughts. */}
      <span className="sr-only">{live.announce || "Working"}</span>
      <span key={text} className="fade-in trace-shimmer min-w-0 flex-1 truncate" aria-hidden="true">
        {text}
      </span>
      <span className="num shrink-0 text-[12px] text-muted" aria-hidden="true">
        {seconds}s
      </span>
    </div>
  );
}

/**
 * A thought revealed word by word (WORD_MS per word, done within REVEAL_MAX_MS). The full text is
 * in the accessibility tree once from the start; the unrevealed rest holds its space so the
 * trace does not reflow. Once revealed, or under reduced motion, it is plain text.
 */
function RevealWords({ text, animate }: { text: string; animate: boolean }) {
  const words = text.split(" ");
  const [shown, setShown] = useState(() => (animate && !reducedMotion() ? 0 : words.length));
  useEffect(() => {
    const total = text.split(" ").length;
    if (shown >= total) return;
    const perWord = Math.min(WORD_MS, REVEAL_MAX_MS / total);
    const start = performance.now();
    let frame = requestAnimationFrame(function tick(t) {
      const n = Math.min(total, Math.floor((t - start) / perWord) + 1);
      setShown(n);
      if (n < total) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
    // Runs once per text; `shown` only decides whether to start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  if (shown >= words.length) return <>{text}</>;
  return (
    <>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {words.slice(0, shown).join(" ")}
        <span className="opacity-0"> {words.slice(shown).join(" ")}</span>
      </span>
    </>
  );
}

function Row({ item, live }: { item: TraceItem; live: boolean }) {
  // Rows enter only while the trace is live; a reopened trace is already there.
  const enter = live ? "trace-row " : "";
  if (item.type === "thought") {
    return (
      <li className={`${enter}pl-4 text-[13px] leading-snug text-muted`}>
        <RevealWords text={item.text} animate={live} />
      </li>
    );
  }
  return (
    <li className={`${enter}relative flex items-baseline justify-between gap-4 pl-4 text-[13px] text-text-2`}>
      <span className={`trace-node ${item.done ? "is-done" : live ? "is-running" : ""}`} aria-hidden="true" />
      <span className="min-w-0 truncate">{item.label}</span>
      {item.done && item.detail ? <span className="trace-fade num shrink-0 text-[12px] text-muted">{item.detail}</span> : null}
    </li>
  );
}

/**
 * The agent's trace for one turn. While `live`, a status line over a timeline of tool steps and
 * thoughts that keeps its newest row in view. When the turn finishes it collapses to a button
 * ("Worked for 7s · 4 steps") that reopens it. The same instance goes from live to finished, so
 * the collapse animates from what was on screen.
 */
export function AgentTrace({ items, live, seconds }: { items: TraceItem[]; live?: TraceLive | null; seconds?: number }) {
  const panelId = useId();
  const isLive = !!live;
  const [open, setOpen] = useState(isLive);
  const wasLive = useRef(isLive);
  const body = useRef<HTMLDivElement>(null);
  const steps = items.filter((i) => i.type === "tool").length;

  useEffect(() => {
    if (wasLive.current && !isLive) setOpen(false);
    wasLive.current = isLive;
  }, [isLive]);

  // Scroll the trace body, never the page, to the newest row.
  useEffect(() => {
    const el = body.current;
    if (isLive && el) el.scrollTop = el.scrollHeight;
  }, [isLive, items.length]);

  return (
    <div className="flex flex-col">
      {live ? (
        <LiveHeader live={live} rows={items.length} />
      ) : (
        <button
          type="button"
          className="trace-toggle flex items-center gap-2 self-start text-left text-[13px] text-muted"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((o) => !o)}
        >
          <span>
            Worked for <span className="num">{seconds ?? 0}s</span>
            {steps ? ` · ${plural(steps, "step")}` : ""}
          </span>
          <svg className="trace-chevron" data-open={open} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M3 1.5 6.5 5 3 8.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
      )}
      <div id={panelId} className="trace-panel" data-open={open} inert={!open}>
        <div className="min-h-0 overflow-hidden">
          {items.length ? (
            <div ref={body} className="max-h-64 overflow-y-auto pt-3">
              <ol className="ml-[3px] flex flex-col gap-2 border-l border-border-2" aria-label="Agent steps">
                {items.map((item) => (
                  <Row key={`${item.type}-${item.id}`} item={item} live={isLive} />
                ))}
              </ol>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
