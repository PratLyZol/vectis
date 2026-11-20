"use client";

import { useEffect, useId, useRef, useState } from "react";
import { fmtLeverage, fmtPrice, fmtUsdc } from "@/lib/format";
import { SSE_CONTENT_TYPE, readHedgeStream } from "@/lib/hedge/sse";
import type { HedgeLeg, HedgeMessage, HedgeProposal as Proposal, HedgeResponse, HedgeStepEvent, HedgeStepKind } from "@/lib/types";
import { HedgeProposal } from "./HedgeProposal";

const EXAMPLES = [
  "I run a laundromat in Denver. Natural gas for the dryers and water heaters costs about $900 a month and I can put $200 toward a hedge.",
  "I hold 20 ETH and I'm worried about a drop before the end of the month. Budget $500.",
  "Our fund is short copper miners. Protect us against a copper spike this month with a $5,000 budget.",
  "My business has a $400k floating-rate loan. Hedge against the Fed not cutting in December, $300 budget.",
];

const MAX_HISTORY = 16;

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
const LOG_LINES = 6;
const TYPE_MS_PER_CHAR = 15;
const TYPE_MAX_MS = 1_500;

type Step = { id: number; kind: HedgeStepKind; label: string; detail?: string };

// What the agent is doing for the request in flight.
type Activity = {
  startedAt: number;
  active: (Step & { since: number }) | null;
  idleSince: number; // when the last step finished (or the request started)
  done: Step[];
  announce: string; // the last real step label, for screen readers
};

// A conversation turn. Proposal turns keep a snapshot of the legs so the thread shows them as
// positions; `content` is the short text the model sees as its own earlier reply. Agent turns
// keep the steps that produced them.
type Turn = HedgeMessage & { legs?: HedgeLeg[]; steps?: Step[]; seconds?: number };

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function useClock(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function StepList({ steps }: { steps: Step[] }) {
  return (
    <ul className="flex flex-col gap-1">
      {steps.map((s) => (
        <li key={s.id} className="row-new flex items-baseline justify-between gap-4 text-[13px] text-muted">
          <span className="min-w-0 truncate">{s.label}</span>
          {s.detail ? <span className="num shrink-0 text-[12px]">{s.detail}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** The live status line and the last few finished steps, while the agent works. */
function AgentActivity({ activity }: { activity: Activity }) {
  const now = useClock(500);
  const { active } = activity;
  // A running tool shows its label; a model step shows "Thinking" for its first VERB_MS, then
  // hands over to the rotating verbs, as does the gap between steps.
  const real = active && (active.kind === "tool" || now - active.since < VERB_MS);
  const verbFrom = active ? active.since + VERB_MS : activity.idleSince;
  const verb = VERBS[(activity.done.length + Math.floor(Math.max(0, now - verbFrom) / VERB_MS)) % VERBS.length]!;
  const text = `${real ? active.label : verb}…`;
  const seconds = Math.max(0, Math.floor((now - activity.startedAt) / 1000));
  const log = activity.done.slice(-LOG_LINES);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 text-[15px]" role="status">
        <span className="agent-pulse shrink-0 text-text" aria-hidden="true" />
        {/* Screen readers hear real step labels only, not the rotating verbs. */}
        <span className="sr-only">{activity.announce || "Working"}</span>
        <span key={text} className="fade-in min-w-0 flex-1 truncate text-text-2" aria-hidden="true">
          {text}
        </span>
        <span className="num shrink-0 text-[12px] text-muted" aria-hidden="true">
          {seconds}s
        </span>
      </div>
      {log.length ? (
        <div aria-hidden="true">
          <StepList steps={log} />
        </div>
      ) : null}
    </div>
  );
}

/** The steps behind a finished turn, collapsed. */
function StepsSummary({ steps, seconds }: { steps: Step[]; seconds?: number }) {
  return (
    <details className="text-[12px] text-muted">
      <summary className="cursor-pointer select-none">
        {steps.length} step{steps.length === 1 ? "" : "s"}
        {seconds !== undefined ? (
          <>
            {" "}
            · <span className="num">{seconds}s</span>
          </>
        ) : null}
      </summary>
      <div className="mt-2">
        <StepList steps={steps} />
      </div>
    </details>
  );
}

/**
 * Types a new agent question out quickly. The full text is in the accessibility tree from the
 * start (so it is announced once), and the untyped rest holds its space so the bubble does not
 * grow. Under a reduced-motion preference the text is simply there.
 */
function Typewriter({ text }: { text: string }) {
  const [shown, setShown] = useState(() => (reducedMotion() ? text.length : 0));
  useEffect(() => {
    if (shown >= text.length) return;
    const perChar = Math.min(TYPE_MS_PER_CHAR, TYPE_MAX_MS / text.length);
    const start = performance.now() - shown * perChar;
    let frame = requestAnimationFrame(function tick(t) {
      const n = Math.min(text.length, Math.floor((t - start) / perChar));
      setShown(n);
      if (n < text.length) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
    // Runs once per text; `shown` only seeds the start time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  if (shown >= text.length) return <>{text}</>;
  return (
    <>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {text.slice(0, shown)}
        <span className="opacity-0">{text.slice(shown)}</span>
      </span>
    </>
  );
}

function ProposalTurn({ legs }: { legs: HedgeLeg[] }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[12px] text-muted">
        {legs.length ? `Earlier proposal · ${legs.length} position${legs.length === 1 ? "" : "s"}` : "No matching market found"}
      </p>
      {legs.length ? (
        <ul className="flex flex-col divide-y divide-border">
          {legs.map((l) => (
            <li key={`${l.symbol}:${l.side}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-[14px]">
              <span className={`font-medium ${l.side === "yes" ? "text-text" : "text-danger"}`}>{l.side === "yes" ? "Yes" : "No"}</span>
              <span className="min-w-0 flex-1 text-text">
                {l.eventTitle} <span className="text-muted">· {l.label}</span>
              </span>
              <span className="num text-text-2">
                ${fmtUsdc(BigInt(l.margin))} · {fmtLeverage(l.leverage)} · {fmtPrice(l.price)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function HedgeAgent() {
  const uid = useId();
  const [messages, setMessages] = useState<Turn[]>([]);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || loading) return;
    const next = [...messages, { role: "user" as const, content }].slice(-MAX_HISTORY);
    setMessages(next);
    setInput("");
    setError(null);
    setLoading(true);
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    const startedAt = Date.now();
    setActivity({ startedAt, active: null, idleSince: startedAt, done: [], announce: "" });
    const steps: Step[] = [];
    const onStep = (e: HedgeStepEvent) => {
      if (abort.current !== ctrl) return;
      const step: Step = { id: e.id, kind: e.kind, label: e.label, ...(e.detail ? { detail: e.detail } : {}) };
      const at = Date.now();
      // Model steps drive the live status line only; the log and the step count list tool work.
      const logged = e.phase === "done" && e.kind !== "model";
      if (logged) steps.push(step);
      setActivity((a) => {
        if (!a) return a;
        if (e.phase === "start") return { ...a, active: { ...step, since: at }, announce: step.label };
        return {
          ...a,
          active: a.active?.id === e.id ? null : a.active,
          idleSince: a.active?.id === e.id ? at : a.idleSince,
          done: logged ? [...a.done, step] : a.done,
        };
      });
    };
    try {
      const res = await fetch("/api/hedge", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: `${SSE_CONTENT_TYPE}, application/json` },
        body: JSON.stringify({ messages: next.map(({ role, content }) => ({ role, content })), proposal }),
        signal: ctrl.signal,
      });
      // Streamed answers carry progress steps; anything else (errors before the agent starts, or
      // a server without streaming) is the plain JSON body.
      const streamed = (res.headers.get("content-type") ?? "").includes(SSE_CONTENT_TYPE) && res.body;
      const data = streamed
        ? await readHedgeStream(res.body!, onStep)
        : ((await res.json().catch(() => null)) as HedgeResponse | null);
      if (!data) throw new Error(streamed ? "The hedge agent stopped before answering." : `The hedge agent did not answer (${res.status}).`);
      if (data.type === "error") throw new Error(data.error);
      const trail = steps.length ? { steps, seconds: Math.round((Date.now() - startedAt) / 1000) } : {};
      if (data.type === "question") {
        setMessages((m) => [...m, { role: "assistant", content: data.question, ...trail }]);
      } else {
        setProposal(data.proposal);
        const { legs } = data.proposal;
        // What the model sees as its earlier reply; the thread shows the legs, not this text.
        const content = legs.length
          ? `Proposed: ${legs.map((l) => `${l.side} ${l.eventTitle}: ${l.label}, ${fmtUsdc(BigInt(l.margin))} USDC at ${fmtLeverage(l.leverage)}`).join("; ")}`
          : `Proposed no legs. ${data.proposal.notes[0] ?? ""}`;
        setMessages((m) => [...m, { role: "assistant", content: content.slice(0, 1800), legs, ...trail }]);
      }
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setError(e instanceof Error ? e.message : "The hedge agent failed.");
      // Drop the unanswered message so a retry does not send it twice.
      setMessages((m) => (m.at(-1)?.role === "user" ? m.slice(0, -1) : m));
      setInput(content);
    } finally {
      if (abort.current === ctrl) {
        setLoading(false);
        setActivity(null);
      }
    }
  };

  const startOver = () => {
    abort.current?.abort();
    setMessages([]);
    setProposal(null);
    setInput("");
    setError(null);
    setLoading(false);
    setActivity(null);
  };

  const started = messages.length > 0;
  const lastProposal = messages.findLastIndex((m) => m.legs !== undefined);
  const placeholder = proposal
    ? "e.g. make it cheaper, or drop the oil leg"
    : "Describe what you want to protect against: what you hold or pay, how much, and your budget for the hedge.";

  return (
    <div className="mt-8 flex flex-col gap-6">
      {started ? (
        <ol className="flex flex-col gap-3" aria-label="Conversation" aria-live="polite">
          {messages.map((m, i) =>
            // The current proposal renders in full below the thread; only its steps stay here.
            m.legs && i === lastProposal && proposal ? (
              m.steps?.length ? (
                <li key={i} className="self-start px-4">
                  <StepsSummary steps={m.steps} seconds={m.seconds} />
                </li>
              ) : null
            ) : (
            <li
              key={i}
              className={`${m.legs ? "w-full" : "whitespace-pre-wrap"} max-w-[72ch] rounded-md px-4 py-3 text-[15px] ${
                m.role === "user" ? "self-end bg-raised" : "self-start border border-border text-text-2"
              }`}
            >
              <span className="sr-only">{m.role === "user" ? "You: " : "Agent: "}</span>
              {m.legs ? <ProposalTurn legs={m.legs} /> : m.role === "assistant" && i === messages.length - 1 ? <Typewriter text={m.content} /> : m.content}
              {m.steps?.length ? (
                <div className="mt-3 whitespace-normal">
                  <StepsSummary steps={m.steps} seconds={m.seconds} />
                </div>
              ) : null}
            </li>
            ),
          )}
          {loading && activity ? (
            <li className="w-full max-w-[72ch] self-start px-4 py-3">
              <AgentActivity activity={activity} />
            </li>
          ) : null}
        </ol>
      ) : null}

      {proposal ? <HedgeProposal key={proposal.quotedAt} proposal={proposal} onChange={setProposal} locked={loading} /> : null}

      <form
        className="card flex flex-col gap-3 p-4 md:p-6"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <label htmlFor={`${uid}-q`} className="text-[16px] font-medium">
          {proposal ? "Refine the hedge" : started ? "Your answer" : "What do you want to hedge?"}
        </label>
        <textarea
          id={`${uid}-q`}
          className={`field py-3 ${proposal ? "min-h-[56px]" : "min-h-[96px]"}`}
          rows={proposal ? 2 : 4}
          value={input}
          maxLength={2000}
          placeholder={placeholder}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send(input);
            }
          }}
        />
        {!started ? (
          <div className="flex flex-col gap-2">
            <p className="text-[12px] text-muted">Examples</p>
            <div className="flex flex-wrap gap-2">
              {EXAMPLES.map((ex) => (
                <button key={ex} type="button" className="btn btn-secondary h-auto max-w-full whitespace-normal px-3 py-2 text-left text-[13px]" onClick={() => setInput(ex)}>
                  {ex}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className="btn btn-primary" disabled={loading || !input.trim()}>
            {loading ? "Working…" : proposal ? "Update hedge" : started ? "Send" : "Find a hedge"}
          </button>
          {started ? (
            <button type="button" className="btn btn-outline" onClick={startOver}>
              Start over
            </button>
          ) : null}
        </div>
        {error ? (
          <p className="note text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </form>

    </div>
  );
}
