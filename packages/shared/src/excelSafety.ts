/**
 * Formula-injection protection for Excel/CSV exports containing user-controlled data (e.g. a rule
 * name or reply message an admin typed in). No existing export in this repo does this today
 * (confirmed by audit — Support Activity's export route has none) — this is new protection, not a
 * reused pattern, since Automation Rules export is the first export here to carry meaningfully
 * free-form user text (names, descriptions, reply messages) rather than system-generated values.
 *
 * Per OWASP's CSV/formula-injection guidance, a cell whose text begins with one of =+-@ (or a
 * leading tab/carriage return) can be interpreted as a formula by Excel/Sheets when the file is
 * reopened. Prefixing with a single quote forces spreadsheet software to treat it as literal text.
 */

const DANGEROUS_LEADING_CHARS = new Set(["=", "+", "-", "@", "\t", "\r"]);

export function sanitizeExcelCell(value: string): string {
  if (value.length === 0) return value;
  return DANGEROUS_LEADING_CHARS.has(value[0]!) ? `'${value}` : value;
}

/** Applies sanitizeExcelCell to every string value in a flat row object — non-string values
 * (numbers, booleans, null/undefined) pass through untouched. */
export function sanitizeExcelRow<T extends Record<string, unknown>>(row: T): T {
  const sanitized = { ...row } as Record<string, unknown>;
  for (const key of Object.keys(sanitized)) {
    const value = sanitized[key];
    if (typeof value === "string") sanitized[key] = sanitizeExcelCell(value);
  }
  return sanitized as T;
}
