"use client";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { fmtLeverage, fmtPrice, fmtUsdc } from "@/lib/format";
import { SSE_CONTENT_TYPE, readHedgeStream } from "@/lib/hedge/sse";
import type { HedgeLeg, HedgeMessage, HedgeProposal as Proposal, HedgeResponse, HedgeStepEvent, HedgeThoughtEvent } from "@/lib/types";
import { AgentTrace, type TraceItem, type TraceLive, reducedMotion } from "./AgentTrace";
import { HedgeProposal } from "./HedgeProposal";

const EXAMPLES = [
  "I run a laundromat in Denver. Natural gas for the dryers and water heaters costs about $900 a month and I can put $200 toward a hedge.",
  "I hold 20 ETH and I'm worried about a drop before the end of the month. Budget $500.",
  "Our fund is short copper miners. Protect us against a copper spike this month with a $5,000 budget.",
  "My business has a $400k floating-rate loan. Hedge against the Fed not cutting in December, $300 budget.",
];

const MAX_HISTORY = 16;

const TYPE_MS_PER_CHAR = 15;
const TYPE_MAX_MS = 1_500;

// The request in flight: its trace so far, and the id its agent turn will get.
type Activity = TraceLive & { turnId: number; items: TraceItem[] };

// A conversation turn. Proposal turns keep a snapshot of the legs so the thread shows them as
// positions; `content` is the short text the model sees as its own earlier reply. Agent turns
// keep the trace that produced them. `id` keys the thread so rows keep their state.
type Turn = HedgeMessage & { id: number; legs?: HedgeLeg[]; trace?: TraceItem[]; seconds?: number };

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
  const [said, setSaid] = useState(""); // the latest agent answer, for screen readers
  const abort = useRef<AbortController | null>(null);
  const lastId = useRef(0);
  const newId = () => ++lastId.current;
  useEffect(() => () => abort.current?.abort(), []);

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || loading) return;
    const next: Turn[] = [...messages, { id: newId(), role: "user" as const, content }].slice(-MAX_HISTORY);
    setMessages(next);
    setInput("");
    setError(null);
    setLoading(true);
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    const startedAt = Date.now();
    const turnId = newId();
    setActivity({ turnId, startedAt, active: null, idleSince: startedAt, items: [], announce: "" });
    // The trace so far, kept here too so the finished turn gets it without waiting for a render.
    let items: TraceItem[] = [];
    const onStep = (e: HedgeStepEvent) => {
      if (abort.current !== ctrl) return;
      const at = Date.now();
      // Model steps drive the live status line only; tool steps are also rows of the trace.
      if (e.kind === "tool") {
        const row: TraceItem = { type: "tool", id: e.id, label: e.label, ...(e.detail ? { detail: e.detail } : {}), done: e.phase === "done" };
        items = items.some((i) => i.type === "tool" && i.id === e.id) ? items.map((i) => (i.type === "tool" && i.id === e.id ? row : i)) : [...items, row];
      }
      const rows = items;
      setActivity((a) => {
        if (!a) return a;
        if (e.phase === "start") return { ...a, items: rows, active: { id: e.id, kind: e.kind, label: e.label, since: at }, announce: e.label };
        const ended = a.active?.id === e.id;
        return { ...a, items: rows, active: ended ? null : a.active, idleSince: ended ? at : a.idleSince };
      });
    };
    const onThought = (t: HedgeThoughtEvent) => {
      if (abort.current !== ctrl) return;
      items = [...items, { type: "thought", id: t.id, text: t.text }];
      const rows = items;
      setActivity((a) => (a ? { ...a, items: rows } : a));
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
        ? await readHedgeStream(res.body!, onStep, onThought)
        : ((await res.json().catch(() => null)) as HedgeResponse | null);
      if (!data) throw new Error(streamed ? "The hedge agent stopped before answering." : `The hedge agent did not answer (${res.status}).`);
      if (data.type === "error") throw new Error(data.error);
      const trail = items.length ? { trace: items, seconds: Math.round((Date.now() - startedAt) / 1000) } : {};
      if (data.type === "question") {
        setMessages((m) => [...m, { id: turnId, role: "assistant", content: data.question, ...trail }]);
        setSaid(`Agent: ${data.question}`);
      } else {
        setProposal(data.proposal);
        const { legs } = data.proposal;
        // What the model sees as its earlier reply; the thread shows the legs, not this text.
        const content = legs.length
          ? `Proposed: ${legs.map((l) => `${l.side} ${l.eventTitle}: ${l.label}, ${fmtUsdc(BigInt(l.margin))} USDC at ${fmtLeverage(l.leverage)}`).join("; ")}`
          : `Proposed no legs. ${data.proposal.notes[0] ?? ""}`;
        setMessages((m) => [...m, { id: turnId, role: "assistant", content: content.slice(0, 1800), legs, ...trail }]);
        setSaid(legs.length ? `Agent: proposed ${legs.length} position${legs.length === 1 ? "" : "s"}, shown below.` : "Agent: no matching market found.");
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
    setSaid("");
  };

  const started = messages.length > 0;
  const lastProposal = messages.findLastIndex((m) => m.legs !== undefined);
  const placeholder = proposal
    ? "e.g. make it cheaper, or drop the oil leg"
    : "Describe what you want to protect against: what you hold or pay, how much, and your budget for the hedge.";

  // One flat list so the in-flight trace and the finished turn's trace share a key: the same
  // AgentTrace instance goes from live to collapsed.
  const traceRow = (key: number, node: ReactNode) => (
    <li key={`trace-${key}`} className="w-full max-w-[72ch] self-start px-4 py-1">
      {node}
    </li>
  );
  const thread: ReactNode[] = [];
  messages.forEach((m, i) => {
    if (m.trace?.length) thread.push(traceRow(m.id, <AgentTrace items={m.trace} seconds={m.seconds} />));
    // The current proposal renders in full below the thread; only its trace stays here.
    if (m.legs && i === lastProposal && proposal) return;
    thread.push(
      <li
        key={m.id}
        className={`${m.legs ? "w-full" : "whitespace-pre-wrap"} max-w-[72ch] rounded-md px-4 py-3 text-[15px] ${
          m.role === "user" ? "self-end bg-raised" : "self-start border border-border text-text-2"
        }`}
      >
        <span className="sr-only">{m.role === "user" ? "You: " : "Agent: "}</span>
        {m.legs ? <ProposalTurn legs={m.legs} /> : m.role === "assistant" && i === messages.length - 1 ? <Typewriter text={m.content} /> : m.content}
      </li>,
    );
  });
  if (loading && activity) thread.push(traceRow(activity.turnId, <AgentTrace items={activity.items} live={activity} />));

  return (
    <div className="mt-8 flex flex-col gap-6">
      {started ? (
        // Not a live region: thoughts would flood it. Answers are announced by the line below
        // and step labels by the trace's status line.
        <ol className="flex flex-col gap-3" aria-label="Conversation">
          {thread}
        </ol>
      ) : null}
      <p className="sr-only" aria-live="polite">
        {said}
      </p>

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
