import type { NextConfig } from "next";

/**
 * Security headers on every response (P1-14, docs/get-assist-ultimate/21). Kept in this file rather than
 * imported: module resolution inside next.config.ts depends on the Node version's TypeScript support, and
 * a build that cannot resolve an import here fails outright. securityHeaders.test.ts imports this config.
 *
 * Deliberately NOT set:
 * - Cross-Origin-Resource-Policy / -Embedder-Policy: the website chat widget runs on customers' own sites
 *   and loads its images and script from here; either header would break it.
 * - An enforced Content-Security-Policy, yet. It starts as Report-Only (below) so nothing a page needs is
 *   blocked before the reports have been read; routes that serve files keep their own enforced CSP.
 */

/**
 * Report-only for now: browsers report what it WOULD block to /api/csp-report and block nothing.
 * 'unsafe-inline' scripts and styles are allowed because Next's hydration uses inline scripts; removing
 * that needs a per-request nonce, which is a later, separate step. frame-ancestors is not honoured in a
 * report-only policy, which is why X-Frame-Options is sent as well.
 */
export const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "report-uri /api/csp-report",
].join("; ");

export const SECURITY_HEADERS: Array<{ key: string; value: string }> = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Our pages are framed only by our own pages (the invoice preview). The widget is a script, never a frame.
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  // No page uses these (checked 5 Nov 2026); a page that needs one must be listed here first.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()" },
  { key: "Content-Security-Policy-Report-Only", value: CSP_REPORT_ONLY },
];

/**
 * HSTS only on a request that arrived over HTTPS (Caddy sets x-forwarded-proto), so plain-HTTP access by
 * IP or localhost (the recovery path, SAAS_PLATFORM_PLAN.md §8) is never told to upgrade. One day, without
 * includeSubDomains: a mistake must not lock every customer's *.chithii.com address to HTTPS for a year.
 * Raise it once every served address is known to have a certificate.
 */
export const HSTS_HEADER = { key: "Strict-Transport-Security", value: "max-age=86400" };

const nextConfig: NextConfig = {
  serverExternalPackages: ["web-push"],
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
  // Do not announce the framework.
  poweredByHeader: false,
  experimental: {
    // A page opened in the last 30 seconds comes back at once. Anything a person changes clears this
    // straight away (revalidatePath), and live screens keep refreshing themselves. 30 is the shortest Next allows for `static`.
    staleTimes: { dynamic: 30, static: 30 },
    // Default (1MB) is too small for a real Group Message Sender Excel upload.
    serverActions: {
      bodySizeLimit: "8mb",
    },
    // A file sent from WhatsApp Chat (CHAT_FILE_SENDING.md) is up to 16 MB, posted to a route the
    // proxy runs in front of; the proxy's default 10 MB would cut a video short.
    proxyClientMaxBodySize: "17mb",
  },
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      { source: "/:path*", has: [{ type: "header", key: "x-forwarded-proto", value: "https" }], headers: [HSTS_HEADER] },
    ];
  },
};

export default nextConfig;
