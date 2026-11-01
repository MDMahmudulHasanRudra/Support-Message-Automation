import { APPROVAL_REQUIRED_MODULES, removalImpact } from "./projectModules.js";

/**
 * Platform approval for the approval-only modules (MODULE_APPROVALS.md): WHATSAPP_AVATARS,
 * CLIENT_SMART_IMPORT and SOCIAL_STUDIO — every module marked `manualOnly`.
 *
 * Approval is its own record, separate from the plan (what the customer pays for) and from the project's
 * switch (whether it is on). A customer's Main Admin may switch an approved module on or off; only a
 * platform operator approves or revokes. These are the pure rules; `server/moduleApprovals.ts` applies them.
 */

export interface ModuleApprovalRow {
  customerId: string;
  /** Null = every project of the customer, now and later; otherwise that one project. */
  targetProjectId: string | null;
  featureKey: string;
  revokedAt: Date | null;
}

/**
 * The approval-only modules approved for one project. A row of ANOTHER customer never counts, whatever
 * project it names — the owner is compared first, so a row cannot reach across customers.
 */
export function approvedModulesFor(rows: readonly ModuleApprovalRow[], target: { customerId: string | null; projectId: string | null }): string[] {
  if (!target.customerId) return [];
  const keys = new Set<string>();
  for (const row of rows) {
    if (row.revokedAt) continue;
    if (row.customerId !== target.customerId) continue;
    if (row.targetProjectId !== null && row.targetProjectId !== target.projectId) continue;
    if (!APPROVAL_REQUIRED_MODULES.includes(row.featureKey)) continue;
    keys.add(row.featureKey);
  }
  return [...keys].sort();
}

/**
 * What must be switched off in a project when approval changes: every approval-only module that is on and
 * no longer approved, plus every module that would lose a hard dependency with it (removalImpact), so the
 * stored configuration never holds a module without what it needs.
 */
export function modulesToWithdraw(enabled: readonly string[], approved: readonly string[]): string[] {
  const unapproved = enabled.filter((k) => APPROVAL_REQUIRED_MODULES.includes(k) && !approved.includes(k));
  const off = new Set<string>();
  let remaining = [...enabled];
  for (const key of unapproved) {
    if (!remaining.includes(key)) continue;
    off.add(key);
    for (const dependent of removalImpact(remaining, key)) off.add(dependent);
    remaining = remaining.filter((k) => !off.has(k));
  }
  return [...off].sort();
}

export const MODULE_APPROVAL_REASON_MAX = 500;

/** A reason is required for both approving and revoking: the audit trail must say why. */
export function validateApprovalReason(raw: unknown): string | null {
  const reason = String(raw ?? "").trim();
  if (!reason) return "Give a reason — it is kept with the approval.";
  if (reason.length > MODULE_APPROVAL_REASON_MAX) return `Keep the reason under ${MODULE_APPROVAL_REASON_MAX} characters.`;
  return null;
}
