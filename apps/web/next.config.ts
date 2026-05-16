import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@reverb/ai", "@reverb/db", "@reverb/domain", "@reverb/email", "@reverb/srs"],
  typedRoutes: true,
  // VOL-137: keep the Next.js client router cache warm for ~30s on dynamic
  // routes so a session→home→session round-trip on mobile 4G reuses the
  // already-rendered RSC payload instead of re-fetching it. Static routes
  // (sign-in, access-denied, onboarding gate) hold longer.
  experimental: {
    staleTimes: {
      dynamic: 30,
      static: 180,
    },
  },
  // Workspace packages are authored as Node-ESM and use `.js` extensions in
  // their internal imports (e.g. `export * from "./fsrs.js"`). The webpack
  // production build does not resolve those to the matching `.ts` source by
  // default — we extend its extensionAlias map so a `.js` import falls back
  // to `.ts`/`.tsx` for the transpiled workspace packages. Turbopack (dev
  // mode) already handles this natively.
  webpack(config) {
    config.resolve = config.resolve ?? {};
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".js", ".ts", ".tsx"],
    };
    return config;
  },
  // Same resolution rule for Turbopack so dev and prod stay in sync (and so
  // Next stops warning about the webpack-only config).
  turbopack: {
    resolveExtensions: [".ts", ".tsx", ".js", ".jsx", ".json"],
  },
};

export default nextConfig;
