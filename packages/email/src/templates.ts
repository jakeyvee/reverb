import { emailEnv } from "./env.js";

export type LessonCounts = {
  newVocab: number;
  grammarPatterns: number;
  teacherCorrections: number;
  dialogueClips: number;
};

export type LessonReadyTemplateInput = {
  lessonTitle: string;
  lessonId: string;
  counts: LessonCounts;
};

export type LessonFailedTemplateInput = {
  lessonTitle: string;
  lessonId: string;
  errorSummary: string | null;
  stage: string | null;
  attempt: number;
};

export type RenderedEmail = {
  subject: string;
  html: string;
  text: string;
};

// We render simple inline HTML and a plain-text alternative. No external CSS,
// no images — Reverb is a household tool with two recipients, and the goal is
// for the message to render readably in every mail client without surprises.

export function renderLessonReadyEmail(input: LessonReadyTemplateInput): RenderedEmail {
  const appUrl = emailEnv.appUrl();
  const lessonUrl = `${appUrl}/lessons/${input.lessonId}`;
  const practiceUrl = `${appUrl}/session`;
  const safeTitle = escapeHtml(input.lessonTitle);
  const items = countItems(input.counts);
  const subject = `Your lesson "${input.lessonTitle}" is ready`;

  const html = `<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #111; line-height: 1.5;">
    <p>Hi there,</p>
    <p>Your latest Reverb lesson has finished processing and there's new practice material waiting.</p>
    <p><strong>${safeTitle}</strong></p>
    ${renderCountsHtml(input.counts)}
    <p>
      <a href="${lessonUrl}" style="display: inline-block; background: #111; color: #fff; padding: 10px 16px; border-radius: 6px; text-decoration: none;">Open lesson</a>
      &nbsp;
      <a href="${practiceUrl}" style="color: #111;">Start a practice session</a>
    </p>
    <p style="color: #555; font-size: 12px;">— Reverb${items === 0 ? " (no new items were extracted from this recording — review the transcript to see what came through)" : ""}</p>
  </body>
</html>`;

  const text = [
    `Your latest Reverb lesson has finished processing.`,
    ``,
    input.lessonTitle,
    renderCountsText(input.counts),
    ``,
    `Open lesson: ${lessonUrl}`,
    `Practice now: ${practiceUrl}`,
  ]
    .join("\n")
    .trim();

  return { subject, html, text };
}

export function renderLessonFailedEmail(input: LessonFailedTemplateInput): RenderedEmail {
  const appUrl = emailEnv.appUrl();
  const lessonUrl = `${appUrl}/lessons/${input.lessonId}`;
  // Retries are triggered from the upload page, where Vincent has the
  // file-source picker and the failure surface lives.
  const retryUrl = `${appUrl}/upload`;
  const safeTitle = escapeHtml(input.lessonTitle);
  const summary = input.errorSummary?.trim() ? escapeHtml(input.errorSummary.trim()) : null;
  const stage = input.stage ? escapeHtml(input.stage) : null;
  const subject = `Reverb couldn't finish "${input.lessonTitle}"`;

  const html = `<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #111; line-height: 1.5;">
    <p>Hi Vincent,</p>
    <p>Reverb hit an error while processing <strong>${safeTitle}</strong>.</p>
    ${summary ? `<p><strong>What went wrong:</strong> ${summary}</p>` : ""}
    ${stage ? `<p style="color: #555; font-size: 12px;">Stage: ${stage} (attempt ${input.attempt})</p>` : ""}
    <p>You can retry it from the upload page — Reverb will resume from the failed stage rather than start over.</p>
    <p>
      <a href="${retryUrl}" style="display: inline-block; background: #b00020; color: #fff; padding: 10px 16px; border-radius: 6px; text-decoration: none;">Retry processing</a>
      &nbsp;
      <a href="${lessonUrl}" style="color: #111;">View lesson</a>
    </p>
    <p style="color: #555; font-size: 12px;">— Reverb</p>
  </body>
</html>`;

  const text = [
    `Reverb couldn't finish processing "${input.lessonTitle}".`,
    summary ? `What went wrong: ${input.errorSummary}` : null,
    stage ? `Stage: ${input.stage} (attempt ${input.attempt})` : null,
    ``,
    `Retry: ${retryUrl}`,
    `View lesson: ${lessonUrl}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  return { subject, html, text };
}

function renderCountsHtml(counts: LessonCounts): string {
  const rows = countRows(counts);
  if (rows.length === 0) return "";
  return `<ul>${rows.map(([label, n]) => `<li>${escapeHtml(label)}: <strong>${n}</strong></li>`).join("")}</ul>`;
}

function renderCountsText(counts: LessonCounts): string {
  const rows = countRows(counts);
  if (rows.length === 0) return "";
  return rows.map(([label, n]) => `  • ${label}: ${n}`).join("\n");
}

function countRows(counts: LessonCounts): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  if (counts.newVocab > 0) out.push(["New words", counts.newVocab]);
  if (counts.grammarPatterns > 0) out.push(["Grammar patterns", counts.grammarPatterns]);
  if (counts.teacherCorrections > 0) out.push(["Corrections", counts.teacherCorrections]);
  if (counts.dialogueClips > 0) out.push(["Dialogue clips", counts.dialogueClips]);
  return out;
}

function countItems(counts: LessonCounts): number {
  return (
    counts.newVocab + counts.grammarPatterns + counts.teacherCorrections + counts.dialogueClips
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
