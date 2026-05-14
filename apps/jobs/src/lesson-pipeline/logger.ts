// Logger seam: the Trigger.dev task injects `@trigger.dev/sdk/v3` `logger` so
// pipeline events show up as structured fields in the Trigger.dev dashboard.
// Tests inject a no-op or capturing logger so they don't need the Trigger
// runtime to exercise the orchestrator.
export type PipelineLogger = {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
};

export const noopLogger: PipelineLogger = {
  info: () => {},
  error: () => {},
};
