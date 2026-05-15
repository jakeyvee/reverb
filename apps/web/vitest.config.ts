import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

// Mirrors the pattern in apps/jobs/vitest.config.ts: alias only the bits we
// actually exercise from tests, so we don't drag the Next/React graph into
// Vitest. The transcript-format module imports `@reverb/domain/schemas/speaker`
// only, so that's all we need to map.
export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@reverb/domain/schemas/speaker",
        replacement: path.resolve(here, "../../packages/domain/src/schemas/speaker.ts"),
      },
      { find: /^@\/(.+)$/, replacement: path.resolve(here, "./$1") },
    ],
  },
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
