import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

// Vite/Vitest aliases use startsWith matching, so the more specific subpath
// entries must come first — otherwise a bare `@reverb/db` would also match
// `@reverb/db/server` and rewrite it to `.../src/index.ts/server`.
//
// We only alias the subpaths the pipeline actually imports. The bare package
// names are left to Node's exports-field resolution against the workspace
// symlink in apps/jobs/node_modules.
export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@reverb/db/server",
        replacement: path.resolve(here, "../../packages/db/src/server.ts"),
      },
      {
        find: "@reverb/db/types",
        replacement: path.resolve(here, "../../packages/db/src/types.ts"),
      },
      {
        find: "@reverb/db/usage",
        replacement: path.resolve(here, "../../packages/db/src/usage.ts"),
      },
      {
        find: "@reverb/domain/schemas/upload",
        replacement: path.resolve(here, "../../packages/domain/src/schemas/upload.ts"),
      },
      {
        find: "@reverb/domain/schemas/lesson-status",
        replacement: path.resolve(here, "../../packages/domain/src/schemas/lesson-status.ts"),
      },
      {
        find: "@reverb/media",
        replacement: path.resolve(here, "../../packages/media/src/index.ts"),
      },
      {
        find: "@reverb/email",
        replacement: path.resolve(here, "../../packages/email/src/index.ts"),
      },
    ],
  },
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
