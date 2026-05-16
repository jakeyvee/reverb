export const SCHEMA_VERSIONS = {
  transcript: 1,
  diarization: 1,
  extractionOutput: 1,
  practiceItem: 1,
  session: 1,
  xpEvent: 1,
  streakEvent: 1,
  grammarExercise: 1,
} as const;

export type SchemaVersions = typeof SCHEMA_VERSIONS;
export type SchemaName = keyof SchemaVersions;
