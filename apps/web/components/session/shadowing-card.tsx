"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Card } from "@/components/ui/card";
import { PlayIcon } from "@/components/ui/icons";
import {
  recordShadowingAttempt,
  type RecordShadowingAttemptResult,
  type ShadowingSelfMarkResult,
} from "@/lib/session/actions";
import type { ShadowingClipView } from "@/lib/session/shadowing";

// Single-clip shadowing exercise. Plays a 1-8s dialogue clip, records the
// user via the browser MediaRecorder API, and lets them self-mark "got it"
// or "try again". The recording itself never leaves the browser; only the
// pass/fail outcome is sent to the server, mirroring the issue's "no
// pronunciation scoring in v1" decision.
//
// Mobile/permission posture:
//   * MediaRecorder availability is detected at mount; unsupported environments
//     (older iOS, some embedded browsers) show a "use without recording"
//     fallback so the user can still self-mark and the session can complete.
//   * getUserMedia errors are categorised so iOS Safari's
//     `NotAllowedError` produces a re-try affordance rather than a dead end.
//   * The "Listen first" gesture also unblocks audio output on iOS — that
//     same tap counts as the required user-activation, so the recorder can
//     start immediately afterwards.

type Props = {
  clip: ShadowingClipView;
  sessionItemId: string;
  positionLabel: string;
  onAnswered: (result: RecordShadowingAttemptResult) => void;
  onAdvance: () => void;
};

type RecordingState =
  | { kind: "idle" }
  | { kind: "requesting" }
  | { kind: "recording"; startedAt: number }
  | { kind: "recorded"; blob: Blob; mimeType: string; durationMs: number; url: string }
  | { kind: "error"; reason: PermissionError };

type PermissionError = "denied" | "no-mic" | "insecure-context" | "unsupported" | "unknown";

type Phase = { kind: "prompt" } | { kind: "answered"; result: RecordShadowingAttemptResult };

const MAX_RECORDING_MS = 15_000; // hard cap on a single take

export function SessionShadowingCard({
  clip,
  sessionItemId,
  positionLabel,
  onAnswered,
  onAdvance,
}: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: "prompt" });
  const [shown, setShown] = useState(false);
  const [recording, setRecording] = useState<RecordingState>({ kind: "idle" });
  const [recorderSupported, setRecorderSupported] = useState<boolean | null>(null);
  const [level, setLevel] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [pending, startTransition] = useTransition();
  const playerRef = useRef<HTMLAudioElement | null>(null);
  const playbackRef = useRef<HTMLAudioElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recorderStreamRef = useRef<MediaStream | null>(null);
  const analyserCleanupRef = useRef<(() => void) | null>(null);
  const startedAtRef = useRef<number>(Date.now());

  // Browser feature detection. We resolve once after mount because Next's SSR
  // pass doesn't have access to `window.MediaRecorder` and we don't want to
  // hydrate a "not supported" warning incorrectly when the client does have it.
  useEffect(() => {
    if (typeof window === "undefined") {
      setRecorderSupported(false);
      return;
    }
    const hasRecorder = typeof window.MediaRecorder !== "undefined";
    const hasGetUserMedia = !!(
      navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function"
    );
    setRecorderSupported(hasRecorder && hasGetUserMedia);
  }, []);

  // Reset whenever the active clip changes (parent rerenders with a new clip).
  useEffect(() => {
    startedAtRef.current = Date.now();
    setPhase({ kind: "prompt" });
    setShown(false);
    setRecording((current) => {
      if (current.kind === "recorded") {
        URL.revokeObjectURL(current.url);
      }
      return { kind: "idle" };
    });
    setElapsedMs(0);
    setLevel(0);
  }, [clip.clipId]);

  // Cleanup on unmount: stop the recorder, close the stream, revoke any blob URL.
  useEffect(() => {
    return () => {
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          /* noop */
        }
      }
      stopStream(recorderStreamRef.current);
      analyserCleanupRef.current?.();
      setRecording((current) => {
        if (current.kind === "recorded") {
          URL.revokeObjectURL(current.url);
        }
        return current;
      });
    };
  }, []);

  const playClip = useCallback(() => {
    const el = playerRef.current;
    if (!el) return;
    try {
      el.currentTime = 0;
      void el.play().catch(() => undefined);
    } catch {
      /* noop */
    }
  }, []);

  const playBackTake = useCallback(() => {
    const el = playbackRef.current;
    if (!el) return;
    try {
      el.currentTime = 0;
      void el.play().catch(() => undefined);
    } catch {
      /* noop */
    }
  }, []);

  const beginRecording = useCallback(async () => {
    if (recording.kind === "recording" || recording.kind === "requesting") return;
    if (typeof window === "undefined") return;
    if (typeof window.MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setRecording({ kind: "error", reason: "unsupported" });
      return;
    }
    if (typeof window.isSecureContext === "boolean" && !window.isSecureContext) {
      // getUserMedia only works on https/localhost. Skip the prompt that would
      // 100% reject so the user sees a friendlier message.
      setRecording({ kind: "error", reason: "insecure-context" });
      return;
    }
    setRecording({ kind: "requesting" });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recorderStreamRef.current = stream;
      const mimeType = pickRecorderMimeType();
      let recorder: MediaRecorder;
      try {
        recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      } catch {
        recorder = new MediaRecorder(stream);
      }
      recorderRef.current = recorder;
      const chunks: BlobPart[] = [];
      const startedAt = Date.now();
      const actualMimeType = recorder.mimeType || mimeType || "audio/webm";

      recorder.addEventListener("dataavailable", (event) => {
        if (event.data && event.data.size > 0) chunks.push(event.data);
      });
      recorder.addEventListener("stop", () => {
        const blob = new Blob(chunks, { type: actualMimeType });
        const durationMs = Date.now() - startedAt;
        // Revoke any prior take's object URL — only one take is ever in scope.
        setRecording((current) => {
          if (current.kind === "recorded") {
            URL.revokeObjectURL(current.url);
          }
          const url = URL.createObjectURL(blob);
          return { kind: "recorded", blob, mimeType: actualMimeType, durationMs, url };
        });
        analyserCleanupRef.current?.();
        analyserCleanupRef.current = null;
        stopStream(recorderStreamRef.current);
        recorderStreamRef.current = null;
        recorderRef.current = null;
        setLevel(0);
      });

      // Wire up an analyser for the level meter. Best-effort: a failure here
      // doesn't prevent recording, the meter just stays flat.
      try {
        analyserCleanupRef.current = attachLevelMeter(stream, (next) => setLevel(next));
      } catch {
        analyserCleanupRef.current = null;
      }

      recorder.start();
      setRecording({ kind: "recording", startedAt });
      setElapsedMs(0);
    } catch (error) {
      stopStream(recorderStreamRef.current);
      recorderStreamRef.current = null;
      setRecording({ kind: "error", reason: classifyGetUserMediaError(error) });
    }
  }, [recording.kind]);

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    try {
      recorder.stop();
    } catch {
      /* noop */
    }
  }, []);

  const discardTake = useCallback(() => {
    setRecording((current) => {
      if (current.kind === "recorded") {
        URL.revokeObjectURL(current.url);
      }
      return { kind: "idle" };
    });
    setLevel(0);
    setElapsedMs(0);
  }, []);

  // Tick the elapsed counter every 100ms while recording, and auto-stop once
  // we hit the cap so the user can't accidentally hold the mic open all day.
  useEffect(() => {
    if (recording.kind !== "recording") return;
    const startedAt = recording.startedAt;
    const interval = window.setInterval(() => {
      const elapsed = Date.now() - startedAt;
      setElapsedMs(elapsed);
      if (elapsed >= MAX_RECORDING_MS) stopRecording();
    }, 100);
    return () => window.clearInterval(interval);
  }, [recording, stopRecording]);

  const submitSelfMark = useCallback(
    (result: ShadowingSelfMarkResult, fallback: boolean) => {
      if (pending) return;
      const recordingMs =
        recording.kind === "recorded"
          ? Math.min(MAX_RECORDING_MS, Math.round(recording.durationMs))
          : undefined;
      const responseMs = Math.max(0, Date.now() - startedAtRef.current);
      startTransition(async () => {
        const response = await recordShadowingAttempt({
          sessionItemId,
          dialogueClipId: clip.clipId,
          result,
          recordingMs,
          responseMs,
          fallback,
        });
        setPhase({ kind: "answered", result: response });
        onAnswered(response);
      });
    },
    [clip.clipId, onAnswered, pending, recording, sessionItemId],
  );

  const durationLabel = formatDurationSeconds(clip.durationMs);
  const fallbackOnly = recorderSupported === false || recording.kind === "error";

  return (
    <Card className="flex flex-col gap-5 py-6">
      <div className="flex items-center justify-between text-xs text-foreground-subtle">
        <span className="uppercase tracking-wider">Shadowing · {positionLabel}</span>
        <span className="text-[10px] uppercase tracking-wider">{durationLabel}</span>
      </div>

      <div className="space-y-3">
        <div className="flex items-start gap-3">
          <button
            type="button"
            onClick={playClip}
            disabled={!clip.audioUrl}
            aria-label={clip.audioUrl ? "Play clip" : "Audio unavailable"}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-border bg-surface-muted text-foreground transition hover:bg-surface-muted/70 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <PlayIcon width={20} height={20} />
          </button>
          <div className="min-w-0 flex-1">
            <p className="text-xs uppercase tracking-wider text-foreground-subtle">
              Listen, then say it back
            </p>
            {shown && clip.caption ? (
              <p className="mt-1 break-words text-base font-medium text-foreground md:text-lg">
                {clip.caption}
              </p>
            ) : (
              <p className="mt-1 text-sm text-foreground-muted">
                {clip.caption
                  ? "Tap show transcript if you need to read along."
                  : "No transcript captured — listen for the rhythm."}
              </p>
            )}
            {shown && clip.translation ? (
              <p className="mt-1 break-words text-xs text-foreground-subtle">{clip.translation}</p>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          {clip.caption ? (
            <button
              type="button"
              onClick={() => setShown((value) => !value)}
              className="rounded-full border border-border bg-surface px-3 py-1 text-foreground-muted transition hover:text-foreground"
            >
              {shown ? "Hide transcript" : "Show transcript"}
            </button>
          ) : null}
          {clip.lessonTitle && clip.lessonId ? (
            <a
              href={`/lessons/${clip.lessonId}`}
              className="rounded-full border border-border bg-surface px-3 py-1 text-foreground-subtle underline-offset-2 transition hover:text-foreground hover:underline"
            >
              From {clip.lessonTitle}
            </a>
          ) : null}
        </div>

        {clip.audioUrl ? (
          <audio ref={playerRef} src={clip.audioUrl} preload="auto" className="hidden" />
        ) : (
          <p className="text-[11px] text-foreground-subtle">
            Audio is still being generated for this clip.
          </p>
        )}
      </div>

      <RecorderPanel
        state={recording}
        fallbackOnly={fallbackOnly}
        level={level}
        elapsedMs={elapsedMs}
        onStart={beginRecording}
        onStop={stopRecording}
        onDiscard={discardTake}
        onPlayback={playBackTake}
        playbackRef={playbackRef}
      />

      {phase.kind === "prompt" ? (
        <SelfMarkControls
          disabled={pending || recording.kind === "recording" || recording.kind === "requesting"}
          fallback={fallbackOnly}
          onMark={(result) => submitSelfMark(result, fallbackOnly)}
        />
      ) : (
        <AnsweredPanel result={phase.result} onContinue={onAdvance} />
      )}
    </Card>
  );
}

function RecorderPanel({
  state,
  fallbackOnly,
  level,
  elapsedMs,
  onStart,
  onStop,
  onDiscard,
  onPlayback,
  playbackRef,
}: {
  state: RecordingState;
  fallbackOnly: boolean;
  level: number;
  elapsedMs: number;
  onStart: () => void;
  onStop: () => void;
  onDiscard: () => void;
  onPlayback: () => void;
  playbackRef: React.MutableRefObject<HTMLAudioElement | null>;
}) {
  if (state.kind === "error") {
    return (
      <div className="rounded-md border border-amber-400/40 bg-amber-400/10 p-3 text-xs text-amber-700 dark:text-amber-300">
        <p className="font-medium">{recorderErrorTitle(state.reason)}</p>
        <p className="mt-1 text-[11px] text-amber-700/80 dark:text-amber-300/80">
          {recorderErrorBody(state.reason)}
        </p>
        {state.reason !== "unsupported" && state.reason !== "insecure-context" ? (
          <button
            type="button"
            onClick={onStart}
            className="mt-2 rounded-md border border-amber-400/40 bg-amber-400/20 px-2 py-1 text-[11px] font-medium text-amber-800 transition hover:bg-amber-400/30 dark:text-amber-200"
          >
            Try again
          </button>
        ) : null}
      </div>
    );
  }

  if (fallbackOnly) {
    return (
      <div className="rounded-md border border-border bg-surface-muted/40 p-3 text-xs text-foreground-muted">
        Recording isn&apos;t available in this browser. Listen, repeat aloud, then self-mark below.
      </div>
    );
  }

  if (state.kind === "recorded") {
    return (
      <div className="space-y-2 rounded-md border border-border bg-surface-muted/40 p-3">
        <p className="text-xs font-medium text-foreground">
          Take captured · {formatDurationSeconds(state.durationMs)}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onPlayback}
            className="rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-surface-muted"
          >
            Play take
          </button>
          <button
            type="button"
            onClick={onDiscard}
            className="rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground-muted transition hover:text-foreground"
          >
            Discard &amp; retry
          </button>
        </div>
        <audio ref={playbackRef} src={state.url} className="hidden" preload="auto" />
      </div>
    );
  }

  if (state.kind === "recording") {
    return (
      <div className="space-y-2 rounded-md border border-danger/40 bg-danger/10 p-3">
        <div className="flex items-center justify-between text-xs text-danger">
          <span className="flex items-center gap-2 font-medium">
            <span
              className="inline-flex h-2 w-2 animate-pulse rounded-full bg-danger"
              aria-hidden
            />
            Recording…
          </span>
          <span>{formatDurationSeconds(elapsedMs)}</span>
        </div>
        <LevelMeter level={level} />
        <button
          type="button"
          onClick={onStop}
          className="w-full rounded-md bg-danger px-3 py-2 text-sm font-medium text-white transition hover:opacity-90"
        >
          Stop recording
        </button>
      </div>
    );
  }

  if (state.kind === "requesting") {
    return (
      <div className="rounded-md border border-border bg-surface-muted/40 p-3 text-xs text-foreground-muted">
        Requesting microphone…
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onStart}
      className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-surface-muted px-3 py-2 text-sm font-medium text-foreground transition hover:bg-surface-muted/70"
    >
      <span className="inline-flex h-2 w-2 rounded-full bg-danger" aria-hidden />
      Record yourself
    </button>
  );
}

function LevelMeter({ level }: { level: number }) {
  // Render a fixed grid of bars whose height scales with the running level.
  // 24 bars at ~14px width comfortably fits 375px viewports with the card's
  // built-in padding (320-ish px effective width).
  const BARS = 24;
  const bars = Array.from({ length: BARS }, (_, idx) => {
    // Bars near the centre are tallest; outer bars taper off. Multiplying by
    // the live `level` (0..1) gives a simple bouncing-equaliser effect.
    const distance = Math.abs(idx - (BARS - 1) / 2) / ((BARS - 1) / 2);
    const baseline = 0.15 + (1 - distance) * 0.85;
    const height = Math.max(0.08, baseline * level);
    return Math.round(height * 100);
  });
  return (
    <div
      aria-hidden
      className="flex h-10 w-full items-end justify-between gap-[2px] rounded-md bg-danger/5 px-1.5"
    >
      {bars.map((value, idx) => (
        <span
          key={idx}
          className="block flex-1 rounded-sm bg-danger/60 transition-[height] duration-75"
          style={{ height: `${value}%` }}
        />
      ))}
    </div>
  );
}

function SelfMarkControls({
  disabled,
  fallback,
  onMark,
}: {
  disabled: boolean;
  fallback: boolean;
  onMark: (result: ShadowingSelfMarkResult) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-foreground-muted">
        {fallback
          ? "Self-mark below — recording wasn't available."
          : "Compare your take with the clip, then self-mark."}
      </p>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => onMark("try_again")}
          disabled={disabled}
          className="rounded-md border border-danger/40 px-3 py-2 text-sm font-medium text-danger transition hover:bg-danger/10 disabled:opacity-40"
        >
          Try again
        </button>
        <button
          type="button"
          onClick={() => onMark("got_it")}
          disabled={disabled}
          className="rounded-md border border-emerald-500/40 px-3 py-2 text-sm font-medium text-emerald-700 transition hover:bg-emerald-500/10 disabled:opacity-40 dark:text-emerald-300"
        >
          Got it
        </button>
      </div>
    </div>
  );
}

function AnsweredPanel({
  result,
  onContinue,
}: {
  result: RecordShadowingAttemptResult;
  onContinue: () => void;
}) {
  if (!result.ok) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-danger">{result.error}</p>
        <button
          type="button"
          onClick={onContinue}
          className="rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground"
        >
          Skip
        </button>
      </div>
    );
  }
  const pass = result.result === "got_it";
  return (
    <div className="space-y-3">
      <p
        className={`text-sm font-medium ${
          pass ? "text-emerald-700 dark:text-emerald-300" : "text-danger"
        }`}
      >
        {pass ? `Nice. +${result.xpAwarded} XP.` : "Marked for another pass — keep at it."}
      </p>
      <button
        type="button"
        onClick={onContinue}
        className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition"
      >
        Continue
      </button>
    </div>
  );
}

// MediaRecorder mime-type negotiation. Different browsers ship different
// codecs — Safari prefers `audio/mp4`, Chrome/Firefox ship `audio/webm`. We
// try the most-supported encodings in order and fall back to whatever the
// browser hands us.
function pickRecorderMimeType(): string | undefined {
  if (typeof window === "undefined" || typeof window.MediaRecorder === "undefined")
    return undefined;
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
    "audio/ogg;codecs=opus",
    "audio/ogg",
  ];
  const isTypeSupported = (window.MediaRecorder as typeof MediaRecorder).isTypeSupported;
  if (typeof isTypeSupported !== "function") return undefined;
  for (const candidate of candidates) {
    try {
      if (isTypeSupported.call(window.MediaRecorder, candidate)) return candidate;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

function classifyGetUserMediaError(error: unknown): PermissionError {
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") return "denied";
    if (error.name === "NotFoundError" || error.name === "OverconstrainedError") return "no-mic";
    if (error.name === "NotSupportedError") return "unsupported";
  }
  if (error && typeof error === "object" && "name" in error) {
    const name = (error as { name: unknown }).name;
    if (name === "NotAllowedError" || name === "SecurityError") return "denied";
    if (name === "NotFoundError" || name === "OverconstrainedError") return "no-mic";
    if (name === "NotSupportedError") return "unsupported";
  }
  return "unknown";
}

function recorderErrorTitle(reason: PermissionError): string {
  switch (reason) {
    case "denied":
      return "Microphone permission denied";
    case "no-mic":
      return "No microphone detected";
    case "insecure-context":
      return "Microphone needs HTTPS";
    case "unsupported":
      return "Recording isn't supported here";
    default:
      return "Couldn't start recording";
  }
}

function recorderErrorBody(reason: PermissionError): string {
  switch (reason) {
    case "denied":
      return "Open browser settings to allow microphone access, or self-mark below without recording.";
    case "no-mic":
      return "Plug in or enable a microphone, then try again. You can still self-mark.";
    case "insecure-context":
      return "This page needs to be served over HTTPS for the browser to share your mic.";
    case "unsupported":
      return "Your browser doesn't expose MediaRecorder. Practise out loud and self-mark below.";
    default:
      return "Try again, or self-mark below without a recording.";
  }
}

function stopStream(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      /* noop */
    }
  }
}

// Drives the live level meter from the recording stream. We sample the
// time-domain data, compute an RMS, and surface a smoothed level into the
// React state for the bar visualiser. Returns a cleanup that closes the
// AudioContext and cancels the rAF loop.
function attachLevelMeter(stream: MediaStream, onLevel: (next: number) => void): () => void {
  const AudioCtor: typeof AudioContext | undefined =
    typeof window === "undefined"
      ? undefined
      : (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  if (!AudioCtor) {
    return () => undefined;
  }
  const context = new AudioCtor();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);

  const data = new Uint8Array(analyser.fftSize);
  let raf = 0;
  let smoothed = 0;
  let active = true;
  const tick = () => {
    if (!active) return;
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) {
      const value = (data[i]! - 128) / 128;
      sum += value * value;
    }
    const rms = Math.sqrt(sum / data.length);
    // Soft exponential smoothing keeps the bars from twitching when the user
    // pauses between words.
    smoothed = smoothed * 0.7 + Math.min(1, rms * 2.5) * 0.3;
    onLevel(smoothed);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return () => {
    active = false;
    if (raf) cancelAnimationFrame(raf);
    try {
      source.disconnect();
    } catch {
      /* noop */
    }
    void context.close().catch(() => undefined);
  };
}

function formatDurationSeconds(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0.0s";
  const seconds = ms / 1000;
  return `${seconds.toFixed(1)}s`;
}
