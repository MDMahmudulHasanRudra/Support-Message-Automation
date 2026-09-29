import { headers } from "next/headers";
import {
  disabledProjectFeatures,
  featureForPath,
  featureForPermissionKey,
  projectFeatureDefinition,
  type ProjectFeatureKey,
} from "@support-automation/shared";
import { platformPrisma } from "@/server/db";
import { PROJECT_PATH_HEADER } from "@/lib/projectPaths";
import { requireActiveProject } from "@/server/projectContext";

/**
 * Project features in the web app (MULTI_PROJECT_PLAN.md §9): which modules the active project is
 * entitled to. Read-only here; a Main Admin changes them from the portal.
 *
 * Cached for a few seconds per project, like access decisions: the layout, the page gate and every
 * action ask, and the answer changes only when a Main Admin flips a switch — which clears this
 * process's cache at once (`forgetProjectFeatureStates`).
 */
const FEATURE_TTL_MS = 5_000;
const cache = new Map<string, { at: number; disabled: Set<ProjectFeatureKey> }>();

export function forgetProjectFeatureStates(): void {
  cache.clear();
}

export async function disabledFeaturesFor(projectId: string): Promise<Set<ProjectFeatureKey>> {
  const cached = cache.get(projectId);
  if (cached && Date.now() - cached.at < FEATURE_TTL_MS) return cached.disabled;
  const rows = await platformPrisma.projectFeature.findMany({ where: { projectId }, select: { key: true, enabled: true } });
  const disabled = disabledProjectFeatures(rows);
  if (cache.size > 1_000) cache.clear();
  cache.set(projectId, { at: Date.now(), disabled });
  return disabled;
}

/** The active project's switched-off features. */
export async function activeDisabledFeatures(): Promise<Set<ProjectFeatureKey>> {
  return disabledFeaturesFor((await requireActiveProject()).id);
}

/** The path inside the project this request is for — the page, or the page a Server Action was posted from. */
async function requestPath(): Promise<string | null> {
  try {
    return (await headers()).get(PROJECT_PATH_HEADER);
  } catch {
    return null;
  }
}

/**
 * The switched-off feature this request would use, or null. Checked two ways, and either refuses:
 *   - the page the request is for (or was posted from) belongs to a disabled feature;
 *   - the permission key being checked belongs only to a disabled feature, or `feature` names one.
 * The second matters because a Server Action can be posted from any page: the page alone is not
 * proof of which feature an action serves.
 */
export async function blockedFeature(options: { key?: string; feature?: ProjectFeatureKey } = {}): Promise<ProjectFeatureKey | null> {
  const disabled = await activeDisabledFeatures();
  if (disabled.size === 0) return null;
  const candidates = [
    featureForPath((await requestPath()) ?? ""),
    options.key ? featureForPermissionKey(options.key) : null,
    options.feature ?? null,
  ];
  return candidates.find((f): f is ProjectFeatureKey => f !== null && disabled.has(f)) ?? null;
}

export function featureUnavailableError(feature: ProjectFeatureKey): string {
  return `${projectFeatureDefinition(feature).label} is not enabled for this project. A Main Admin can turn it on in the Main Admin Portal.`;
}
