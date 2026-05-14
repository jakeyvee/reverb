import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { readTheme } from "@/lib/theme/cookie";
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
  return (
    <html lang="en" data-theme={theme} suppressHydrationWarning>
      <body className="min-h-dvh bg-background text-foreground antialiased">{children}</body>
    </html>
  );
}
