import { SPEAKER_LABELS, type SpeakerLabel } from "@reverb/domain/schemas/speaker";

// Friendly labels for the canonical speaker enum. Anything outside the enum
// (raw diarization labels like `SPEAKER_00`, or `null` when diarization hasn't
// run) gets a generic fallback — see `formatSpeakerDisplay`.
const SPEAKER_DISPLAY: Record<SpeakerLabel, string> = {
  teacher: "Teacher",
  student_vincent: "Vincent",
  student_gf: "Partner",
  unknown: "Unknown speaker",
};

// Stable colour assignment so the same speaker reads the same way across the
// transcript. The classes are border-only so they layer well over both light
// and dark surfaces.
const SPEAKER_TONE: Record<SpeakerLabel, string> = {
  teacher: "border-accent/60 text-accent",
  student_vincent: "border-success/60 text-success",
  student_gf: "border-warning/60 text-warning",
  unknown: "border-border-strong text-foreground-muted",
};

// Hash of the raw label string → one of N tones, so unknown labels that come
// straight from the ASR ("SPEAKER_00", "SPEAKER_01") still get distinguishable
// colours even before we map them onto the canonical enum.
const FALLBACK_TONES = [
  "border-border-strong text-foreground",
  "border-accent/40 text-accent",
  "border-warning/40 text-warning",
  "border-success/40 text-success",
  "border-danger/40 text-danger",
];

export type SpeakerView = {
  // The label shown next to a segment.
  display: string;
  // Tailwind classes for the small pill rendered before the segment text.
  tone: string;
  // Stable key for memoisation/keying. Matches `display` when the raw label is
  // missing, otherwise the normalised raw value.
  key: string;
};

function isCanonicalSpeaker(value: string): value is SpeakerLabel {
  return (SPEAKER_LABELS as readonly string[]).includes(value);
}

// Deterministic hash → one of `FALLBACK_TONES`. djb2-style folding; small input
// alphabet (single-byte chars after normalisation) so the cheap version is fine.
function fallbackTone(key: string): string {
  let hash = 5381;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 33 + key.charCodeAt(i)) >>> 0;
  }
  return FALLBACK_TONES[hash % FALLBACK_TONES.length]!;
}

export function formatSpeaker(raw: string | null | undefined): SpeakerView {
  if (!raw || raw.trim().length === 0) {
    return {
      display: "Unknown speaker",
      tone: SPEAKER_TONE.unknown,
      key: "__unknown__",
    };
  }
  const normalised = raw.trim();
  if (isCanonicalSpeaker(normalised)) {
    return {
      display: SPEAKER_DISPLAY[normalised],
      tone: SPEAKER_TONE[normalised],
      key: normalised,
    };
  }
  // Raw ASR speaker labels (e.g. `SPEAKER_00`) — surface them verbatim so a
  // developer spot-checking diarization can still tell speakers apart.
  return {
    display: normalised,
    tone: fallbackTone(normalised),
    key: normalised,
  };
}

// `mm:ss` for sub-hour clips, `h:mm:ss` for longer ones. Matches the audio
// element's native current-time formatting so segment timestamps line up.
export function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const mm = hours > 0 ? minutes.toString().padStart(2, "0") : minutes.toString();
  const ss = seconds.toString().padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}
