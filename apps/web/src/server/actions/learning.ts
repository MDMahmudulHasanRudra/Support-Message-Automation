"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";

/**
 * Dashboard "Run AI analysis now" button — mirrors the existing enqueueCommand idempotency
 * pattern in accounts.ts (never queue a second command of the same type while one is already
 * pending/processing). This command is account-agnostic (no accountId set) — see
 * apps/worker/src/commands/commandProcessor.ts's special-case handling for AI_ANALYSIS_BATCH.
 */
export async function triggerAiAnalysisBatch(): Promise<void> {
  await requireSession();

  const existing = await prisma.workerCommand.findFirst({
    where: { type: "AI_ANALYSIS_BATCH", status: { in: ["PENDING", "PROCESSING"] } },
  });
  if (!existing) {
    await prisma.workerCommand.create({ data: { type: "AI_ANALYSIS_BATCH" } });
  }

  revalidatePath("/conversation-learning");
}
