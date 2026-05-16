"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { Card, EmptyState } from "@/components/ui/card";
import type { TranscriptSegmentRow } from "@/lib/lessons/transcript";
import { formatSpeaker, formatTimestamp } from "@/lib/lessons/transcript-format";
import {
  tokenizeTranscriptSegment,
  type TranscriptToken,
} from "@/lib/lessons/transcript-tokens";
import {
  addTranscriptWordToVocab,
  glossTranscriptWord,
  translateTranscriptSegment,
} from "@/app/(app)/lessons/transcript-actions";
import { type LessonProcessingStatus } from "@reverb/domain/schemas/lesson-status";

type Props = {
  segments: TranscriptSegmentRow[];
  status: LessonProcessingStatus | null;
  // The lesson's intended target language (typically Bahasa). Segments whose
  // `language` does not start with this code are treated as code-switched and
  // tagged in the UI so users don't expect vocab extraction on them.
  targetLanguage: string | null;
};

// Per-segment translation cache. Keyed by segment id, populated either from
// the initial server payload or from the on-demand translate action.
type TranslationCache = Record<string, { translation: string; language: string }>;

// Per-segment translation request status (loading / error / idle). Decoupled
// from the cache so a failed request can be retried.
type TranslateStatus = Record<string, "idle" | "loading" | "error">;

// Selected-word state. Lives globally so only one popover is open at a time.
type SelectedWord = {
  segmentId: string;
  word: string;
  // Anchor for positioning the popover. Stored as the bounding rect at click
  // time so a scroll/resize doesn't slide the popover off the page.
  anchorTop: number;
  anchorLeft: number;
  anchorWidth: number;
};

type GlossLookup =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; gloss: string }
  | { kind: "added"; gloss: string; reused: boolean; cardId: string };

export function TranscriptView({ segments, status, targetLanguage }: Props) {
  // Initial translations from the server payload.
  const initialTranslations = useMemo<TranslationCache>(() => {
    const cache: TranslationCache = {};
    for (const segment of segments) {
      if (segment.translation && segment.translationLanguage) {
        cache[segment.id] = {
          translation: segment.translation,
          language: segment.translationLanguage,
        };
      }
    }
    return cache;
  }, [segments]);

  const [translations, setTranslations] = useState<TranslationCache>(initialTranslations);
  const [translateStatus, setTranslateStatus] = useState<TranslateStatus>({});
  const [translateErrors, setTranslateErrors] = useState<Record<string, string>>({});
  // Toggle: when on, show translations for every segment with one available.
  // Per-segment toggles still work; this is the bulk affordance.
  const [showAllTranslations, setShowAllTranslations] = useState(false);
  // Tracks which segments the user explicitly revealed (so we can still hide
  // the translation row when `showAllTranslations` is off).
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [selectedWord, setSelectedWord] = useState<SelectedWord | null>(null);
  const [glossLookup, setGlossLookup] = useState<GlossLookup | null>(null);
  const [bulkLoading, setBulkLoading] = useState(false);
  // Monotonic id for in-flight gloss lookups. A rapid second click bumps this
  // so the slower first response is discarded instead of overwriting the
  // popover for the newly-selected word.
  const glossRequestIdRef = useRef(0);

  // When the segments prop changes (e.g. revalidatePath fires after an
  // add-to-vocab), refresh the translation cache so persisted translations
  // appear without losing the toggle state.
  useEffect(() => {
    setTranslations((prev) => ({ ...initialTranslations, ...prev }));
  }, [initialTranslations]);

  const closePopover = useCallback(() => {
    glossRequestIdRef.current += 1;
    setSelectedWord(null);
    setGlossLookup(null);
  }, []);

  const onWordClick = useCallback(
    (segmentId: string, word: string, anchor: DOMRect) => {
      const requestId = ++glossRequestIdRef.current;
      setSelectedWord({
        segmentId,
        word,
        anchorTop: anchor.top + window.scrollY,
        anchorLeft: anchor.left + window.scrollX,
        anchorWidth: anchor.width,
      });
      setGlossLookup({ kind: "loading" });
      glossTranscriptWord({ segmentId, word })
        .then((result) => {
          if (glossRequestIdRef.current !== requestId) return;
          if (result.ok) {
            setGlossLookup({ kind: "ready", gloss: result.gloss });
          } else {
            setGlossLookup({ kind: "error", message: result.error });
          }
        })
        .catch((err: unknown) => {
          if (glossRequestIdRef.current !== requestId) return;
          setGlossLookup({
            kind: "error",
            message: err instanceof Error ? err.message : "Lookup failed.",
          });
        });
    },
    [],
  );

  const translateSegment = useCallback(async (segmentId: string) => {
    setTranslateStatus((prev) => ({ ...prev, [segmentId]: "loading" }));
    setTranslateErrors((prev) => {
      const next = { ...prev };
      delete next[segmentId];
      return next;
    });
    const result = await translateTranscriptSegment({ segmentId });
    if (!result.ok) {
      setTranslateStatus((prev) => ({ ...prev, [segmentId]: "error" }));
      setTranslateErrors((prev) => ({ ...prev, [segmentId]: result.error }));
      return false;
    }
    setTranslations((prev) => ({
      ...prev,
      [segmentId]: {
        translation: result.translation,
        language: result.translationLanguage,
      },
    }));
    setTranslateStatus((prev) => ({ ...prev, [segmentId]: "idle" }));
    return true;
  }, []);

  const toggleSegmentTranslation = useCallback(
    async (segmentId: string) => {
      const cached = translations[segmentId];
      if (!cached) {
        const ok = await translateSegment(segmentId);
        if (ok) {
          setRevealed((prev) => ({ ...prev, [segmentId]: true }));
        }
        return;
      }
      setRevealed((prev) => ({ ...prev, [segmentId]: !prev[segmentId] }));
    },
    [translations, translateSegment],
  );

  const toggleAll = useCallback(async () => {
    if (showAllTranslations) {
      setShowAllTranslations(false);
      return;
    }
    setShowAllTranslations(true);
    const missing = segments.filter((s) => !translations[s.id]);
    if (missing.length === 0) return;
    setBulkLoading(true);
    // Translate sequentially so we don't fan out a hundred concurrent
    // Anthropic calls on a long lesson. The toggle stays interactive and
    // shows per-segment loading state as we go.
    for (const seg of missing) {
      await translateSegment(seg.id);
    }
    setBulkLoading(false);
  }, [segments, showAllTranslations, translateSegment, translations]);

  if (segments.length === 0) {
    return <TranscriptEmptyState status={status} />;
  }

  const speakers = uniqueSpeakers(segments);
  const showSpeakers = speakers.size > 1 || hasAnySpeakerLabel(segments);

  return (
    <div className="space-y-4">
      {showSpeakers ? <SpeakerLegend segments={segments} /> : null}
      <TranslationControls
        showAll={showAllTranslations}
        onToggleAll={toggleAll}
        loading={bulkLoading}
        translatedCount={Object.keys(translations).length}
        totalCount={segments.length}
      />
      <Card className="space-y-3 sm:space-y-4">
        <ol className="space-y-3 sm:space-y-4">
          {segments.map((segment) => (
            <li key={segment.id}>
              <TranscriptSegmentRowView
                segment={segment}
                showSpeaker={showSpeakers}
                targetLanguage={targetLanguage}
                translation={translations[segment.id] ?? null}
                showTranslation={showAllTranslations || Boolean(revealed[segment.id])}
                translateStatus={translateStatus[segment.id] ?? "idle"}
                translateError={translateErrors[segment.id]}
                selectedWord={selectedWord?.segmentId === segment.id ? selectedWord.word : null}
                onToggleTranslation={() => toggleSegmentTranslation(segment.id)}
                onWordClick={(word, rect) => onWordClick(segment.id, word, rect)}
              />
            </li>
          ))}
        </ol>
      </Card>
      {selectedWord && glossLookup ? (
        <GlossPopover
          selection={selectedWord}
          lookup={glossLookup}
          onClose={closePopover}
          onAdded={(payload) => setGlossLookup(payload)}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TranslationControls({
  showAll,
  onToggleAll,
  loading,
  translatedCount,
  totalCount,
}: {
  showAll: boolean;
  onToggleAll: () => void;
  loading: boolean;
  translatedCount: number;
  totalCount: number;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-foreground-muted">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onToggleAll}
          disabled={loading}
          aria-pressed={showAll}
          className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium transition disabled:opacity-60 ${
            showAll
              ? "border-accent/60 bg-accent/10 text-accent"
              : "border-border text-foreground-muted hover:bg-surface-muted hover:text-foreground"
          }`}
        >
          {loading ? "Translating…" : showAll ? "Hide translations" : "Show translations"}
        </button>
        {translatedCount > 0 ? (
          <span className="text-[11px] text-foreground-subtle">
            {translatedCount} of {totalCount} translated
          </span>
        ) : null}
      </div>
      <p className="text-[11px] text-foreground-subtle">
        Tip: click any word to look it up or add it to your deck.
      </p>
    </div>
  );
}

function TranscriptSegmentRowView({
  segment,
  showSpeaker,
  targetLanguage,
  translation,
  showTranslation,
  translateStatus,
  translateError,
  selectedWord,
  onToggleTranslation,
  onWordClick,
}: {
  segment: TranscriptSegmentRow;
  showSpeaker: boolean;
  targetLanguage: string | null;
  translation: { translation: string; language: string } | null;
  showTranslation: boolean;
  translateStatus: "idle" | "loading" | "error";
  translateError?: string;
  selectedWord: string | null;
  onToggleTranslation: () => void;
  onWordClick: (word: string, rect: DOMRect) => void;
}) {
  const speaker = formatSpeaker(segment.speaker);
  const tokens = useMemo(() => tokenizeTranscriptSegment(segment.text), [segment.text]);
  const codeSwitched = isCodeSwitched(segment, targetLanguage);

  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:gap-3">
      <div className="flex shrink-0 flex-wrap items-center gap-2 sm:w-32 sm:flex-col sm:items-start sm:gap-1">
        <span className="font-mono text-[11px] tabular-nums text-foreground-subtle">
          {formatTimestamp(segment.startMs)}
        </span>
        {showSpeaker ? (
          <span
            className={`inline-flex max-w-[10rem] truncate rounded-full border px-2 py-0.5 text-[10px] font-medium ${speaker.tone}`}
            title={speaker.display}
          >
            {speaker.display}
          </span>
        ) : null}
        {codeSwitched ? (
          <span
            className="inline-flex rounded-full border border-border-strong px-2 py-0.5 text-[10px] font-medium text-foreground-muted"
            title="This segment is in English or code-switched. We don't extract vocab from these."
          >
            {segment.language?.toUpperCase() ?? "EN"} · not extracted
          </span>
        ) : null}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm leading-relaxed text-foreground">
          {tokens.map((token, idx) => (
            <Token
              key={idx}
              token={token}
              isSelected={selectedWord !== null && selectedWord === token.word}
              onClick={(rect) => onWordClick(token.word, rect)}
            />
          ))}
        </p>
        {showTranslation ? (
          <p className="rounded-md bg-surface-muted px-2 py-1.5 text-xs leading-relaxed text-foreground-muted">
            {translation ? (
              translation.translation
            ) : translateStatus === "loading" ? (
              <span className="italic text-foreground-subtle">Translating…</span>
            ) : translateStatus === "error" ? (
              <span className="text-danger">{translateError ?? "Translation failed."}</span>
            ) : (
              <span className="italic text-foreground-subtle">Translation unavailable.</span>
            )}
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onToggleTranslation}
            disabled={translateStatus === "loading"}
            aria-pressed={showTranslation}
            className="inline-flex h-6 items-center gap-1 rounded-md border border-border px-2 text-[11px] font-medium text-foreground-muted transition hover:bg-surface-muted hover:text-foreground disabled:opacity-60"
          >
            {translateStatus === "loading"
              ? "Translating…"
              : showTranslation
                ? translation
                  ? "Hide translation"
                  : "Show translation"
                : translation
                  ? "Show translation"
                  : "Translate"}
          </button>
          {translateError && translateStatus !== "loading" ? (
            <span className="text-[11px] text-danger" role="alert">
              {translateError}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// Renders a single token. Words are <button>s so they're keyboard-reachable
// and announce as interactive to screen readers. Spaces/punctuation are
// inert <span>s so the visual flow matches the source string exactly.
function Token({
  token,
  isSelected,
  onClick,
}: {
  token: TranscriptToken;
  isSelected: boolean;
  onClick: (rect: DOMRect) => void;
}) {
  if (token.kind !== "word") {
    return <span>{token.raw}</span>;
  }
  return (
    <button
      type="button"
      onClick={(e) => onClick(e.currentTarget.getBoundingClientRect())}
      className={`inline cursor-pointer rounded px-0.5 text-[inherit] transition hover:bg-accent/15 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
        isSelected ? "bg-accent/20 text-foreground" : ""
      }`}
    >
      {token.raw}
    </button>
  );
}

function GlossPopover({
  selection,
  lookup,
  onClose,
  onAdded,
}: {
  selection: SelectedWord;
  lookup: GlossLookup;
  onClose: () => void;
  onAdded: (next: GlossLookup) => void;
}) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [pending, startTransition] = useTransition();
  const [addError, setAddError] = useState<string | null>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!popoverRef.current) return;
      if (!(e.target instanceof Node)) return;
      if (popoverRef.current.contains(e.target)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  function onAdd() {
    if (lookup.kind !== "ready") return;
    setAddError(null);
    const gloss = lookup.gloss;
    startTransition(async () => {
      const result = await addTranscriptWordToVocab({
        segmentId: selection.segmentId,
        word: selection.word,
        gloss,
      });
      if (!result.ok) {
        setAddError(result.error);
        return;
      }
      onAdded({
        kind: "added",
        gloss: result.gloss,
        reused: result.reused,
        cardId: result.cardId,
      });
    });
  }

  // Clamp horizontally to viewport. Width is fixed at 18rem to keep wrapping
  // predictable on mobile.
  const popoverWidthPx = 288;
  const margin = 8;
  const viewportWidth = typeof window === "undefined" ? 1024 : window.innerWidth;
  const desiredLeft = selection.anchorLeft + selection.anchorWidth / 2 - popoverWidthPx / 2;
  const left = Math.max(margin, Math.min(desiredLeft, viewportWidth - popoverWidthPx - margin));
  const top = selection.anchorTop + 24;

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={`Word: ${selection.word}`}
      style={{ position: "absolute", top, left, width: popoverWidthPx }}
      className="z-30 rounded-xl border border-border bg-surface p-3 shadow-lg"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold text-foreground">{selection.word}</p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close lookup"
          className="text-foreground-subtle transition hover:text-foreground"
        >
          ×
        </button>
      </div>
      <div className="mt-2 min-h-[2.5rem] text-xs text-foreground-muted">
        {lookup.kind === "loading" ? (
          <span className="italic text-foreground-subtle">Looking up…</span>
        ) : lookup.kind === "error" ? (
          <span className="text-danger">{lookup.message}</span>
        ) : lookup.kind === "ready" ? (
          <p className="leading-relaxed">{lookup.gloss}</p>
        ) : (
          <div className="space-y-1">
            <p className="leading-relaxed">{lookup.gloss}</p>
            <p className="text-[11px] text-success">
              {lookup.reused ? "Already in your deck — re-linked to this lesson." : "Added to your deck."}
            </p>
          </div>
        )}
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        {lookup.kind === "ready" ? (
          <button
            type="button"
            onClick={onAdd}
            disabled={pending}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-accent px-3 text-[11px] font-medium text-accent-foreground transition hover:opacity-90 disabled:opacity-60"
          >
            {pending ? "Adding…" : "Add to vocab"}
          </button>
        ) : null}
        {lookup.kind === "error" ? (
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-3 text-[11px] font-medium text-foreground-muted transition hover:bg-surface-muted hover:text-foreground"
          >
            Close
          </button>
        ) : null}
      </div>
      {addError ? (
        <p className="mt-2 text-[11px] text-danger" role="alert">
          {addError}
        </p>
      ) : null}
    </div>
  );
}

function SpeakerLegend({ segments }: { segments: TranscriptSegmentRow[] }) {
  const seen = new Map<string, ReturnType<typeof formatSpeaker>>();
  for (const seg of segments) {
    const view = formatSpeaker(seg.speaker);
    if (!seen.has(view.key)) seen.set(view.key, view);
  }
  if (seen.size === 0) return null;
  return (
    <div className="flex flex-wrap gap-2" aria-label="Speakers in this transcript">
      {Array.from(seen.values()).map((view) => (
        <span
          key={view.key}
          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${view.tone}`}
        >
          {view.display}
        </span>
      ))}
    </div>
  );
}

function TranscriptEmptyState({ status }: { status: LessonProcessingStatus | null }) {
  if (status === "failed") {
    return (
      <EmptyState
        title="Transcript unavailable"
        description="This lesson didn't finish processing, so we don't have a transcript to show yet."
      />
    );
  }
  if (
    status === "queued" ||
    status === "transcribing" ||
    status === "diarizing" ||
    status === "extracting" ||
    status === "generating_audio"
  ) {
    return (
      <EmptyState
        title="Transcript not ready yet"
        description="We'll show timestamped segments here as soon as transcription finishes."
      />
    );
  }
  if (status === "ready") {
    return (
      <EmptyState
        title="No transcript segments"
        description="This lesson finished processing but no transcript segments were stored."
      />
    );
  }
  return (
    <EmptyState
      title="No transcript yet"
      description="Upload the lesson audio to generate a transcript."
    />
  );
}

function uniqueSpeakers(segments: TranscriptSegmentRow[]): Set<string> {
  const set = new Set<string>();
  for (const seg of segments) {
    set.add(formatSpeaker(seg.speaker).key);
  }
  return set;
}

function hasAnySpeakerLabel(segments: TranscriptSegmentRow[]): boolean {
  return segments.some((s) => Boolean(s.speaker && s.speaker.trim().length > 0));
}

// A segment is treated as "code-switched" when either (a) diarization flagged
// it as low-priority (the teacher's English meta-explanation) or (b) its
// language tag doesn't match the lesson's target language. These are the
// segments we deliberately skip during vocab extraction; the UI labels them
// so the user doesn't expect a vocab card to appear.
export function isCodeSwitched(
  segment: TranscriptSegmentRow,
  targetLanguage: string | null,
): boolean {
  if (segment.speakerLowPriority) return true;
  if (!targetLanguage || !segment.language) return false;
  const target = targetLanguage.toLowerCase();
  const segLang = segment.language.toLowerCase();
  // Compare BCP-47 primary subtag (`id` vs `id-ID`).
  const targetPrimary = target.split("-")[0] ?? target;
  const segPrimary = segLang.split("-")[0] ?? segLang;
  return targetPrimary !== segPrimary;
}
