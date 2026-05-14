"use client";

import { useCallback, useId, useMemo, useRef, useState, type DragEvent } from "react";
import {
  LESSON_AUDIO_EXTENSIONS,
  LESSON_AUDIO_MIME_TYPES,
  MAX_LESSON_AUDIO_BYTES,
  MAX_LESSON_AUDIO_DURATION_MS,
  canonicalMimeForExtension,
  extensionForMimeType,
  extensionFromFileName,
  isLessonAudioMimeType,
} from "@reverb/domain/schemas/upload";
import { UploadIcon } from "@/components/ui/icons";
import { prepareLessonUpload, finalizeLessonUpload } from "./actions";

type Stage = "idle" | "uploading" | "finalizing" | "success";

type SelectedFile = {
  file: File;
  mimeType: string;
  durationMs: number;
  defaultTitle: string;
};

const EXTENSION_LIST = LESSON_AUDIO_EXTENSIONS.map((ext) => `.${ext}`).join(", ");
const MAX_MB = Math.round(MAX_LESSON_AUDIO_BYTES / (1024 * 1024));
const MAX_MINUTES = Math.round(MAX_LESSON_AUDIO_DURATION_MS / 60_000);

export function UploadForm() {
  const inputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SelectedFile | null>(null);
  const [title, setTitle] = useState("");
  const [dragOver, setDragOver] = useState(false);

  const acceptAttr = useMemo(
    () => [...LESSON_AUDIO_MIME_TYPES, ...LESSON_AUDIO_EXTENSIONS.map((e) => `.${e}`)].join(","),
    [],
  );

  const reset = useCallback(() => {
    setSelected(null);
    setTitle("");
    setStage("idle");
    setProgress(0);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    setProgress(0);

    const mimeType = pickMimeType(file);
    if (!mimeType) {
      setError(`Unsupported file type. Accepted: ${EXTENSION_LIST}.`);
      setSelected(null);
      return;
    }
    if (file.size <= 0) {
      setError("That file looks empty.");
      setSelected(null);
      return;
    }
    if (file.size > MAX_LESSON_AUDIO_BYTES) {
      setError(`File exceeds the ${MAX_MB} MB limit.`);
      setSelected(null);
      return;
    }

    let durationMs: number;
    try {
      durationMs = await readDurationMs(file);
    } catch {
      setError("Couldn't read the audio. Try a different file.");
      setSelected(null);
      return;
    }
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      setError("Couldn't determine the audio length.");
      setSelected(null);
      return;
    }
    if (durationMs > MAX_LESSON_AUDIO_DURATION_MS) {
      setError(`Audio exceeds the ${MAX_MINUTES}-minute limit.`);
      setSelected(null);
      return;
    }

    const defaultTitle = deriveTitle(file.name);
    setSelected({ file, mimeType, durationMs, defaultTitle });
    setTitle(defaultTitle);
  }, []);

  const handleDrop = useCallback(
    async (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragOver(false);
      if (stage === "uploading" || stage === "finalizing") return;
      const file = event.dataTransfer.files?.[0];
      if (file) await handleFile(file);
    },
    [handleFile, stage],
  );

  const handleUpload = useCallback(async () => {
    if (!selected) return;
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError("Add a short title for this lesson.");
      return;
    }

    setError(null);
    setStage("uploading");
    setProgress(0);

    const prepared = await prepareLessonUpload({
      fileName: selected.file.name,
      mimeType: selected.mimeType,
      byteSize: selected.file.size,
      durationMs: selected.durationMs,
    });
    if (!prepared.ok) {
      setError(prepared.error);
      setStage("idle");
      return;
    }

    try {
      await putWithProgress(prepared.signedUrl, selected.file, selected.mimeType, (p) =>
        setProgress(p),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
      setStage("idle");
      return;
    }

    setStage("finalizing");

    const finalized = await finalizeLessonUpload({
      lessonId: prepared.lessonId,
      storagePath: prepared.storagePath,
      fileName: selected.file.name,
      mimeType: selected.mimeType,
      byteSize: selected.file.size,
      durationMs: selected.durationMs,
      title: trimmedTitle,
    });
    if (!finalized.ok) {
      setError(finalized.error);
      setStage("idle");
      return;
    }

    setStage("success");
  }, [selected, title]);

  const busy = stage === "uploading" || stage === "finalizing";

  return (
    <div className="space-y-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        aria-disabled={busy}
        className={`flex flex-col items-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 text-center transition ${
          dragOver
            ? "border-accent bg-surface-muted/60"
            : "border-border bg-surface"
        } ${busy ? "opacity-60" : ""}`}
      >
        <span className="grid h-12 w-12 place-items-center rounded-full bg-surface-muted text-foreground-subtle">
          <UploadIcon width={20} height={20} />
        </span>
        <p className="text-sm font-medium">Drop a lesson audio file here</p>
        <p className="max-w-sm text-xs text-foreground-subtle">
          {EXTENSION_LIST} · up to {MAX_MB} MB and {MAX_MINUTES} minutes
        </p>
        <input
          id={inputId}
          ref={fileInputRef}
          type="file"
          accept={acceptAttr}
          disabled={busy}
          className="sr-only"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (file) await handleFile(file);
          }}
        />
        <label
          htmlFor={inputId}
          className={`inline-flex h-9 cursor-pointer items-center rounded-md border border-border px-3 text-xs font-medium text-foreground-muted transition hover:bg-surface-muted hover:text-foreground ${
            busy ? "pointer-events-none opacity-60" : ""
          }`}
        >
          Choose file
        </label>
      </div>

      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}

      {selected && stage !== "success" ? (
        <div className="space-y-4 rounded-xl border border-border bg-surface p-4">
          <div className="space-y-1">
            <p className="truncate text-sm font-medium">{selected.file.name}</p>
            <p className="text-xs text-foreground-subtle">
              {formatBytes(selected.file.size)} · {formatDuration(selected.durationMs)}
            </p>
          </div>

          <label className="block space-y-1.5">
            <span className="block text-xs font-medium uppercase tracking-wider text-foreground-subtle">
              Lesson title
            </span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={busy}
              maxLength={160}
              className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground"
            />
          </label>

          {stage === "uploading" ? (
            <div>
              <ProgressBar value={progress} />
              <p className="mt-1 text-xs text-foreground-subtle">
                Uploading… {Math.round(progress * 100)}%
              </p>
            </div>
          ) : null}

          {stage === "finalizing" ? (
            <p className="text-xs text-foreground-subtle">Queueing for processing…</p>
          ) : null}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleUpload}
              disabled={busy}
              className="inline-flex h-10 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground transition hover:opacity-90 disabled:opacity-60"
            >
              <UploadIcon width={16} height={16} />
              {busy ? "Uploading…" : "Upload lesson"}
            </button>
            <button
              type="button"
              onClick={reset}
              disabled={busy}
              className="inline-flex h-10 items-center rounded-md border border-border px-4 text-sm font-medium text-foreground-muted transition hover:bg-surface-muted hover:text-foreground disabled:opacity-60"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {stage === "success" && selected ? (
        <div className="rounded-xl border border-border bg-surface p-4">
          <p className="text-sm font-medium text-success">Lesson queued for processing</p>
          <p className="mt-1 text-xs text-foreground-subtle">
            {selected.file.name} is uploading off to the workers. New cards will land in Lessons
            once they&apos;re ready.
          </p>
          <button
            type="button"
            onClick={reset}
            className="mt-3 inline-flex h-9 items-center rounded-md border border-border px-3 text-xs font-medium text-foreground-muted transition hover:bg-surface-muted hover:text-foreground"
          >
            Upload another
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ProgressBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-surface-muted">
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-200"
        style={{ width: `${pct}%` }}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
      />
    </div>
  );
}

function pickMimeType(file: File): string | null {
  if (file.type && isLessonAudioMimeType(file.type)) return file.type;
  const ext = extensionFromFileName(file.name);
  if (ext) return canonicalMimeForExtension(ext);
  // Last-ditch: some browsers report `audio/mp3` from the extension picker
  // before the file-type heuristics kick in. Map it via the existing helper.
  if (file.type && extensionForMimeType(file.type)) return file.type;
  return null;
}

function deriveTitle(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const cleaned = base.replace(/[._-]+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : "Lesson";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function readDurationMs(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    const cleanup = () => URL.revokeObjectURL(url);
    audio.onloadedmetadata = () => {
      const ms = Math.round(audio.duration * 1000);
      cleanup();
      resolve(ms);
    };
    audio.onerror = () => {
      cleanup();
      reject(new Error("metadata error"));
    };
    audio.src = url;
  });
}

function putWithProgress(
  url: string,
  file: File,
  contentType: string,
  onProgress: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType || "application/octet-stream");
    xhr.setRequestHeader("x-upsert", "false");
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    });
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1);
        resolve();
      } else {
        reject(new Error(`Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.onabort = () => reject(new Error("Upload was cancelled"));
    xhr.send(file);
  });
}
