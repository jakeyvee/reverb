# Environment variables

Single source of truth for every variable Reverb consumes. The root
[`.env.example`](../.env.example) mirrors this list; if you add a variable to
one, add it to the other.

## How to read this

- **Used by** — which workspace process reads it at runtime.
- **Browser?** — whether the value is shipped to the client bundle. Only
  `NEXT_PUBLIC_*` values may be browser-readable. Everything else is server-only
  and must never appear in a `NEXT_PUBLIC_*` prefix or be returned from a route
  handler / RSC payload to the client.
- **Where to set** — the upstream system that owns this value for hosted
  environments. Local development reads from `.env.local`.
- **Owner** — who provisions and rotates the secret.

## Reference

| Variable                              | Used by                | Browser? | Where to set                                    | Owner    |
| ------------------------------------- | ---------------------- | -------- | ----------------------------------------------- | -------- |
| `NEXT_PUBLIC_SUPABASE_URL`            | web, jobs              | yes      | Vercel, Trigger.dev, `.env.local`               | platform |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`       | web                    | yes      | Vercel, `.env.local`                            | platform |
| `SUPABASE_SERVICE_ROLE_KEY`           | web (server), jobs     | **NO**   | Vercel (server-only), Trigger.dev, `.env.local` | platform |
| `GROQ_API_KEY`                        | jobs                   | NO       | Trigger.dev, `.env.local`                       | ai       |
| `ANTHROPIC_API_KEY`                   | jobs                   | NO       | Trigger.dev, `.env.local`                       | ai       |
| `GOOGLE_TTS_API_KEY`                  | jobs                   | NO       | Trigger.dev, `.env.local`                       | ai       |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` | jobs (hosted)          | NO       | Trigger.dev                                     | ai       |
| `GOOGLE_APPLICATION_CREDENTIALS`      | jobs (local file path) | NO       | `.env.local` only                               | ai       |
| `RESEND_API_KEY`                      | web, jobs              | NO       | Vercel, Trigger.dev, `.env.local`               | comms    |
| `TRIGGER_SECRET_KEY`                  | web (to enqueue)       | NO       | Vercel, `.env.local`                            | platform |
| `TRIGGER_PROJECT_ID`                  | web, jobs              | NO       | Vercel, Trigger.dev, `.env.local`               | platform |
| `ALLOWED_EMAILS`                      | web                    | NO       | Vercel, `.env.local`                            | platform |
| `VINCENT_UPLOAD_EMAIL`                | web, jobs              | NO       | Vercel, Trigger.dev, `.env.local`               | content  |
| `HOUSEHOLD_TIMEZONE`                  | web, jobs              | NO       | Vercel, Trigger.dev, `.env.local`               | platform |

### Notes per variable

- **`SUPABASE_SERVICE_ROLE_KEY`** — bypasses Row Level Security. Reads must
  stay inside server code (route handlers, RSC, server actions, Trigger.dev
  tasks). Never import `@reverb/db/server` from a client component.
- **Google TTS auth** — pick exactly one path; `getGoogleTtsClient()` checks
  them in this order:
  1. `GOOGLE_APPLICATION_CREDENTIALS_JSON` — inline service-account JSON,
     parsed and passed as `credentials`. Preferred for Trigger.dev hosted
     runs, which have no persistent filesystem.
  2. `GOOGLE_TTS_API_KEY` — API-key auth (simplest; works on any runtime).
  3. `GOOGLE_APPLICATION_CREDENTIALS` — file path read by the Google auth
     library's default lookup. Intended for local development only.
- **Trigger.dev keys** — `trigger.dev dev` and `trigger.dev deploy` source
  these from the CLI's credential store once you've run `trigger.dev login`.
  The env values above are only required when _other_ processes (e.g. the
  web app enqueuing a task) need to talk to Trigger.dev directly.
- **Google OAuth (sign-in)** — Client ID and secret live in the **Supabase
  Auth → Providers → Google** panel, not in app env. They are still part of
  the launch checklist; see [deployment.md](./deployment.md).
- **`ALLOWED_EMAILS`** — comma-separated allow-list, e.g.
  `alice@example.com,bob@example.com`. Treated as a server-only secret because
  it leaks the household roster otherwise. Compared case-insensitively in
  middleware and the OAuth callback; an empty value fails closed (no one can
  sign in).
- **`VINCENT_UPLOAD_EMAIL`** — single email that identifies Vincent for the
  upload-only permission. Compared against the signed-in user's email in the
  web app, and used by `apps/jobs` to address Resend inbound forwards. Must
  also appear in `ALLOWED_EMAILS`.
- **`HOUSEHOLD_TIMEZONE`** — IANA name (e.g. `America/Los_Angeles`). Used by
  schedulers for daily rollovers; not browser-public to keep server time-zone
  logic authoritative.

## Per-environment expectations

| Environment   | Supabase project                                | Source of vars                                     |
| ------------- | ----------------------------------------------- | -------------------------------------------------- |
| `development` | local (`supabase start`) or shared dev project  | `.env.local` (gitignored)                          |
| `preview`     | Supabase preview branch (or shared dev project) | Vercel "Preview" scope + Trigger.dev `staging` env |
| `production`  | dedicated `reverb` project                      | Vercel "Production" scope + Trigger.dev `prod` env |

Keep the variable _set_ identical across environments; only the values
differ. Missing a variable in one environment is the most common cause of
silently-degraded behavior on Preview.
