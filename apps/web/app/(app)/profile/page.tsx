import { Card, SectionHeader } from "@/components/ui/card";
import { getUser } from "@/lib/auth/get-user";
import { readTheme } from "@/lib/theme/cookie";
import { ThemeToggle } from "@/components/theme/theme-toggle";

export default async function ProfilePage() {
  const [user, theme] = await Promise.all([getUser(), readTheme()]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight md:text-2xl">Profile</h1>
        <p className="mt-1 text-sm text-foreground-muted">Account, partner, and preferences.</p>
      </header>

      <section>
        <SectionHeader title="Account" />
        <Card className="space-y-2">
          <Field label="Email" value={user?.email ?? "—"} />
          <Field label="User ID" value={user?.id ?? "—"} mono />
        </Card>
      </section>

      <section>
        <SectionHeader title="Partner" />
        <Card>
          <p className="text-sm text-foreground-muted">
            Partner pairing arrives with the couple-streaks ticket.
          </p>
        </Card>
      </section>

      <section>
        <SectionHeader title="Appearance" />
        <Card className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">Theme</p>
            <p className="mt-0.5 text-xs text-foreground-subtle">
              Currently {theme}. Light mode persists per browser.
            </p>
          </div>
          <ThemeToggle current={theme} />
        </Card>
      </section>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between">
      <span className="text-xs uppercase tracking-wider text-foreground-subtle">{label}</span>
      <span
        className={`break-all text-sm text-foreground ${mono ? "font-mono text-xs" : ""}`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}
