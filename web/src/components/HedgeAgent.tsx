"use client";

import { useId, useRef, useState } from "react";
import type { HedgeMessage, HedgeProposal as Proposal, HedgeResponse } from "@/lib/types";
import { HedgeProposal } from "./HedgeProposal";

const EXAMPLES = [
  "I run a laundromat in Denver. Natural gas for the dryers and water heaters costs about $900 a month and I can put $200 toward a hedge.",
  "I hold 20 ETH and I'm worried about a drop before the end of the month. Budget $500.",
  "Our fund is short copper miners. Protect us against a copper spike this month with a $5,000 budget.",
  "My business has a $400k floating-rate loan. Hedge against the Fed not cutting in December, $300 budget.",
];

const MAX_HISTORY = 16;

export function HedgeAgent() {
  const uid = useId();
  const [messages, setMessages] = useState<HedgeMessage[]>([]);
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
        body: JSON.stringify({ messages: next, proposal }),
        signal: ctrl.signal,
      });
      const data = (await res.json().catch(() => null)) as HedgeResponse | null;
      if (!data) throw new Error(`The hedge agent did not answer (${res.status}).`);
      if (data.type === "error") throw new Error(data.error);
      if (data.type === "question") {
        setMessages((m) => [...m, { role: "assistant", content: data.question }]);
      } else {
        setProposal(data.proposal);
        const n = data.proposal.legs.length;
        setMessages((m) => [
          ...m,
          { role: "assistant", content: `Proposed ${n} leg${n === 1 ? "" : "s"}. ${data.proposal.summary}`.slice(0, 1800) },
        ]);
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
  const placeholder = proposal
    ? "Ask for a change, e.g. 'make it cheaper' or 'drop the oil leg'"
    : "Describe what you want to protect against: what you hold or pay, how much, and your budget for the hedge.";

  return (
    <div className="mt-8 flex flex-col gap-6">
      {started ? (
        <ol className="flex flex-col gap-3" aria-label="Conversation" aria-live="polite">
          {messages.map((m, i) => (
            <li
              key={i}
              className={`max-w-[72ch] whitespace-pre-wrap rounded-md px-4 py-3 text-[15px] ${
                m.role === "user" ? "self-end bg-raised" : "self-start border border-border text-text-2"
              }`}
            >
              <span className="sr-only">{m.role === "user" ? "You: " : "Agent: "}</span>
              {m.content}
            </li>
          ))}
          {loading ? (
            <li className="self-start px-4 py-3 text-[15px] text-muted" role="status">
              Searching markets and sizing the hedge…
            </li>
          ) : null}
        </ol>
      ) : null}

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
          className="field min-h-[96px] py-3"
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
                <button key={ex} type="button" className="btn btn-secondary h-auto px-3 py-2 text-left text-[13px]" onClick={() => setInput(ex)}>
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

      {proposal ? <HedgeProposal key={proposal.quotedAt} proposal={proposal} onChange={setProposal} locked={loading} /> : null}

      <p className="max-w-[72ch] text-[12px] text-muted">
        The hedge agent suggests positions from listed Gemini markets. It is not investment advice. Prediction-market hedges pay in
        discrete outcomes over short horizons and rarely offset a real exposure exactly. Review every leg before you confirm.
      </p>
    </div>
  );
}
