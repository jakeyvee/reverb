import {
  ExtractionOutputSchema,
  SCHEMA_VERSIONS,
  type DiarizationInputSegment,
  type ExtractionOutput,
  type SpeakerLabel,
} from "@reverb/domain";

// Pinned version persisted on every extraction run alongside the model id, so
// a future migration can identify (and selectively reprocess) lessons whose
// derived content came from an older prompt.
export const EXTRACTION_PROMPT_VERSION = "extract-v1";

// Default Anthropic model. Extraction is the largest LLM hop in the pipeline —
// it has to read the whole diarized transcript and emit structured JSON across
// four categories — so we lean on Sonnet rather than Haiku. Pinned here so a
// quiet upstream default change surfaces as a code change rather than silent
// drift in lesson content.
export const EXTRACTION_DEFAULT_MODEL = "claude-sonnet-4-6";

// The kinds we persist one extraction_runs row per. The DB enum is
// `extraction_run_kind` and matches this tuple element-for-element; importing
// the enum from generated types would create a dependency cycle (packages/ai
// must not depend on packages/db), so we keep this list authoritative here
// and assert the union at the consumer.
export const EXTRACTION_RUN_KINDS = ["vocab", "grammar", "dialogue", "corrections"] as const;
export type ExtractionRunKind = (typeof EXTRACTION_RUN_KINDS)[number];

// Each segment we send the LLM carries the diarization label plus the
// low-priority flag the diarization pass set on code-switched English. The
// prompt uses that flag to skip those segments for *vocab* extraction while
// still letting the model reference them for clip boundaries and corrections.
export type ExtractionSegment = DiarizationInputSegment & {
  speaker: SpeakerLabel;
  lowPriority: boolean;
};

export type ExtractionInput = {
  sourceTranscriptId: string;
  language: string;
  segments: ExtractionSegment[];
};

const SECONDS = (n: number): string => `${n.toFixed(2)}s`;

// System message. The four-section output, the segment-id round-trip
// requirement, and the "skip English-only teaching explanations for vocab"
// rule are all encoded here. The prompt asks the model to keep references to
// transcript segment ids on every emitted item so we can later (a) render the
// item's source context in the UI and (b) attach the original audio clip.
export const EXTRACTION_SYSTEM_PROMPT = [
  "You are extracting structured study material from a diarized one-on-one Preply lesson.",
  "The cast is fixed: one teacher and two students named Vincent and his girlfriend (gf).",
  "Speakers in the transcript use the labels: teacher, student_vincent, student_gf, unknown.",
  "",
  "Output four sections in a single JSON object:",
  "1. new_vocab          — words/phrases the students should learn from this lesson.",
  "2. grammar_patterns   — grammar structures explicitly taught or demonstrated.",
  "3. dialogue_clips     — short re-listenable exchanges (boundaries by segment id).",
  "4. teacher_corrections— moments where the teacher corrects a student utterance.",
  "",
  "Hard rules — violations fail the run and are not partially recoverable:",
  "- Every item MUST cite the segment ids it came from in sourceSegmentIds / segmentId / startSegmentId / endSegmentId. The ids you see in the input (S0, S1, …) are the canonical ids — round-trip them exactly.",
  "- For vocab: SKIP segments marked [lowPriority] in the input. Those are the teacher's English-only or code-switched teaching meta-explanations (e.g. 'so the word for cat is…'). They are present so you can use them as *context* for grammar or corrections, but the surface text is not target-language vocabulary and must never be emitted as a new_vocab entry.",
  "- For vocab: the `term` field MUST be in the target language (the lesson's `language`). Never put an English explanation as a term.",
  "- For grammar_patterns: examples must come from the target-language segments. The explanation may be the teacher's English meta-instruction.",
  "- For dialogue_clips: choose 5–30 second exchanges that are useful for shadowing or scenario practice. startSegmentId/endSegmentId define the inclusive boundaries; startSec/endSec must mirror those segments' time range.",
  "- For teacher_corrections: only emit when the teacher visibly corrects a student. studentSpeaker MUST be student_vincent or student_gf — never teacher or unknown.",
  "- Empty arrays are fine. Do NOT fabricate items to fill a section.",
  "",
  "Schema and versioning:",
  '- Set schemaVersion to the integer ' + String(SCHEMA_VERSIONS.extractionOutput) + ".",
  '- Set promptVersion to "' + EXTRACTION_PROMPT_VERSION + '".',
  "- Set language to the lesson language passed in the user message.",
  "- Set sourceTranscriptId to the value passed in the user message.",
  "",
  "Output STRICT JSON, no prose, no markdown fences. Exact shape:",
  "{",
  '  "schemaVersion": ' + String(SCHEMA_VERSIONS.extractionOutput) + ",",
  '  "promptVersion": "' + EXTRACTION_PROMPT_VERSION + '",',
  '  "language": "<bcp47>",',
  '  "sourceTranscriptId": "<lesson id>",',
  '  "new_vocab": [ { "term": "...", "language": "<bcp47>", "pronunciation": "...", "partOfSpeech": "...", "gloss": "...", "example": "...", "exampleGloss": "...", "sourceSegmentIds": ["S3"], "difficulty": "beginner|intermediate|advanced" } ],',
  '  "grammar_patterns": [ { "pattern": "...", "language": "<bcp47>", "explanation": "...", "examples": [{ "target": "...", "gloss": "..." }], "sourceSegmentIds": ["S4"], "difficulty": "beginner|intermediate|advanced" } ],',
  '  "dialogue_clips": [ { "id": "clip-1", "startSegmentId": "S2", "endSegmentId": "S5", "startSec": 7.0, "endSec": 20.5, "title": "...", "description": "...", "participants": ["teacher", "student_vincent"], "language": "<bcp47>", "focus": "vocab|grammar|listening|shadowing|scenario" } ],',
  '  "teacher_corrections": [ { "studentSpeaker": "student_vincent", "segmentId": "S1", "utterance": "...", "correction": "...", "rationale": "...", "category": "grammar|vocab|pronunciation|usage|other", "severity": "minor|moderate|major" } ]',
  "}",
  "Optional fields may be omitted; required fields above are not optional.",
].join("\n");

// User-message builder. One labeled line per segment with prompt id, speaker,
// time range, lowPriority flag, language hint, and the original text. The
// model sees exactly the metadata it needs to make per-segment decisions; we
// never round-trip word-level timestamps.
export function buildExtractionUserPrompt(input: ExtractionInput): string {
  const lines: string[] = [];
  lines.push(`Lesson language: ${input.language}.`);
  lines.push(`Source transcript id: ${input.sourceTranscriptId}.`);
  lines.push("");
  lines.push("Diarized segments:");
  for (const seg of input.segments) {
    const flags = seg.lowPriority ? " [lowPriority]" : "";
    const langTag = seg.language && seg.language !== input.language ? ` lang=${seg.language}` : "";
    lines.push(
      `[${seg.id}] ${seg.speaker}${flags} (${SECONDS(seg.startSec)}–${SECONDS(seg.endSec)}${langTag}) ${seg.text}`,
    );
  }
  lines.push("");
  lines.push("Return the JSON object now. No prose.");
  return lines.join("\n");
}

export type ParseExtractionOptions = {
  sourceTranscriptId: string;
  language: string;
};

// Extract the outermost JSON object from the model response. Mirrors the
// diarization parser: Anthropic usually returns a clean object, but
// occasionally wraps it in markdown fences or a leading sentence.
function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Extraction response did not contain a JSON object");
  }
  return trimmed.slice(start, end + 1);
}

// Parse + validate the LLM response. Throws on malformed JSON or schema
// violations — the worker treats those as a stage failure so the partial
// state cannot leak into product tables.
export function parseExtractionResponse(
  raw: string,
  opts: ParseExtractionOptions,
): ExtractionOutput {
  const json = extractJsonObject(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `Extraction response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Re-stamp the fields the model is not allowed to drift on. This guarantees
  // `schemaVersion`, `promptVersion`, `language`, and `sourceTranscriptId` are
  // authoritative regardless of what the model echoed back. The strict zod
  // parse below still fails the run if the LLM emitted a wrong literal value.
  const candidate = parsed as Record<string, unknown>;
  const output = {
    schemaVersion: SCHEMA_VERSIONS.extractionOutput,
    promptVersion:
      typeof candidate.promptVersion === "string" && candidate.promptVersion.length > 0
        ? candidate.promptVersion
        : EXTRACTION_PROMPT_VERSION,
    language:
      typeof candidate.language === "string" && candidate.language.length >= 2
        ? candidate.language
        : opts.language,
    sourceTranscriptId:
      typeof candidate.sourceTranscriptId === "string" && candidate.sourceTranscriptId.length > 0
        ? candidate.sourceTranscriptId
        : opts.sourceTranscriptId,
    new_vocab: candidate.new_vocab,
    grammar_patterns: candidate.grammar_patterns,
    dialogue_clips: candidate.dialogue_clips,
    teacher_corrections: candidate.teacher_corrections,
  };

  return ExtractionOutputSchema.parse(output);
}
