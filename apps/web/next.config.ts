import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lean, self-contained server bundle for the Docker runtime image
  // (see apps/web/Dockerfile) — avoids shipping the full node_modules tree.
  output: "standalone",
  // Workspace packages resolve through node_modules via pnpm symlinks and
  // ship TypeScript source directly (no prebuild step) — Next only
  // transpiles app code by default, so these need to be listed explicitly.
  transpilePackages: [
    "@support-automation/db",
    "@support-automation/engine",
    "@support-automation/shared",
    "@support-automation/forge-client",
    "@support-automation/media-storage",
  ],
  experimental: {
    // Default (1MB) is too small for a real Group Message Sender Excel upload.
    serverActions: {
      bodySizeLimit: "8mb",
    },
    // A file sent from WhatsApp Chat (CHAT_FILE_SENDING.md) is up to 16 MB, posted to a route the
    // proxy runs in front of; the proxy's default 10 MB would cut a video short.
    proxyClientMaxBodySize: "17mb",
  },
};

export default nextConfig;
