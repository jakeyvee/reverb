"use client";

import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { CHAT_USER_MESSAGE_MAX_CHARS, type ChatCorrection } from "@reverb/domain";
import { Card } from "@/components/ui/card";
import { sendChatMessageAction, startChatOverAction } from "@/lib/chat/actions";
import type { ChatHistoryMessage } from "@/lib/chat/sessions";

type Props = {
  sessionId: string;
  level: string;
  initialMessages: ChatHistoryMessage[];
};

// Renders the chat transcript and the input box. Corrections are pinned
// directly under the user message they critique so the visual contract is
// "what you said + how the AI would say it" — never mixed into the
// assistant's conversational reply.
export function ChatRunner({ sessionId, level, initialMessages }: Props) {
  const [messages, setMessages] = useState<ChatHistoryMessage[]>(initialMessages);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [resetPending, startResetTransition] = useTransition();
  const [activeSessionId, setActiveSessionId] = useState(sessionId);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to the bottom on every transcript change so the user
  // always sees the latest reply without manual scrolling.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    setError(null);
    setValue("");
    startTransition(async () => {
      const result = await sendChatMessageAction({
        sessionId: activeSessionId,
        message: trimmed,
      });
      if (!result.ok) {
        setError(result.error);
        setValue(trimmed); // restore the typed text so the user can retry
        return;
      }
      setActiveSessionId(result.sessionId);
      setMessages((prev) => [...prev, result.userMessage, result.assistantMessage]);
    });
  }

  function reset() {
    if (resetPending) return;
    startResetTransition(async () => {
      const result = await startChatOverAction();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMessages([]);
      setError(null);
      setActiveSessionId(result.sessionId);
    });
  }

  const charsLeft = CHAT_USER_MESSAGE_MAX_CHARS - value.length;
  const overLimit = charsLeft < 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-foreground-subtle">
        <span className="rounded-full border border-border px-3 py-1">
          Level: <span className="font-medium text-foreground">{level}</span>
        </span>
        <button
          type="button"
          onClick={reset}
          disabled={resetPending}
          className="rounded-full border border-border px-3 py-1 transition hover:text-foreground disabled:opacity-40"
        >
          {resetPending ? "Resetting…" : "Start over"}
        </button>
      </div>

      <div
        ref={scrollerRef}
        className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto rounded-xl border border-border bg-surface/40 p-3 md:p-4"
      >
        {messages.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-foreground-muted">
            Say hi in Bahasa Indonesia. Try: <em>Halo, apa kabar?</em>
          </p>
        ) : (
          messages.map((m) => <MessageBlock key={m.id} message={m} />)
        )}
        {pending ? (
          <p className="px-2 text-xs italic text-foreground-subtle">Partner is typing…</p>
        ) : null}
      </div>

      <form onSubmit={submit} className="flex flex-col gap-2">
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Write in Bahasa Indonesia…"
          rows={2}
          maxLength={CHAT_USER_MESSAGE_MAX_CHARS}
          className="rounded-md border border-border bg-surface-muted px-3 py-2 text-sm text-foreground outline-none focus:border-foreground"
          disabled={pending}
        />
        <div className="flex items-center justify-between gap-3 text-xs text-foreground-subtle">
          <span className={overLimit ? "text-danger" : ""}>{charsLeft} characters left</span>
          <button
            type="submit"
            disabled={pending || value.trim().length === 0 || overLimit}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition disabled:opacity-40"
          >
            {pending ? "Sending…" : "Send"}
          </button>
        </div>
        {error ? <p className="text-xs text-danger">{error}</p> : null}
      </form>
    </div>
  );
}

function MessageBlock({ message }: { message: ChatHistoryMessage }) {
  if (message.role === "assistant") {
    return (
      <Card className="bg-surface">
        <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-foreground-subtle">
          <span>Partner</span>
          {message.language && message.language !== "id" ? (
            <span className="rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[10px] font-medium uppercase text-amber-700 dark:text-amber-300">
              {message.language}
            </span>
          ) : null}
        </div>
        <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">{message.content}</p>
      </Card>
    );
  }
  return (
    <div className="space-y-2">
      <Card className="border-border bg-surface-muted/40">
        <div className="text-[10px] uppercase tracking-wider text-foreground-subtle">You</div>
        <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">{message.content}</p>
      </Card>
      {message.corrections.length > 0 ? (
        <CorrectionsList corrections={message.corrections} />
      ) : null}
    </div>
  );
}

function CorrectionsList({ corrections }: { corrections: ChatCorrection[] }) {
  return (
    <div className="rounded-lg border border-amber-400/40 bg-amber-400/5 p-3 md:p-4">
      <p className="text-[10px] font-medium uppercase tracking-wider text-amber-700 dark:text-amber-300">
        {corrections.length === 1 ? "Correction" : "Corrections"}
      </p>
      <ul className="mt-2 space-y-2 text-sm">
        {corrections.map((c, i) => (
          <li key={i} className="flex flex-col gap-1">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-foreground-muted line-through decoration-danger/60 decoration-2">
                {c.sourceText}
              </span>
              <span aria-hidden className="text-foreground-subtle">
                →
              </span>
              <span className="font-medium text-emerald-700 dark:text-emerald-300">
                {c.correctedText}
              </span>
              <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] uppercase tracking-wider text-foreground-subtle">
                {c.kind}
              </span>
            </div>
            {c.explanation ? (
              <p className="text-xs text-foreground-muted">{c.explanation}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
