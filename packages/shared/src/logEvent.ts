import { redactText } from "./logRedaction.js";

/**
 * One structured log line (P1-07, docs/get-assist-ultimate/20 O3).
 *
 * The default is the line people already read and grep: `[scope] EVENT key=value …`, so INCIDENT_RUNBOOK.md's
 * `grep '\[(watchdog|registry|catch-up|openwa|queue)\]'` keeps working unchanged. `LOG_FORMAT=json` writes one
 * JSON object per line instead, for a log collector, if one is ever chosen (doc 20 O8).
 *
 * Fields are ids, counts, durations and decisions. Two defences stop anything else reaching a log:
 *   - a field whose NAME says it holds a person's data or a secret (REDACTED_KEYS) is written as [redacted],
 *     whatever the caller passed — a backstop, not permission;
 *   - every string value goes through redactText (logRedaction.ts), the same rules as the worker's console.
 * The worker's logPrivacy.test.ts scans `logEvent(` calls like console calls.
 */
export type LogEventLevel = "debug" | "info" | "warn" | "error";
export type LogFieldValue = string | number | boolean | null | undefined;
export type LogFields = Record<string, LogFieldValue>;

const REDACTED_KEYS = /^(body|text|content|message|phone|phonenumber|email|name|jid|chatid|password|secret|token|apikey|api_key|authorization|cookie)$|(phone|email|password|secret|token|apikey|cookie)$/i;

export function isRedactedKey(key: string): boolean {
  return REDACTED_KEYS.test(key);
}

function cleanValue(key: string, value: LogFieldValue): LogFieldValue {
  if (value === undefined || value === null) return value;
  if (isRedactedKey(key)) return "[redacted]";
  if (typeof value === "string") return redactText(value);
  return value;
}

/** `key=value`, quoting a value that holds a space, a quote or an equals sign. */
function textValue(value: Exclude<LogFieldValue, undefined>): string {
  if (value === null) return "null";
  const s = String(value);
  return /[\s"=]/.test(s) || s === "" ? JSON.stringify(s) : s;
}

export function formatLogLine(
  level: LogEventLevel,
  scope: string,
  event: string,
  fields: LogFields = {},
  format: "text" | "json" = "text",
  now: Date = new Date(),
): string {
  const clean = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => [k, cleanValue(k, v)] as const);
  if (format === "json") {
    return JSON.stringify({ ts: now.toISOString(), level, scope, event, ...Object.fromEntries(clean) });
  }
  const pairs = clean.map(([k, v]) => `${k}=${textValue(v as Exclude<LogFieldValue, undefined>)}`).join(" ");
  return `[${scope}] ${event}${pairs ? ` ${pairs}` : ""}`;
}

function currentFormat(): "text" | "json" {
  return typeof process !== "undefined" && process.env?.LOG_FORMAT === "json" ? "json" : "text";
}

/** Writes one line through the console, so the worker's console redaction (O1) applies on top. */
export function logEvent(level: LogEventLevel, scope: string, event: string, fields?: LogFields): void {
  const line = formatLogLine(level, scope, event, fields, currentFormat());
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
