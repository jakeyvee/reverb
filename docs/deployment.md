# Deployment

Reverb runs on three hosted systems. Each must be wired separately, but they
share the same Supabase project per environment.

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│  Vercel — apps/web          │        │  Trigger.dev — apps/jobs     │
│  Next.js 15 App Router      │  ───▶  │  Background tasks            │
│  (browser + server runtime) │        │  (long-running, scheduled)   │
└──────────────┬──────────────┘        └──────────────┬───────────────┘
               │                                       │
               └───────────────┬───────────────────────┘
                               ▼
                  ┌─────────────────────────┐
                  │  Supabase               │
                  │  Postgres / Auth /      │
                  │  Storage / Realtime     │
                  └─────────────────────────┘
```

Outbound integrations:

- **Groq**, **Anthropic** — LLM completions (mostly from `apps/jobs`).
- **Google Cloud TTS** — speech synthesis (`apps/jobs`).
- **Resend** — transactional + inbound email.

See [env-vars.md](./env-vars.md) for the variable matrix and ownership.

## One-time provisioning

### 1. Supabase

1. Create a project named `reverb` in the production org. Save the project
   ref, anon key, and service role key.
2. Apply migrations and seed:
   ```bash
   pnpm --filter @reverb/db db:push
   ```
3. Enable the Google OAuth provider: **Auth → Providers → Google**. Paste in
   the OAuth client ID and secret (created in Google Cloud Console with the
   Supabase callback URL added to the authorized redirects).
4. (Optional) For preview deploys, use Supabase Branching to spin up a
   short-lived DB per Vercel preview, or share a long-lived `reverb-dev`
   project and point all previews at it.

### 2. Vercel — `apps/web`

1. Import the repo. Set **Root Directory** to `apps/web`. Vercel will
   auto-detect pnpm + Turborepo from the workspace root and read
   [`apps/web/vercel.json`](../apps/web/vercel.json) for the build/install
   commands.
2. Add a custom domain.
3. Configure environment variables for each of the three scopes
   (Production, Preview, Development). Copy the names from
   [env-vars.md](./env-vars.md) — every "Where to set" row that includes
   "Vercel" must be set in **all** scopes.
4. **Critical:** do not assign `SUPABASE_SERVICE_ROLE_KEY` to the
   "Development" scope unless you intend to pull it locally via `vercel env
pull`. If you do pull it, the file must land in a gitignored path.

### 3. Trigger.dev — `apps/jobs`

1. `npx trigger.dev@latest login` (once per machine).
2. Create a Trigger.dev project named `reverb`. Capture the project ref into
   `TRIGGER_PROJECT_ID`.
3. Deploy:
   ```bash
   pnpm --filter @reverb/jobs run deploy
   ```
4. In the Trigger.dev dashboard, set environment variables for the `prod`
   and `staging` environments. Every "Where to set" row in
   [env-vars.md](./env-vars.md) that includes "Trigger.dev" must be set.
5. Wire the Trigger.dev project to the web app:
   - Copy the project's `secret-key` (prod and staging) into Vercel as
     `TRIGGER_SECRET_KEY` for the matching scope.
   - Copy the project ref into Vercel as `TRIGGER_PROJECT_ID`.

### 4. Resend

1. Verify the sending domain.
2. Create an API key, store as `RESEND_API_KEY` in both Vercel and
   Trigger.dev.
3. Configure the inbound route that forwards to `VINCENT_UPLOAD_EMAIL`
   (the address Vincent uses to ingest content uploads).

### 5. Google Cloud TTS

Pick **one** auth path; `getGoogleTtsClient()` will use it (see
[env-vars.md](./env-vars.md) for the precedence order):

- **Service account (preferred for Trigger.dev hosted)** — Create a service
  account with the **Cloud Text-to-Speech User** role, download the JSON key,
  and paste its raw contents into `GOOGLE_APPLICATION_CREDENTIALS_JSON` on
  Trigger.dev. The provider parses and passes the JSON as `credentials`.
- **API key** — Enable Text-to-Speech, create an API key, store as
  `GOOGLE_TTS_API_KEY`. Works on any runtime.
- **Local development only** — save the service-account JSON to disk and set
  `GOOGLE_APPLICATION_CREDENTIALS` to its path. The Google auth library
  picks it up via Application Default Credentials.

## Deploy commands

| Action                | Command                                                  |
| --------------------- | -------------------------------------------------------- |
| Push DB migrations    | `pnpm --filter @reverb/db run db:push`                   |
| Regenerate DB types   | `pnpm --filter @reverb/db run db:types`                  |
| Deploy web            | Push to `main` (Vercel handles it) or `vercel --prod`    |
| Deploy jobs (prod)    | `pnpm --filter @reverb/jobs run deploy`                  |
| Deploy jobs (staging) | `pnpm --filter @reverb/jobs run deploy -- --env staging` |

> `run` is required: in pnpm 10, `deploy` (and a few other names) are reserved
> for built-in commands. `pnpm --filter <pkg> <script>` only resolves the
> package script when the script name is not a pnpm built-in, so always use
> `pnpm --filter <pkg> run <script>` for `deploy` / `publish` / `install`-style
> names.

## First production launch checklist

Work top-to-bottom. Each box is independently verifiable.

### Supabase

- [ ] Production project created; project ref recorded.
- [ ] Migrations applied (`pnpm --filter @reverb/db db:push`).
- [ ] Seed data loaded (if required).
- [ ] RLS enabled on every user-facing table; policies reviewed.
- [ ] Google OAuth provider enabled with prod client ID/secret.
- [ ] Authorized redirect URLs include the production domain.
- [ ] Storage buckets created with intended access policies.
- [ ] Service role key copied to Vercel + Trigger.dev (NOT to any
      `NEXT_PUBLIC_*` slot).
- [ ] Anon key copied to Vercel.

### Vercel (apps/web)

- [ ] Project created; Root Directory = `apps/web`.
- [ ] Production env vars set (see [env-vars.md](./env-vars.md)).
- [ ] Preview env vars set.
- [ ] Custom domain added; DNS verified; HTTPS green.
- [ ] First production deploy succeeds (`vercel --prod` or push to `main`).
- [ ] `/` loads and the Supabase health probe in server logs is green.
- [ ] No `SUPABASE_SERVICE_ROLE_KEY` value appears in the client bundle
      (verify with `next build`'s output and a Network tab spot-check).

### Trigger.dev (apps/jobs)

- [ ] Project created; project ref recorded.
- [ ] `prod` and `staging` environments have the full env set.
- [ ] `pnpm --filter @reverb/jobs run deploy` succeeds.
- [ ] The `hello` example task runs successfully from the dashboard.
- [ ] `TRIGGER_SECRET_KEY` and `TRIGGER_PROJECT_ID` are mirrored into Vercel.

### Email (Resend)

- [ ] Sending domain verified (SPF, DKIM, DMARC).
- [ ] `RESEND_API_KEY` set in Vercel + Trigger.dev.
- [ ] Inbound route forwards to `VINCENT_UPLOAD_EMAIL` and reaches
      `apps/jobs`.

### AI providers

- [ ] `GROQ_API_KEY`, `ANTHROPIC_API_KEY` set in Trigger.dev.
- [ ] Google TTS auth path chosen (API key OR service account JSON) and
      set in Trigger.dev.
- [ ] Rate-limit headroom checked against expected daily volume.

### App config

- [ ] `ALLOWED_EMAILS` populated with the production roster.
- [ ] `VINCENT_UPLOAD_EMAIL` set and confirmed deliverable.
- [ ] `HOUSEHOLD_TIMEZONE` matches the household's IANA zone.

### Observability + rotation

- [ ] Supabase, Vercel, and Trigger.dev log dashboards bookmarked.
- [ ] Secret rotation owners documented in [env-vars.md](./env-vars.md).
- [ ] Backup/restore for Supabase verified (point-in-time recovery on).
