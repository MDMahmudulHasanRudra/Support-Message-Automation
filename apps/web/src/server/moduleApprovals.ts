import type { Prisma, PrismaClient } from "@prisma/client";
import {
  APPROVAL_REQUIRED_MODULES,
  approvedModulesFor,
  modulesToWithdraw,
  moduleDefinition,
  resolveProjectFeatures,
  typeForSelection,
  type ProjectBaseType,
} from "@support-automation/shared";
import { globalPrisma } from "@/server/db";

/**
 * Platform approval for the approval-only modules (MODULE_APPROVALS.md), applied to the database.
 *
 *   - Who: approving and revoking are the PLATFORM's (`server/platform/actions/moduleApprovals.ts`, an operator
 *     with the password re-entered). Nothing a customer's role grants reaches these functions.
 *   - Where it bites: `applyModuleSelection` refuses to ADD an approval-only module that is not approved, and
 *     re-checks under the same lock inside its transaction, so an approval revoked a moment earlier cannot slip in.
 *   - Revoking switches the module off in every project it no longer covers, in the SAME transaction, through
 *     the project's ordinary module history. Every existing gate (pages, actions, the worker, the app's background
 *     processors) reads that switch, so new work stops there; nothing is deleted.
 *
 * The rows are read with the unscoped client and always filtered by the owning customer: approvals are the
 * platform's records, and the owner is decided from the project row, never from the request.
 */

type Tx = Prisma.TransactionClient;
type Db = PrismaClient | Tx;

/** The customer that owns a project: its own, or the founding customer for the original installation's. */
export async function owningCustomerId(db: Db, customerId: string | null): Promise<string | null> {
  if (customerId) return customerId;
  return (await db.customer.findFirst({ where: { isFounding: true }, select: { id: true } }))?.id ?? null;
}

/** The approval-only modules approved for a project (or, with no project, for the customer's new projects). */
export async function approvedModules(db: Db, owner: string | null, projectId: string | null): Promise<string[]> {
  if (!owner) return [];
  const rows = await db.moduleApproval.findMany({
    where: { customerId: owner, revokedAt: null, OR: [{ targetProjectId: null }, ...(projectId ? [{ targetProjectId: projectId }] : [])] },
    select: { customerId: true, targetProjectId: true, featureKey: true, revokedAt: true },
  });
  return approvedModulesFor(rows, { customerId: owner, projectId });
}

/**
 * Serialises every approval change and every module change of one customer, so "is it approved?" and "switch
 * it on" cannot interleave with a revocation. Held until the transaction ends. Always the FIRST lock a module or
 * approval transaction takes: before the Project row and its ProjectFeature rows, never after.
 */
export async function lockCustomerModules(tx: Tx, owner: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`module-approval:${owner}`}))`;
}

export class ModuleNotApprovedError extends Error {
  readonly keys: string[];
  constructor(keys: string[]) {
    super(`${keys.map((k) => moduleDefinition(k)?.name ?? k).join(", ")} needs approval from the platform before it can be switched on.`);
    this.name = "ModuleNotApprovedError";
    this.keys = keys;
  }
}

/**
 * Inside a module change's transaction: refuse any approval-only module being ADDED without approval. The caller
 * must already hold `lockCustomerModules` for this owner, taken before any project row is touched — the one lock
 * order every module and approval change follows (lock → Project → ProjectFeature).
 */
export async function assertAdditionsApproved(tx: Tx, owner: string | null, projectId: string, added: readonly string[]): Promise<void> {
  const needing = added.filter((k) => APPROVAL_REQUIRED_MODULES.includes(k));
  if (needing.length === 0) return;
  if (!owner) throw new ModuleNotApprovedError(needing);
  const approved = await approvedModules(tx, owner, projectId);
  const missing = needing.filter((k) => !approved.includes(k));
  if (missing.length) throw new ModuleNotApprovedError(missing);
}

const asBase = (value: string | null): ProjectBaseType | null => (value === "DEFAULT" || value === "ECOMMERCE" ? value : null);

/**
 * After approvals changed (inside the same transaction, under the customer lock): switch off, in each of the
 * customer's projects, every approval-only module that is on and no longer approved — plus anything that needs
 * it — recorded as an ordinary module change. Returns what was switched off, per project.
 */
export async function withdrawUnapprovedModules(tx: Tx, owner: string, actor: string, reason: string, onlyProjectId?: string | null): Promise<Array<{ projectId: string; name: string; removed: string[] }>> {
  const founding = await tx.customer.findUnique({ where: { id: owner }, select: { isFounding: true } });
  const projects = await tx.project.findMany({
    where: {
      ...(onlyProjectId ? { id: onlyProjectId } : {}),
      OR: [{ customerId: owner }, ...(founding?.isFounding ? [{ customerId: null }] : [])],
    },
    select: { id: true, name: true, moduleConfigVersion: true, projectBaseType: true, features: { select: { key: true, enabled: true } } },
  });
  const withdrawn: Array<{ projectId: string; name: string; removed: string[] }> = [];
  for (const project of projects) {
    const enabled = resolveProjectFeatures(project.features).filter((f) => f.enabled).map((f) => f.key as string).sort();
    const removed = modulesToWithdraw(enabled, await approvedModules(tx, owner, project.id));
    if (removed.length === 0) continue;
    const after = enabled.filter((k) => !removed.includes(k));
    const { projectType, baseType } = typeForSelection(after, asBase(project.projectBaseType));
    const nextVersion = project.moduleConfigVersion + 1;
    await tx.project.update({ where: { id: project.id }, data: { moduleConfigVersion: nextVersion, projectType, projectBaseType: baseType } });
    for (const key of removed) {
      const featureKey = moduleDefinition(key)?.featureKey;
      if (!featureKey) continue;
      await tx.projectFeature.upsert({
        where: { projectId_key: { projectId: project.id, key: featureKey } },
        update: { enabled: false },
        create: { projectId: project.id, key: featureKey, enabled: false },
      });
    }
    await tx.projectModuleConfigChange.create({
      data: {
        projectId: project.id,
        version: nextVersion,
        projectType,
        projectBaseType: baseType,
        previousModules: enabled,
        modules: after,
        autoAdded: [],
        declined: [],
        reason,
        actorUsername: actor,
      },
    });
    withdrawn.push({ projectId: project.id, name: project.name, removed });
  }
  return withdrawn;
}

export interface ModuleApprovalView {
  id: string;
  featureKey: string;
  moduleName: string;
  targetProjectId: string | null;
  targetProjectName: string | null;
  reason: string;
  approvedAt: Date;
  approvedByUsername: string;
  revokedAt: Date | null;
  revokedByUsername: string | null;
  revokeReason: string | null;
}

/** A customer's approvals, active first, newest first — the platform's audit view. */
export async function listCustomerModuleApprovals(customerId: string): Promise<ModuleApprovalView[]> {
  const rows = await globalPrisma.moduleApproval.findMany({
    where: { customerId },
    orderBy: [{ revokedAt: { sort: "desc", nulls: "first" } }, { approvedAt: "desc" }],
    take: 200,
    include: { targetProject: { select: { name: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    featureKey: r.featureKey,
    moduleName: moduleDefinition(r.featureKey)?.name ?? r.featureKey,
    targetProjectId: r.targetProjectId,
    targetProjectName: r.targetProject?.name ?? null,
    reason: r.reason,
    approvedAt: r.approvedAt,
    approvedByUsername: r.approvedByUsername,
    revokedAt: r.revokedAt,
    revokedByUsername: r.revokedByUsername,
    revokeReason: r.revokeReason,
  }));
}
