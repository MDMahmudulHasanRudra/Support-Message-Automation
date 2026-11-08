import { prisma as platformPrisma } from "@support-automation/db";
import { ORIGINAL_INSTALLATION_FEATURES, projectFeatureDefinition, type ProjectFeatureKey } from "@support-automation/shared";
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
const cache = new Map<string, { at: number; enabled: Map<string, boolean>; customerKey: string }>();

async function projectEntry() {
  const projectId = currentProjectId();
  let entry = cache.get(projectId);
  if (!entry || Date.now() - entry.at >= TTL_MS) {
    const rows = await platformPrisma.projectFeature.findMany({ where: { projectId }, select: { key: true, enabled: true } });
    const project = await platformPrisma.project.findUnique({ where: { id: projectId }, select: { customerId: true, customer: { select: { isFounding: true } } } });
    const customerKey = project?.customerId && !project.customer?.isFounding ? project.customerId : "";
    entry = { at: Date.now(), enabled: new Map(rows.map((row) => [row.key, row.enabled])), customerKey };
    cache.set(projectId, entry);
  }
  return entry;
}

export async function projectHasFeature(key: ProjectFeatureKey): Promise<boolean> {
  const entry = await projectEntry();
  if (entry.customerKey !== "" && ORIGINAL_INSTALLATION_FEATURES.has(key)) return false;
  return entry.enabled.get(key) ?? projectFeatureDefinition(key).defaultEnabled;
}

/** The current project's customer, '' for the original installation: the key per-customer records are stored under. */
export async function projectCustomerKey(): Promise<string> {
  return (await projectEntry()).customerKey;
}

/** Test seam: forget cached feature states. */
export function resetProjectFeatureCacheForTests(): void {
  cache.clear();
}
