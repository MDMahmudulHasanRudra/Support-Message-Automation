import { prisma as platformPrisma } from "@support-automation/db";
import { projectFeatureDefinition, type ProjectFeatureKey } from "@support-automation/shared";
import { currentProjectId } from "./context.js";

/**
 * Project features in the worker (MULTI_PROJECT_PLAN.md §9): whether the CURRENT project is
 * entitled to a module. Checked at exactly the points that already check the module's own setting,
 * and with the same effect — the work quietly does not happen — because a feature is the entitlement
 * and the setting is the choice within it; both must be on.
 *
 * An absent row is the catalogue default (on). Cached for the same 30 seconds as a project's status,
 * so switching a feature off stops its work within half a minute.
 */
const TTL_MS = 30_000;
const cache = new Map<string, { at: number; enabled: Map<string, boolean> }>();

export async function projectHasFeature(key: ProjectFeatureKey): Promise<boolean> {
  const projectId = currentProjectId();
  let entry = cache.get(projectId);
  if (!entry || Date.now() - entry.at >= TTL_MS) {
    const rows = await platformPrisma.projectFeature.findMany({ where: { projectId }, select: { key: true, enabled: true } });
    entry = { at: Date.now(), enabled: new Map(rows.map((row) => [row.key, row.enabled])) };
    cache.set(projectId, entry);
  }
  return entry.enabled.get(key) ?? projectFeatureDefinition(key).defaultEnabled;
}

/** Test seam: forget cached feature states. */
export function resetProjectFeatureCacheForTests(): void {
  cache.clear();
}
