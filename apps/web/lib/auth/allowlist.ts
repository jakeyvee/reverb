function normalize(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

export function getAllowedEmails(): string[] {
  const raw = process.env.ALLOWED_EMAILS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => normalize(value))
    .filter((value): value is string => value !== null);
}

export function isAllowedEmail(email: string | null | undefined): boolean {
  const target = normalize(email);
  if (!target) return false;
  const allowed = getAllowedEmails();
  // Empty allowlist is a misconfiguration — fail closed so non-whitelisted
  // accounts can never reach app routes when the env var is missing.
  if (allowed.length === 0) return false;
  return allowed.includes(target);
}

export function getVincentEmail(): string | null {
  return normalize(process.env.VINCENT_UPLOAD_EMAIL);
}

export function isVincentEmail(email: string | null | undefined): boolean {
  const vincent = getVincentEmail();
  const target = normalize(email);
  if (!vincent || !target) return false;
  return vincent === target;
}
