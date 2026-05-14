# Reverb

Spaced-repetition learning app. A pnpm + Turborepo monorepo.

## Workspace layout

```
apps/
  web/        Next.js 15 App Router frontend
  jobs/       Trigger.dev v3 long-running tasks
packages/
  db/         Supabase client, migrations, RLS, seed helpers
  domain/     Zod schemas + shared TypeScript types
  ai/         Groq, Anthropic, Google TTS adapters and prompts
  srs/        FSRS scheduling helpers (ts-fsrs)
  config/     Shared TS / ESLint / Prettier / Tailwind config
```

## Prerequisites

- Node `>= 20.11` (see `.nvmrc`)
- pnpm `>= 10` (`corepack enable && corepack prepare pnpm@10 --activate`)
- Supabase CLI (optional, for local DB and type generation)

## Local setup

```bash
pnpm install
cp .env.example .env.local
cp apps/web/.env.local.example apps/web/.env.local
cp apps/jobs/.env.local.example apps/jobs/.env.local
pnpm dev:web
```

The web app boots at <http://localhost:3000>.

## Workspace scripts (run from repo root)

| Script              | Effect                                                 |
| ------------------- | ------------------------------------------------------ |
| `pnpm dev`          | Runs all `dev` tasks across the workspace (web + jobs) |
| `pnpm dev:web`      | Just the Next.js app                                   |
| `pnpm dev:jobs`     | Just the Trigger.dev worker                            |
| `pnpm build`        | `turbo run build`                                      |
| `pnpm typecheck`    | `tsc --noEmit` in every package                        |
| `pnpm lint`         | ESLint across all workspaces                           |
| `pnpm test`         | Vitest/Jest (none wired yet) across all workspaces     |
| `pnpm format`       | Prettier write                                         |
| `pnpm format:check` | Prettier check (CI-friendly)                           |
| `pnpm clean`        | Remove build outputs, caches, and `node_modules`       |

Package-scoped commands are also available, e.g. `pnpm --filter @reverb/db db:types` once Supabase
is connected.

## Required environment variables

Stub values live in `.env.example`, `apps/web/.env.local.example`, and
`apps/jobs/.env.local.example`. See [`docs/env-vars.md`](docs/env-vars.md) for
the full matrix (scope, owner, browser-safety) and
[`docs/deployment.md`](docs/deployment.md) for how to wire them into Vercel,
Trigger.dev, and Supabase. At a glance:

- **Supabase** — `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- **AI providers** — `GROQ_API_KEY`, `ANTHROPIC_API_KEY`
- **Google TTS** — `GOOGLE_TTS_API_KEY`, or `GOOGLE_APPLICATION_CREDENTIALS_JSON` (Trigger.dev) / `GOOGLE_APPLICATION_CREDENTIALS` (local)
- **Email** — `RESEND_API_KEY`
- **Trigger.dev** — `TRIGGER_SECRET_KEY`, `TRIGGER_PROJECT_ID`
- **App config** — `ALLOWED_EMAILS`, `VINCENT_UPLOAD_EMAIL`, `HOUSEHOLD_TIMEZONE`

## TypeScript path aliases

Every workspace can import shared packages by name:

```ts
import { CardSchema } from "@reverb/domain";
import { createServiceRoleClient } from "@reverb/db/server";
import { groqCompletion } from "@reverb/ai";
import { scheduleNext } from "@reverb/srs";
```

Aliases are defined once in `tsconfig.base.json` and mirrored in each app's `tsconfig.json` so IDE,
Next.js, and Trigger.dev all resolve them consistently. Package source is consumed directly via
Next.js `transpilePackages` — no build step required.

## CI

CI itself isn't wired yet, but the following commands are designed to run there as-is:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## Deployment

Reverb runs on Vercel (web), Trigger.dev (jobs), and Supabase (DB/Auth/Storage).
See [`docs/deployment.md`](docs/deployment.md) for the per-system setup walk-through
and the first-production-launch checklist.
