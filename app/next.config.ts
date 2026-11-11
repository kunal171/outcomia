import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  // Dedicated verification builds can run beside an existing local dev server.
  distDir: process.env.OUTCOMIA_BUILD_DIR ?? ".next",
  experimental: {
    useTypeScriptCli: false,
  },
  reactStrictMode: true,
};

export default nextConfig;
