"use server";

import { projectPath } from "@/server/projectPaths";
import { prisma } from "@/server/db";
import { revalidatePath } from "next/cache";

import { checkPermission, requireAccess } from "@/server/authorize";

/**
 * Dashboard "Run AI analysis now" button — mirrors the existing enqueueCommand idempotency
 * pattern in accounts.ts (never queue a second command of the same type while one is already
 * pending/processing). This command is account-agnostic (no accountId set) — see
 * apps/worker/src/commands/commandProcessor.ts's special-case handling for AI_ANALYSIS_BATCH.
 */
export async function triggerAiAnalysisBatch(): Promise<void> {
  await requireAccess("conversation_learning.manage");

  const existing = await prisma.workerCommand.findFirst({
    where: { type: "AI_ANALYSIS_BATCH", status: { in: ["PENDING", "PROCESSING"] } },
  });
  if (!existing) {
    await prisma.workerCommand.create({ data: { type: "AI_ANALYSIS_BATCH" } });
  }

  revalidatePath(await projectPath("/conversation-learning"));
}

export interface LearningSettingsFormState {
  error?: string;
  success?: boolean;
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

/**
 * The Conversation Learning settings form — includes the Phase 6 auto-approval policy fields
 * (autoApprovalEnabled/autoApprovalMinConfidence). Turning autoApprovalEnabled on does not bypass
 * any safety gate by itself: an auto-approved proposal still becomes a real AutomationRule only as
 * DRAFT (see packages/db's approveRuleProposalById()), so a human always makes the final "go live"
 * decision on the Rules page regardless of this setting.
 */
export async function updateLearningSettings(
  _prevState: LearningSettingsFormState,
  formData: FormData,
): Promise<LearningSettingsFormState> {
  const granted = await checkPermission("conversation_learning.manage");
  if ("denied" in granted) return { error: granted.denied };

  const flag = (key: string) => formData.get(key) === "on";
  const int = (key: string, min: number, max: number, fallback: number) =>
    clampInt(Number(formData.get(key)), min, max, fallback);

  await prisma.learningSettings.upsert({
    where: { id: "global" },
    update: {
      conversationLearningEnabled: flag("conversationLearningEnabled"),
      sessionGapMinutes: int("sessionGapMinutes", 1, 1440, 30),
      minOccurrenceForCandidate: int("minOccurrenceForCandidate", 1, 1000, 3),
      minDistinctGroupsForCandidate: int("minDistinctGroupsForCandidate", 1, 1000, 2),
      minDistinctClientsForCandidate: int("minDistinctClientsForCandidate", 1, 1000, 2),
      candidateExpiryDays: int("candidateExpiryDays", 1, 3650, 30),
      autoApprovalEnabled: flag("autoApprovalEnabled"),
      autoApprovalMinConfidence: int("autoApprovalMinConfidence", 0, 100, 97),
      weightFrequency: int("weightFrequency", 0, 1000, 25),
      weightDiversity: int("weightDiversity", 0, 1000, 20),
      weightConsistency: int("weightConsistency", 0, 1000, 20),
      weightResolution: int("weightResolution", 0, 1000, 15),
      weightRecency: int("weightRecency", 0, 1000, 10),
      weightAiConfidence: int("weightAiConfidence", 0, 1000, 10),
      unknownPatternNotificationsEnabled: flag("unknownPatternNotificationsEnabled"),
      unknownPatternCooldownMinutes: int("unknownPatternCooldownMinutes", 1, 10080, 60),
    },
    create: { id: "global" },
  });

  revalidatePath(await projectPath("/conversation-learning/settings"));
  revalidatePath(await projectPath("/conversation-learning"));
  return { success: true };
}
