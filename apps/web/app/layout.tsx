import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { readTheme } from "@/lib/theme/cookie";
import { readSupabaseEnv } from "@/lib/supabase/env";
import "./globals.css";

export const metadata: Metadata = {
  title: "Reverb",
  description: "Spaced-repetition learning with AI-generated cards.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0b0d12" },
    { media: "(prefers-color-scheme: light)", color: "#f7f8fb" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const theme = await readTheme();
  // VOL-137: Warm the TLS handshake to Supabase Storage so vocab/lesson
  // audio plays without the network-on-tap pause on mobile 4G. Only emit the
  // hint when the env var is set so the head stays clean in stub environments.
  const supabase = readSupabaseEnv();
  const supabaseOrigin = supabase ? safeOrigin(supabase.url) : null;
  return (
    <html lang="en" data-theme={theme} suppressHydrationWarning>
      <head>
        {supabaseOrigin ? (
          <>
            <link rel="preconnect" href={supabaseOrigin} crossOrigin="anonymous" />
            <link rel="dns-prefetch" href={supabaseOrigin} />
          </>
        ) : null}
      </head>
      <body className="min-h-dvh bg-background text-foreground antialiased">{children}</body>
    </html>
  );
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
