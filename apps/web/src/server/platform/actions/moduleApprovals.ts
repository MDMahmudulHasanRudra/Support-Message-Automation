"use server";

import { revalidatePath } from "next/cache";
import { APPROVAL_REQUIRED_MODULES, moduleDefinition, validateApprovalReason } from "@support-automation/shared";
import { globalPrisma } from "@/server/db";
import { isUniqueViolation } from "@/lib/prismaErrors";
import { confirmOperatorPassword, requireOperatorAction } from "@/server/platform/auth";
import { logPlatformEvent } from "@/server/platform/log";
import { forgetProjectFeatureStates } from "@/server/projectFeatures";
import { lockCustomerModules, owningCustomerId, withdrawUnapprovedModules } from "@/server/moduleApprovals";

/**
 * Platform approval of the approval-only modules (MODULE_APPROVALS.md). Platform operators only — these are
 * Layer 1 actions, reachable only with a platform session on the platform address, and each needs the
 * operator's password re-entered. No customer login, of any role, can call them successfully, so a customer's
 * Main Admin can never approve a module for themselves.
 */

export interface ModuleApprovalState {
  error?: string;
  success?: string;
}

const moduleName = (key: string) => moduleDefinition(key)?.name ?? key;

export async function approveModule(customerId: string, _prev: ModuleApprovalState, form: FormData): Promise<ModuleApprovalState> {
  const access = await requireOperatorAction();
  if ("denied" in access) return { error: access.denied };
  const { operator } = access;

  const featureKey = String(form.get("featureKey") ?? "");
  if (!APPROVAL_REQUIRED_MODULES.includes(featureKey)) return { error: "Choose one of the approval-only modules." };
  const scope = String(form.get("scope") ?? "ALL");
  const reasonError = validateApprovalReason(form.get("reason"));
  if (reasonError) return { error: reasonError };
  const reason = String(form.get("reason")).trim();
  if (!(await confirmOperatorPassword(operator, form.get("operatorPassword")))) return { error: "Your platform password is not correct." };

  const customer = await globalPrisma.customer.findFirst({ where: { id: String(customerId), removedAt: null }, select: { id: true, name: true, isFounding: true } });
  if (!customer) return { error: "That customer no longer exists or has been removed." };

  let targetProjectId: string | null = null;
  let projectName: string | null = null;
  if (scope !== "ALL") {
    const project = await globalPrisma.project.findUnique({ where: { id: scope }, select: { id: true, name: true, customerId: true } });
    // The project must be THIS customer's (the database checks it again with a trigger).
    if (!project || (await owningCustomerId(globalPrisma, project.customerId)) !== customer.id) return { error: "That workspace is not one of this customer's." };
    targetProjectId = project.id;
    projectName = project.name;
  }

  try {
    await globalPrisma.$transaction(async (tx) => {
      await lockCustomerModules(tx, customer.id);
      await tx.moduleApproval.create({
        data: { customerId: customer.id, targetProjectId, featureKey, reason, approvedByOperatorId: operator.operatorId, approvedByUsername: operator.username },
      });
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { error: `${moduleName(featureKey)} is already approved for ${projectName ?? "every workspace of this customer"}.` };
    throw err;
  }
  await logPlatformEvent(
    "WARN",
    `Module approved: ${moduleName(featureKey)} for "${customer.name}"${projectName ? ` (${projectName})` : " (every workspace)"}`,
    { customerId: customer.id, featureKey, targetProjectId, reason, approvedBy: operator.username },
    { type: "Customer", id: customer.id },
  );
  revalidatePath(`/platform/customers/${customer.id}`);
  return {
    success: `${moduleName(featureKey)} approved for ${projectName ?? "every workspace"}. The customer's Main Admin can now switch it on in the Module Builder; nothing was switched on.`,
  };
}

/**
 * Revoking switches the module off, in the same transaction, in every workspace no other approval still
 * covers — recorded in each workspace's module history. Its data is kept; turning it on again needs a new
 * approval and the customer's Main Admin.
 */
export async function revokeModuleApproval(approvalId: string, _prev: ModuleApprovalState, form: FormData): Promise<ModuleApprovalState> {
  const access = await requireOperatorAction();
  if ("denied" in access) return { error: access.denied };
  const { operator } = access;
  const reasonError = validateApprovalReason(form.get("reason"));
  if (reasonError) return { error: reasonError };
  const reason = String(form.get("reason")).trim();
  if (!(await confirmOperatorPassword(operator, form.get("operatorPassword")))) return { error: "Your platform password is not correct." };

  const approval = await globalPrisma.moduleApproval.findUnique({
    where: { id: String(approvalId) },
    select: { id: true, customerId: true, targetProjectId: true, featureKey: true, revokedAt: true, customer: { select: { name: true } } },
  });
  if (!approval) return { error: "That approval no longer exists." };
  if (approval.revokedAt) return { error: "That approval was already revoked." };

  const withdrawn = await globalPrisma.$transaction(async (tx) => {
    await lockCustomerModules(tx, approval.customerId);
    const revoked = await tx.moduleApproval.updateMany({
      where: { id: approval.id, revokedAt: null },
      data: { revokedAt: new Date(), revokedByOperatorId: operator.operatorId, revokedByUsername: operator.username, revokeReason: reason },
    });
    if (revoked.count !== 1) return null;
    return withdrawUnapprovedModules(tx, approval.customerId, `platform:${operator.username}`, `Platform approval of ${moduleName(approval.featureKey)} revoked: ${reason}`, approval.targetProjectId);
  });
  if (withdrawn === null) return { error: "That approval was already revoked." };

  // This process's page gates read the new switches at once; every other process within its few-second cache.
  forgetProjectFeatureStates();
  await logPlatformEvent(
    "WARN",
    `Module approval revoked: ${moduleName(approval.featureKey)} for "${approval.customer.name}"`,
    { customerId: approval.customerId, featureKey: approval.featureKey, targetProjectId: approval.targetProjectId, reason, revokedBy: operator.username, switchedOff: withdrawn },
    { type: "Customer", id: approval.customerId },
  );
  revalidatePath(`/platform/customers/${approval.customerId}`);
  const off = withdrawn.map((w) => `${w.name} (${w.removed.map(moduleName).join(", ")})`);
  return {
    success: off.length
      ? `Revoked. Switched off, data kept: ${off.join("; ")}.`
      : `Revoked. It was not on in any workspace this approval covered${approval.targetProjectId ? "" : " (or another approval still covers it)"}.`,
  };
}
