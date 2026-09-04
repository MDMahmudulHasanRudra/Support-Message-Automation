"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";

/**
 * The Communication Style profile: reading it, approving it, and asking for a rebuild.
 *
 * Approval is the whole point of this module existing as a page rather than a switch. Guidance
 * learned from chat shapes every AI answer, so a person reads it before it applies to anything —
 * the same trust boundary the knowledge base draws, held one notch tighter because style has no
 * per-answer review to fall back on.
 */

function revalidate() {
  revalidatePath("/ai-learning/communication-style");
  revalidatePath("/ai-learning");
}

export async function getCommunicationStyleProfile() {
  await requireSession();
  return prisma.communicationStyleProfile.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });
}

export async function approveCommunicationStyle(): Promise<{ error?: string }> {
  const session = await requireSession();
  const profile = await prisma.communicationStyleProfile.findUnique({ where: { id: "global" } });
  if (!profile?.guidance?.trim()) {
    return { error: "There is nothing to approve yet — build a profile first." };
  }

  await prisma.communicationStyleProfile.update({
    where: { id: "global" },
    data: { humanApproved: true, approvedAt: new Date(), approvedById: session.userId },
  });
  revalidate();
  return {};
}

/**
 * Withdraws approval without deleting the guidance.
 *
 * Kept rather than cleared so the operator can read what was in use while deciding what to change,
 * and can re-approve it if they turned it off by mistake.
 */
export async function unapproveCommunicationStyle(): Promise<void> {
  await requireSession();
  await prisma.communicationStyleProfile.update({
    where: { id: "global" },
    data: { humanApproved: false, approvedAt: null, approvedById: null },
  });
  revalidate();
}

/**
 * Replaces the learned guidance with an operator's own wording.
 *
 * Editing counts as approving — a person who just typed the text has, by definition, read it.
 */
export async function saveCommunicationStyle(formData: FormData): Promise<{ error?: string }> {
  const session = await requireSession();
  const guidance = String(formData.get("guidance") ?? "").trim();
  if (!guidance) return { error: "Write some guidance, or discard the profile instead." };
  if (guidance.length > 4000) return { error: "That is longer than a style note should be — keep it under 4000 characters." };

  await prisma.communicationStyleProfile.update({
    where: { id: "global" },
    data: {
      guidance,
      humanApproved: true,
      approvedAt: new Date(),
      approvedById: session.userId,
      lastError: null,
    },
  });
  revalidate();
  return {};
}

export async function discardCommunicationStyle(): Promise<void> {
  await requireSession();
  await prisma.communicationStyleProfile.update({
    where: { id: "global" },
    data: {
      guidance: null,
      humanApproved: false,
      approvedAt: null,
      approvedById: null,
      messagesAnalyzed: 0,
      // builtThroughAt is deliberately kept: discarding a profile is a judgement about the
      // guidance, not a request to re-read months of history on the next build.
    },
  });
  revalidate();
}

export interface StyleRebuildRequest {
  queued: boolean;
  error?: string;
}

/** Queues an immediate rebuild — the worker does the reading, as with every other worker action. */
export async function requestStyleRebuild(): Promise<StyleRebuildRequest> {
  await requireSession();
  const settings = await prisma.aiSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
  if (!settings.aiEngineEnabled) return { queued: false, error: "Turn the AI engine on first." };
  if (!settings.communicationStyleLearningEnabled) {
    return { queued: false, error: "Turn on “Learn how the team writes” first." };
  }

  const inFlight = await prisma.workerCommand.findFirst({
    where: { type: "BUILD_COMMUNICATION_STYLE", status: { in: ["PENDING", "PROCESSING"] } },
  });
  if (inFlight) return { queued: true };

  await prisma.workerCommand.create({ data: { type: "BUILD_COMMUNICATION_STYLE" } });
  revalidate();
  return { queued: true };
}

export interface StyleRebuildStatus {
  status: "IDLE" | "PENDING" | "DONE" | "FAILED";
  repliesAnalyzed?: number;
  skipped?: string;
  error?: string;
}

/** Polled by the page while a rebuild runs, the same shape the Forge sync uses. */
export async function readStyleRebuildStatus(): Promise<StyleRebuildStatus> {
  await requireSession();
  const command = await prisma.workerCommand.findFirst({
    where: { type: "BUILD_COMMUNICATION_STYLE" },
    orderBy: { createdAt: "desc" },
  });
  if (!command) return { status: "IDLE" };
  if (command.status === "PENDING" || command.status === "PROCESSING") return { status: "PENDING" };
  if (command.status === "FAILED") {
    return { status: "FAILED", error: (command.result as { error?: string } | null)?.error ?? "The rebuild failed." };
  }
  const result = (command.result ?? {}) as { repliesAnalyzed?: number; skipped?: string };
  return { status: "DONE", repliesAnalyzed: result.repliesAnalyzed, skipped: result.skipped };
}
