import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@reverb/ai", "@reverb/db", "@reverb/domain", "@reverb/srs"],
  typedRoutes: true,
};

export default nextConfig;
