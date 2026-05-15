import {
  DiarizationOutputSchema,
  SCHEMA_VERSIONS,
  type DiarizationInput,
  type DiarizationOutput,
} from "@reverb/domain";

// Pinned identifier persisted on every diarization run. Bump when the prompt
// or output shape changes meaningfully so we can later reprocess only the
// lessons whose labels came from an older revision.
export const DIARIZATION_PROMPT_VERSION = "diarization-v1";

// Default Anthropic model for diarization. Haiku is fast/cheap and the task
// (classify ~hundreds of segments into four labels) is well within its
// envelope. The full model id is pinned so a quiet upstream default change
// surfaces as a code change.
export const DIARIZATION_DEFAULT_MODEL = "claude-haiku-4-5-20251001";

const SECONDS = (n: number): string => `${n.toFixed(2)}s`;

// System message. Spells out the cast (one teacher, two students Vincent and
// his girlfriend), the closed label set, and — most importantly — the rule to
// prefer "unknown" over guessing. Code-switched English segments stay in the
// transcript view but are flagged so extraction can ignore them.
export const DIARIZATION_SYSTEM_PROMPT = [
  "You label transcript segments from a one-on-one Preply language lesson.",
  "The cast is fixed: one teacher and two students named Vincent and his girlfriend (gf).",
  "Use exactly these labels: teacher, student_vincent, student_gf, unknown.",
  "",
  "Hard rules:",
  '- Prefer "unknown" over guessing. If the context for a segment is weak, output "unknown" — never invent a speaker from a hunch.',
  "- Do NOT modify the segment text. You are labeling, not editing.",
  '- Preserve every segment in the output. Even if you cannot label it, return it with speaker="unknown" rather than dropping it.',
  '- When speaker="unknown", set confidence to at most 0.4. When you are confident, you may go up to 1.0.',
  "",
  "Heuristics that frequently surface in these recordings:",
  "- The teacher leads, asks questions, gives corrections, restates target words slowly, and switches to English to translate.",
  "- The two students take turns repeating phrases, attempting sentences, and asking for clarification. They rarely correct each other.",
  "- Without an audible cue you cannot reliably tell Vincent from his gf. When two students speak in close succession, prefer 'unknown' for the second one over guessing.",
  "",
  "Code-switching:",
  "- Segments that are partly or fully in English (or any other language not being learned) MUST stay in the output with their text intact so they remain in the transcript view.",
  "- Set lowPriority=true on those segments so the extraction step skips them. The teacher's English meta-instructions count as low priority.",
  "- Segments fully in the target language are lowPriority=false.",
  "",
  "Output STRICT JSON, no prose, no markdown fences. Exact shape:",
  "{",
  '  "promptVersion": "' + DIARIZATION_PROMPT_VERSION + '",',
  '  "segments": [',
  '    { "segmentId": "S0", "speaker": "teacher", "confidence": 0.92, "lowPriority": false, "notes": "optional one-line rationale" }',
  "  ]",
  "}",
  "Notes is optional — include it only when the choice was non-obvious. Confidence is in [0,1].",
].join("\n");

// User-message builder. Lists each segment with a stable id we can round-trip
// through the parser, plus the time range and language hint so the model sees
// pacing context.
export function buildDiarizationUserPrompt(input: DiarizationInput): string {
  const lines: string[] = [];
  lines.push(`Lesson language: ${input.language}.`);
  lines.push(`Source transcript id: ${input.sourceTranscriptId}.`);
  lines.push("");
  lines.push("Segments to label:");
  for (const seg of input.segments) {
    const langTag = seg.language && seg.language !== input.language ? ` lang=${seg.language}` : "";
    lines.push(
      `[${seg.id}] (${SECONDS(seg.startSec)}–${SECONDS(seg.endSec)}${langTag}) ${seg.text}`,
    );
  }
  lines.push("");
  lines.push("Return the JSON object now. No prose.");
  return lines.join("\n");
}

export type ParseDiarizationOptions = {
  sourceTranscriptId: string;
  model: string;
};

// Lift a JSON object out of the LLM response. Anthropic usually returns clean
// JSON when asked but sometimes wraps it in markdown fences or chatter; we
// extract the outermost {...} block so both shapes parse.
function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Diarization response did not contain a JSON object");
  }
  return trimmed.slice(start, end + 1);
}

// Parse the LLM response into a domain DiarizationOutput. Throws on malformed
// JSON or schema violations — the worker treats those as a stage failure so
// the run is recorded as failed and the per-stage retry can pick it up.
export function parseDiarizationResponse(
  raw: string,
  opts: ParseDiarizationOptions,
): DiarizationOutput {
  const json = extractJsonObject(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `Diarization response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Wrap with the fields the model never has to repeat (schemaVersion, model,
  // sourceTranscriptId) so the prompt stays terse and the schema stays strict.
  const candidate = parsed as Record<string, unknown>;
  const output = {
    schemaVersion: SCHEMA_VERSIONS.diarization,
    promptVersion:
      typeof candidate.promptVersion === "string" && candidate.promptVersion.length > 0
        ? candidate.promptVersion
        : DIARIZATION_PROMPT_VERSION,
    model: opts.model,
    sourceTranscriptId: opts.sourceTranscriptId,
    segments: candidate.segments,
  };

  return DiarizationOutputSchema.parse(output);
}
