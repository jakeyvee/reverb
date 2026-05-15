import Link from "next/link";
import type { Route } from "next";
import { BellIcon } from "@/components/ui/icons";
import { countUnreadNotifications } from "@/lib/notifications/load";

const NOTIFICATIONS_HREF = "/notifications" as Route;

// In-app inbox affordance in the top bar. Renders an unread badge so the
// household can tell at a glance that a lesson finished (or failed) without
// needing email/push delivery wired up yet.
export async function NotificationsBell() {
  const unread = await countUnreadNotifications();
  const badge = unread > 0 ? (unread > 9 ? "9+" : String(unread)) : null;

  return (
    <Link
      href={NOTIFICATIONS_HREF}
      aria-label={unread > 0 ? `Notifications (${unread} unread)` : "Notifications"}
      className="relative inline-flex h-9 w-9 items-center justify-center rounded-md border border-border text-foreground-muted transition hover:bg-surface-muted hover:text-foreground"
    >
      <BellIcon width={16} height={16} />
      {badge ? (
        <span
          aria-hidden
          className="absolute -right-1 -top-1 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-none text-accent-foreground"
        >
          {badge}
        </span>
      ) : null}
    </Link>
  );
}
