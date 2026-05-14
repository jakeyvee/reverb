import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { Sidebar } from "@/components/app-shell/sidebar";
import { BottomNav } from "@/components/app-shell/bottom-nav";
import { TopBar } from "@/components/app-shell/top-bar";
import { getUser } from "@/lib/auth/get-user";
import { getProfile } from "@/lib/auth/get-profile";
import { readTheme } from "@/lib/theme/cookie";
import { readSupabaseEnv } from "@/lib/supabase/env";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const [user, theme] = await Promise.all([getUser(), readTheme()]);

  // When Supabase isn't configured the middleware can't establish a session,
  // so the user lands on /sign-in via the same redirect. Keep this guard so
  // the layout never renders for an anonymous request.
  if (!user && readSupabaseEnv()) redirect("/sign-in");
  if (user && !user.isAllowed) redirect("/access-denied");

  if (user) {
    const profile = await getProfile(user.id);
    if (!profile || !profile.onboardedAt) {
      redirect("/onboarding");
    }
  }

  return (
    <div className="flex min-h-dvh">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          theme={theme}
          userEmail={user?.email ?? null}
          canUpload={user?.isVincent ?? false}
        />
        <main className="flex-1 px-4 pb-24 pt-6 md:px-8 md:pb-10">
          <div className="mx-auto w-full max-w-5xl">{children}</div>
        </main>
        <BottomNav />
      </div>
    </div>
  );
}
