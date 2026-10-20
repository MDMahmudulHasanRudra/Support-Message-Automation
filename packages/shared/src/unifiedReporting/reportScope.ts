/** The scope a Team Report is computed for (URL `scope=`). */
export type ReportScope = "group" | "personal" | "combined";
export const REPORT_SCOPES: readonly ReportScope[] = ["group", "personal", "combined"];
export const REPORT_SCOPE_PARAM = "scope";

export const PERSONAL_SCOPE_DENIED_NOTE = "Personal chat reporting needs the View Messages permission.";

/** Anything unrecognised (or absent) is "group": old URLs keep opening exactly what they opened. */
export function parseReportScope(raw: string | null | undefined): ReportScope {
  const value = raw?.trim();
  return (REPORT_SCOPES as readonly string[]).includes(value ?? "") ? (value as ReportScope) : "group";
}

/** The scope actually applied, and why it differs from the requested one. */
export function resolveReportScope(input: {
  requested: ReportScope;
  featureEnabled: boolean;
  canViewPersonal: boolean;
}): { scope: ReportScope; note: string | null } {
  // Silent when the feature is off: the flag-off page must be identical to what it always was.
  if (!input.featureEnabled) return { scope: "group", note: null };
  if (input.requested !== "group" && !input.canViewPersonal) return { scope: "group", note: PERSONAL_SCOPE_DENIED_NOTE };
  return { scope: input.requested, note: null };
}
