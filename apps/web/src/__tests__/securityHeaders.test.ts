import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

/**
 * P1-14: every response carries the security headers, from next.config.ts (docs/get-assist-ultimate/21).
 * Read from the real config, so a header removed or loosened there fails here. Pure.
 */

type Rule = { source: string; has?: Array<{ type: string; key: string; value?: string }>; headers: Array<{ key: string; value: string }> };

async function rules(): Promise<Rule[]> {
  expect(nextConfig.headers, "next.config.ts must define headers()").toBeTypeOf("function");
  return (await nextConfig.headers!()) as Rule[];
}

async function headersForEveryRoute(): Promise<Map<string, string>> {
  const all = (await rules()).filter((r) => r.source === "/:path*" && !r.has);
  return new Map(all.flatMap((r) => r.headers.map((h) => [h.key.toLowerCase(), h.value] as const)));
}

describe("security headers on every route", () => {
  it("sends nosniff, a referrer policy, same-origin framing and a restrictive permissions policy", async () => {
    const h = await headersForEveryRoute();
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(h.get("x-frame-options")).toBe("SAMEORIGIN");
    for (const feature of ["camera=()", "microphone=()", "geolocation=()"]) expect(h.get("permissions-policy")).toContain(feature);
  });

  it("sends a report-only CSP that reports to /api/csp-report and would forbid plugins, foreign bases and framing", async () => {
    const csp = (await headersForEveryRoute()).get("content-security-policy-report-only") ?? "";
    for (const directive of ["default-src 'self'", "object-src 'none'", "base-uri 'self'", "frame-ancestors 'self'", "form-action 'self'", "report-uri /api/csp-report"]) {
      expect(csp).toContain(directive);
    }
  });

  it("does not enforce a CSP globally yet, and never sets headers that would break the website chat widget", async () => {
    const h = await headersForEveryRoute();
    // Routes that serve files set their own enforced CSP; a global one would intersect with it.
    expect(h.has("content-security-policy")).toBe(false);
    // The widget loads its script and images from here on customers' own sites.
    expect(h.has("cross-origin-resource-policy")).toBe(false);
    expect(h.has("cross-origin-embedder-policy")).toBe(false);
  });

  it("sends HSTS only on HTTPS, briefly and without subdomains", async () => {
    const hsts = (await rules()).find((r) => r.headers.some((h) => h.key === "Strict-Transport-Security"));
    expect(hsts?.has).toEqual([{ type: "header", key: "x-forwarded-proto", value: "https" }]);
    const value = hsts!.headers.find((h) => h.key === "Strict-Transport-Security")!.value;
    expect(value).not.toMatch(/includeSubDomains|preload/i);
    expect(Number(value.match(/max-age=(\d+)/)?.[1])).toBeLessThanOrEqual(86400);
  });

  it("does not announce the framework", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});
