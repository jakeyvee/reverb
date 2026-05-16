"use client";

import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import {
  SCENARIO_COMPLETION_XP,
  SCENARIO_MAX_USER_TURNS,
  SCENARIO_USER_MESSAGE_MAX_CHARS,
  type ScenarioCorrection,
  type ScenarioDefinition,
} from "@reverb/domain";
import { Card } from "@/components/ui/card";
import {
  abandonScenarioAction,
  completeScenarioAction,
  sendScenarioMessageAction,
} from "@/lib/scenarios/actions";
import type { ScenarioHistoryMessage } from "@/lib/scenarios/sessions";

type Props = {
  sessionId: string;
  scenario: ScenarioDefinition;
  initialMessages: ScenarioHistoryMessage[];
  initialStatus: "active" | "completed" | "abandoned";
  initialXp: number;
  initialUserTurns: number;
};

// Drives one scenario role-play to completion. The transcript starts with
// the persona's opening line as a synthetic assistant bubble — that turn is
// not persisted (the AI adapter re-seeds it on the first user message), so
// a refresh reloads the same opening from the static definition.
//
// Layout mirrors the chat runner: persona context up top, scrollable
// transcript in the middle, input + send + finish at the bottom. The
// completion footer changes shape as the scene progresses:
//   active + below cap     → show input, send button, "Exit" link.
//   active + cap reached   → hide input, show "Finish & claim XP".
//   active + sceneComplete → show input, but ALSO surface "Finish & claim XP".
//   completed              → static summary with awarded XP.
//   abandoned              → static summary with "Try again" hint.
export function ScenarioRunner({
  sessionId,
  scenario,
  initialMessages,
  initialStatus,
  initialXp,
  initialUserTurns,
}: Props) {
  const router = useRouter();
  const [messages, setMessages] = useState<ScenarioHistoryMessage[]>(initialMessages);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState(initialStatus);
  const [xpEarned, setXpEarned] = useState(initialXp);
  const [userTurnCount, setUserTurnCount] = useState(initialUserTurns);
  const [sceneComplete, setSceneComplete] = useState(false);
  const [sendPending, startSend] = useTransition();
  const [finishPending, startFinish] = useTransition();
  const [exitPending, startExit] = useTransition();
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (sendPending || status !== "active") return;
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    setError(null);
    setValue("");
    startSend(async () => {
      const result = await sendScenarioMessageAction({ sessionId, message: trimmed });
      if (!result.ok) {
        setError(result.error);
        setValue(trimmed);
        return;
      }
      setMessages((prev) => [...prev, result.userMessage, result.assistantMessage]);
      setUserTurnCount(result.userTurnCount);
      setSceneComplete(result.sceneComplete);
    });
  }

  function finish() {
    if (finishPending) return;
    setError(null);
    startFinish(async () => {
      const result = await completeScenarioAction({ sessionId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setStatus("completed");
      setXpEarned(result.totalXp);
    });
  }

  function exit() {
    if (exitPending) return;
    setError(null);
    startExit(async () => {
      const result = await abandonScenarioAction({ sessionId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push("/scenarios" as Route);
    });
  }

  const charsLeft = SCENARIO_USER_MESSAGE_MAX_CHARS - value.length;
  const overLimit = charsLeft < 0;
  const turnsLeft = Math.max(0, SCENARIO_MAX_USER_TURNS - userTurnCount);
  const capReached = userTurnCount >= SCENARIO_MAX_USER_TURNS;
  const canFinish = status === "active" && userTurnCount > 0 && (sceneComplete || capReached);
  const isLocked = status !== "active";

  return (
    <div className="space-y-4">
      <PersonaCard scenario={scenario} userTurnCount={userTurnCount} turnsLeft={turnsLeft} />

      <div
        ref={scrollerRef}
        className="flex max-h-[55vh] flex-col gap-3 overflow-y-auto rounded-xl border border-border bg-surface/40 p-3 md:p-4"
      >
        <OpeningBubble text={scenario.counterpartOpening} />
        {messages.map((m) => (
          <MessageBlock key={m.id} message={m} />
        ))}
        {sendPending ? (
          <p className="px-2 text-xs italic text-foreground-subtle">Partner is typing…</p>
        ) : null}
      </div>

      {status === "completed" ? (
        <CompletedFooter xpEarned={xpEarned} onTryAgain={() => router.refresh()} />
      ) : status === "abandoned" ? (
        <AbandonedFooter />
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3">
          {capReached ? (
            <p className="rounded-md border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
              You&apos;ve reached this scenario&apos;s turn limit. Finish the scene to claim XP.
            </p>
          ) : sceneComplete ? (
            <p className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-200">
              Looks like you&apos;ve wrapped this up — finish to claim {SCENARIO_COMPLETION_XP} XP,
              or keep practising.
            </p>
          ) : null}

          {!capReached ? (
            <textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Reply in Bahasa Indonesia…"
              rows={2}
              maxLength={SCENARIO_USER_MESSAGE_MAX_CHARS}
              className="rounded-md border border-border bg-surface-muted px-3 py-2 text-sm text-foreground outline-none focus:border-foreground"
              disabled={sendPending || isLocked}
            />
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-foreground-subtle">
            <div className="flex items-center gap-3">
              <span className={overLimit ? "text-danger" : ""}>{charsLeft} characters left</span>
              <span>
                Turn {userTurnCount} / {SCENARIO_MAX_USER_TURNS}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={exit}
                disabled={exitPending || finishPending}
                className="rounded-md border border-border px-3 py-1.5 text-xs transition hover:text-foreground disabled:opacity-40"
              >
                {exitPending ? "Exiting…" : "Exit scene"}
              </button>
              {canFinish ? (
                <button
                  type="button"
                  onClick={finish}
                  disabled={finishPending}
                  className="rounded-md bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white transition disabled:opacity-40"
                >
                  {finishPending ? "Finishing…" : `Finish & claim ${SCENARIO_COMPLETION_XP} XP`}
                </button>
              ) : !capReached ? (
                <button
                  type="submit"
                  disabled={sendPending || value.trim().length === 0 || overLimit || isLocked}
                  className="rounded-md bg-accent px-4 py-1.5 text-xs font-medium text-accent-foreground transition disabled:opacity-40"
                >
                  {sendPending ? "Sending…" : "Send"}
                </button>
              ) : null}
            </div>
          </div>
          {error ? <p className="text-xs text-danger">{error}</p> : null}
        </form>
      )}
    </div>
  );
}

function PersonaCard({
  scenario,
  userTurnCount,
  turnsLeft,
}: {
  scenario: ScenarioDefinition;
  userTurnCount: number;
  turnsLeft: number;
}) {
  return (
    <Card className="space-y-3 bg-surface">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wider text-foreground-subtle">Scene</p>
          <p className="mt-0.5 text-sm font-medium text-foreground">{scenario.setting}</p>
        </div>
        <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wider text-foreground-subtle">
          {userTurnCount > 0 ? `${turnsLeft} turns left` : `${SCENARIO_MAX_USER_TURNS} turn budget`}
        </span>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <RolePill label="You" value={scenario.userRole} />
        <RolePill label="Partner" value={scenario.counterpartRole} />
      </div>
      <div>
        <p className="text-[10px] uppercase tracking-wider text-foreground-subtle">Goals</p>
        <ul className="mt-1 space-y-1 text-xs text-foreground-muted">
          {scenario.goals.map((goal, idx) => (
            <li key={idx} className="flex gap-2">
              <span className="text-foreground-subtle">•</span>
              <span>{goal}</span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

function RolePill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-surface-muted/40 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider text-foreground-subtle">{label}</p>
      <p className="mt-0.5 text-xs text-foreground">{value}</p>
    </div>
  );
}

function OpeningBubble({ text }: { text: string }) {
  return (
    <Card className="bg-surface">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-foreground-subtle">
        <span>Partner · opening</span>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">{text}</p>
    </Card>
  );
}

function MessageBlock({ message }: { message: ScenarioHistoryMessage }) {
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

function CorrectionsList({ corrections }: { corrections: ScenarioCorrection[] }) {
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

function CompletedFooter({ xpEarned, onTryAgain }: { xpEarned: number; onTryAgain: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3">
      <p className="text-sm text-emerald-800 dark:text-emerald-200">
        Scene complete. You earned <span className="font-semibold">{xpEarned} XP</span>.
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onTryAgain}
          className="rounded-md border border-emerald-500/60 px-3 py-1.5 text-xs font-medium text-emerald-800 transition hover:bg-emerald-500/10 dark:text-emerald-200"
        >
          Try again
        </button>
      </div>
    </div>
  );
}

function AbandonedFooter() {
  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-3 text-sm text-foreground-muted">
      You exited this scene. Open it again from the scenarios list to restart.
    </div>
  );
}
