import { resolveReportScope, parseReportScope, type ReportScope } from "@support-automation/shared";
import { activeDisabledFeatures } from "@/server/projectFeatures";
import { hasPermission } from "@/server/permissions";
import type { Session } from "@/server/auth";

/** Unified messaging reports (UNIFIED_REPORTING): off = the Team Report exactly as before. */
export async function isUnifiedReportingEnabled(): Promise<boolean> {
  return !(await activeDisabledFeatures()).has("UNIFIED_REPORTING");
}

/**
 * The scope the page (and the exports) actually apply. Personal and combined need
 * `messages.view` on top of the report's own key; without it, or with the feature off, the
 * request falls back to group (silently when the feature is off).
 */
export async function resolvePageScope(
  params: Record<string, string | undefined>,
  session: Session,
): Promise<{ scope: ReportScope; note: string | null; enabled: boolean; canViewPersonal: boolean }> {
  const enabled = await isUnifiedReportingEnabled();
  const canViewPersonal = enabled ? await hasPermission(session, "messages.view") : false;
  const resolved = resolveReportScope({ requested: parseReportScope(params.scope), featureEnabled: enabled, canViewPersonal });
  return { ...resolved, enabled, canViewPersonal };
}
