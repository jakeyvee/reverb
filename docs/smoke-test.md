# MVP smoke test (VOL-124)

Before each deploy — and after any change that touches the daily session, the
lessons archive, or the streak/XP rollup — walk this checklist on a fresh
local stack. It covers the critical MVP loop end-to-end without depending on
a real upload: sign-in → daily session → vocab review → mistake drill →
streak/XP update → lesson archive → transcript view.

The fixture is loaded from
[`packages/db/supabase/seed.sql`](../packages/db/supabase/seed.sql). It
inserts:

- Two whitelisted users (`alice@reverb.local`, `bob@reverb.local`) in one
  household, both with the password `reverb-local`.
- One demo Bahasa traveler lesson tagged `metadata.demo = true`, with a short
  transcript, eight vocab items, and three teacher corrections.
- Per-user `cards` and `correction_drills` for both users, all due now so the
  daily session has work waiting on first load.

The demo lesson is **never picked up by the worker pipeline** — the upload
action only ever inserts fresh UUIDs, and the retry/reprocess actions
short-circuit on `metadata.demo = true` (see
[`apps/web/lib/lessons/demo.ts`](../apps/web/lib/lessons/demo.ts)).

## Prerequisites

Local Supabase stack and the Next.js dev server. Trigger.dev credentials are
optional — the smoke path doesn't touch the worker.

```bash
pnpm install
# In one terminal: start Supabase locally and apply migrations + seed.
pnpm --filter @reverb/db db:reset
# In another terminal: start the web app.
pnpm dev:web
```

`db:reset` runs every migration in `packages/db/supabase/migrations/` then
executes `seed.sql`, so it is the single command that prepares the fixture.
Rerun it whenever you want to wipe streaks/XP and start the smoke path from a
clean slate.

## Checklist

Run the steps below for `alice@reverb.local` first, then repeat for
`bob@reverb.local` (the per-user state — cards, drills, streak — is
independent). Pass criteria are in **bold** at the end of each step.

1. **Sign in.** Open <http://localhost:3000>. Use the email/password form
   with `alice@reverb.local` / `reverb-local`. **You land on the home view
   with a "Start Today's Session" CTA.**

2. **Start the daily session.** Click "Start Today's Session" (or open
   `/session` directly). The orchestrator loads three correction drills
   followed by eight vocab cards. **The first item is a mistake drill, not
   a vocab card** — corrections always queue ahead of vocab review.

3. **Complete the mistake drills.** Mark each correction as pass/fail. The
   queue advances one item at a time. **The XP counter on the session
   chrome increases as you answer.**

4. **Complete the vocab cards.** Grade each card with Again/Hard/Good/Easy.
   **The XP counter keeps climbing and the in-progress item count
   decreases card by card.**

5. **Finalise the session.** When every item is answered, click "Finish".
   **The session summary shows the total XP earned, the cards reviewed
   count (8), and the exercises-attempted count (3).**

6. **Streak/XP rollup.** Navigate to the home view. **The streak widget
   reads "1 day" and the weekly XP heatmap shows today's entry. Reloading
   the page does not double-count.**

7. **Lesson archive.** Open `/lessons`. **The "Demo: Traveler's Bahasa —
   Day 1" lesson appears in the "Your lessons" section with non-zero
   vocab and correction counts (8 vocab, 3 corrections, 0 grammar).**

8. **Transcript view.** Click into the demo lesson. **The detail page
   renders the six seeded transcript segments with teacher/student
   speaker labels, shows a "Demo" badge in the header, and does not
   surface the "Re-run extraction" affordance even for Vincent.**

If every bold item passes, the MVP loop is green.

## Failure modes worth checking

These have bitten us before. Walk them deliberately if anything looks
suspicious:

- **Resume flow.** After step 3, refresh the page. The session should
  resume on the next unanswered item, not restart from position 0.
- **Two-tab race.** Open `/session` in a second tab while one is mid-queue.
  Both tabs should converge on the same session id (one active session per
  UTC day) and answered items should appear answered in both.
- **Demo lesson stays inert.** As Vincent, open the seeded demo lesson and
  confirm there is no Retry or Reprocess button visible.

## Automated coverage

There is no end-to-end harness yet. The deterministic seed plus this
checklist is the contract — until a Playwright run replaces it, treat the
seed file as load-bearing for the smoke path and update both the seed and
this doc together when the MVP loop changes.
