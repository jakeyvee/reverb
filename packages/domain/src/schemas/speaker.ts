import { z } from "zod";

export const SPEAKER_LABELS = [
  "teacher",
  "student_vincent",
  "student_gf",
  "unknown",
] as const;

export const SpeakerLabelSchema = z.enum(SPEAKER_LABELS);
export type SpeakerLabel = z.infer<typeof SpeakerLabelSchema>;

export const STUDENT_SPEAKERS = ["student_vincent", "student_gf"] as const satisfies ReadonlyArray<
  SpeakerLabel
>;

export const StudentSpeakerSchema = z.enum(STUDENT_SPEAKERS);
export type StudentSpeaker = z.infer<typeof StudentSpeakerSchema>;
