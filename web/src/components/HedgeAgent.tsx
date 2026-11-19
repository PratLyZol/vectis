"use client";

import { useId, useRef, useState } from "react";
import { fmtLeverage, fmtPrice, fmtUsdc } from "@/lib/format";
import type { HedgeLeg, HedgeMessage, HedgeProposal as Proposal, HedgeResponse } from "@/lib/types";
import { HedgeProposal } from "./HedgeProposal";

const EXAMPLES = [
  "I run a laundromat in Denver. Natural gas for the dryers and water heaters costs about $900 a month and I can put $200 toward a hedge.",
  "I hold 20 ETH and I'm worried about a drop before the end of the month. Budget $500.",
  "Our fund is short copper miners. Protect us against a copper spike this month with a $5,000 budget.",
  "My business has a $400k floating-rate loan. Hedge against the Fed not cutting in December, $300 budget.",
];

const MAX_HISTORY = 16;

// A conversation turn. Proposal turns keep a snapshot of the legs so the thread shows them as
// positions; `content` is the short text the model sees as its own earlier reply.
type Turn = HedgeMessage & { legs?: HedgeLeg[] };

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
  const abort = useRef<AbortController | null>(null);

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
    try {
      const res = await fetch("/api/hedge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next.map(({ role, content }) => ({ role, content })), proposal }),
        signal: ctrl.signal,
      });
      const data = (await res.json().catch(() => null)) as HedgeResponse | null;
      if (!data) throw new Error(`The hedge agent did not answer (${res.status}).`);
      if (data.type === "error") throw new Error(data.error);
      if (data.type === "question") {
        setMessages((m) => [...m, { role: "assistant", content: data.question }]);
      } else {
        setProposal(data.proposal);
        const { legs } = data.proposal;
        // What the model sees as its earlier reply; the thread shows the legs, not this text.
        const content = legs.length
          ? `Proposed: ${legs.map((l) => `${l.side} ${l.eventTitle}: ${l.label}, ${fmtUsdc(BigInt(l.margin))} USDC at ${fmtLeverage(l.leverage)}`).join("; ")}`
          : `Proposed no legs. ${data.proposal.notes[0] ?? ""}`;
        setMessages((m) => [...m, { role: "assistant", content: content.slice(0, 1800), legs }]);
      }
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setError(e instanceof Error ? e.message : "The hedge agent failed.");
      // Drop the unanswered message so a retry does not send it twice.
      setMessages((m) => (m.at(-1)?.role === "user" ? m.slice(0, -1) : m));
      setInput(content);
    } finally {
      if (abort.current === ctrl) setLoading(false);
    }
  };

  const startOver = () => {
    abort.current?.abort();
    setMessages([]);
    setProposal(null);
    setInput("");
    setError(null);
    setLoading(false);
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
            // The current proposal renders in full below the thread.
            m.legs && i === lastProposal && proposal ? null : (
            <li
              key={i}
              className={`${m.legs ? "w-full" : "whitespace-pre-wrap"} max-w-[72ch] rounded-md px-4 py-3 text-[15px] ${
                m.role === "user" ? "self-end bg-raised" : "self-start border border-border text-text-2"
              }`}
            >
              <span className="sr-only">{m.role === "user" ? "You: " : "Agent: "}</span>
              {m.legs ? <ProposalTurn legs={m.legs} /> : m.content}
            </li>
            ),
          )}
          {loading ? (
            <li className="self-start px-4 py-3 text-[15px] text-muted" role="status">
              Finding markets…
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
