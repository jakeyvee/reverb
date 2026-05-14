import Link from "next/link";
import type { Theme } from "@/lib/theme/cookie";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { UploadIcon } from "@/components/ui/icons";

type Props = {
  theme: Theme;
  userEmail: string | null;
};

export function TopBar({ theme, userEmail }: Props) {
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-background/85 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/65 md:px-6">
      <Link href="/" className="text-sm font-semibold tracking-tight md:hidden">
        Reverb
      </Link>
      <div className="ml-auto flex items-center gap-2">
        <Link
          href="/upload"
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium text-foreground-muted transition hover:bg-surface-muted hover:text-foreground"
        >
          <UploadIcon width={14} height={14} />
          <span className="hidden sm:inline">Upload</span>
        </Link>
        <ThemeToggle current={theme} />
        {userEmail ? (
          <span
            title={userEmail}
            className="hidden max-w-[10rem] truncate text-xs text-foreground-subtle md:inline"
          >
            {userEmail}
          </span>
        ) : null}
      </div>
    </header>
  );
}
