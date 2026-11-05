/**
 * Reading Content-Security-Policy violation reports (api/csp-report, P1-14).
 *
 * Browsers send two shapes: the older `{"csp-report": {...}}` (report-uri) and the Reporting API's array
 * of `{type: "csp-violation", body: {...}}`. Either way only three things are kept:
 * - the directive;
 * - the blocked resource reduced to its origin (or `inline` / `eval` / `data` / `blob`);
 * - the page's path without its query.
 * A full URL can carry a token or an id in its query string, and a script sample can carry page content,
 * so neither is ever logged.
 */

const LOG_EVERY_MS = 10 * 60_000;
const MAX_REMEMBERED = 500;
const lastLogged = new Map<string, number>();

interface RawReport {
  directive: string;
  blocked: string;
  page: string;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readReports(body: string): RawReport[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.flatMap((item): RawReport[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const legacy = record["csp-report"];
    if (legacy && typeof legacy === "object") {
      const r = legacy as Record<string, unknown>;
      return [{ directive: str(r["effective-directive"]) || str(r["violated-directive"]), blocked: str(r["blocked-uri"]), page: str(r["document-uri"]) }];
    }
    if (record.type === "csp-violation" && record.body && typeof record.body === "object") {
      const r = record.body as Record<string, unknown>;
      return [{ directive: str(r.effectiveDirective), blocked: str(r.blockedURL), page: str(r.documentURL) }];
    }
    return [];
  });
}

/** `https://cdn.example.com/x.js?token=1` -> `https://cdn.example.com`; keywords stay keywords. */
export function blockedOrigin(blocked: string): string {
  const value = blocked.trim();
  if (!value) return "unknown";
  if (/^(inline|eval|wasm-eval|trusted-types-policy|trusted-types-sink)$/.test(value)) return value;
  if (/^(data|blob|filesystem|about|chrome-extension|moz-extension|safari-extension):?/i.test(value)) return value.split(":")[0]!.toLowerCase();
  try {
    return new URL(value).origin;
  } catch {
    return "other";
  }
}

/** `/p/acme/clients?x=1` -> `/p/acme/clients`. */
export function pagePath(page: string): string {
  try {
    return new URL(page).pathname.slice(0, 200);
  } catch {
    return "unknown";
  }
}

/**
 * The log lines to write for one request body: one per distinct (directive, blocked origin, path), at most
 * once per 10 minutes each. `now` is a test seam.
 */
export function summariseCspReports(body: string, now: number = Date.now()): string[] {
  const lines: string[] = [];
  for (const report of readReports(body).slice(0, 20)) {
    const directive = report.directive.replace(/[^a-z-]/gi, "").slice(0, 40) || "unknown";
    const key = `${directive}|${blockedOrigin(report.blocked)}|${pagePath(report.page)}`;
    const previous = lastLogged.get(key);
    if (previous !== undefined && now - previous < LOG_EVERY_MS) continue;
    if (lastLogged.size >= MAX_REMEMBERED) lastLogged.delete(lastLogged.keys().next().value!);
    lastLogged.set(key, now);
    const [d, origin, path] = key.split("|");
    lines.push(`[csp] report-only: ${d} would block ${origin} on ${path}`);
  }
  return lines;
}

/** Tests only. */
export function resetCspReportMemory(): void {
  lastLogged.clear();
}
