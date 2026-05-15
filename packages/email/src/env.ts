function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

// Sensible local-dev fallbacks. The deployment checklist (docs/deployment.md)
// requires both `RESEND_FROM` and `APP_URL` to be set in Vercel and
// Trigger.dev, but a missing value in local dev should degrade to an obviously
// fake sender / URL instead of throwing — the worker still records the in-app
// notification, and the email send logs an error without rolling the pipeline
// back (per VOL-125 acceptance criteria).
const FROM_FALLBACK = "Reverb <onboarding@resend.dev>";
const APP_URL_FALLBACK = "http://localhost:3000";

export const emailEnv = {
  resendApiKey: () => required("RESEND_API_KEY", process.env.RESEND_API_KEY),
  resendFrom: () => process.env.RESEND_FROM?.trim() || FROM_FALLBACK,
  appUrl: () => {
    const raw = process.env.APP_URL?.trim();
    if (!raw) return APP_URL_FALLBACK;
    return raw.endsWith("/") ? raw.slice(0, -1) : raw;
  },
};
