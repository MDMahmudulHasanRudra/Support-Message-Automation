"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";

/**
 * Issues are created manually by an admin, not auto-detected from every incoming WhatsApp message
 * — see SupportIssue's own schema doc comment for why. An admin picks the WhatsApp group the
 * customer conversation is happening in, the customer's phone number, and (now or later) the
 * Teams channel/thread a developer is working the issue in.
 */
export async function createSupportIssue(formData: FormData): Promise<void> {
  const session = await requireSession();

  const groupId = String(formData.get("groupId") ?? "");
  const clientPhone = String(formData.get("clientPhone") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim() || null;
  const teamsChannelId = String(formData.get("teamsChannelId") ?? "") || null;
  const teamsThreadExternalId = String(formData.get("teamsThreadExternalId") ?? "").trim() || null;

  if (!groupId) throw new Error("A WhatsApp group is required.");
  if (!clientPhone) throw new Error("The customer's phone number is required.");

  const group = await prisma.whatsAppGroup.findUniqueOrThrow({ where: { id: groupId } });

  const issue = await prisma.supportIssue.create({
    data: {
      accountId: group.accountId,
      groupId: group.id,
      chatId: group.whatsappGroupId,
      clientPhone,
      title,
      teamsChannelId,
      teamsThreadExternalId,
      createdById: session.userId,
      status: teamsChannelId ? "WAITING_DEVELOPER" : "OPEN",
    },
  });

  revalidatePath("/issues");
  redirect(`/issues/${issue.id}`);
}

/** Links (or changes) an existing issue's Teams channel/thread — the "link to Teams" step for an
 * issue that was created before a developer had started a thread yet. */
export async function linkSupportIssueToTeams(id: string, formData: FormData): Promise<void> {
  await requireSession();
  const teamsChannelId = String(formData.get("teamsChannelId") ?? "") || null;
  const teamsThreadExternalId = String(formData.get("teamsThreadExternalId") ?? "").trim() || null;

  const issue = await prisma.supportIssue.findUniqueOrThrow({ where: { id } });
  await prisma.supportIssue.update({
    where: { id },
    data: {
      teamsChannelId,
      teamsThreadExternalId,
      status: teamsChannelId && issue.status === "OPEN" ? "WAITING_DEVELOPER" : issue.status,
    },
  });
  revalidatePath(`/issues/${id}`);
}

/** Manual override — an admin marks an issue resolved directly, without waiting for (or when there
 * was never) a Teams resolution-keyword match. Does NOT send a customer notification itself; use
 * retryIssueNotification for that, so a manual status change never has a surprising side effect. */
export async function markSupportIssueResolved(id: string): Promise<void> {
  await requireSession();
  await prisma.supportIssue.update({ where: { id }, data: { status: "RESOLVED", resolvedAt: new Date() } });
  revalidatePath(`/issues/${id}`);
  revalidatePath("/issues");
}

export async function reopenSupportIssue(id: string): Promise<void> {
  await requireSession();
  await prisma.supportIssue.update({ where: { id }, data: { status: "IN_PROGRESS", resolvedAt: null, closedAt: null } });
  revalidatePath(`/issues/${id}`);
  revalidatePath("/issues");
}

export async function closeSupportIssue(id: string): Promise<void> {
  await requireSession();
  await prisma.supportIssue.update({ where: { id }, data: { status: "CLOSED", closedAt: new Date() } });
  revalidatePath(`/issues/${id}`);
  revalidatePath("/issues");
}

/** "Ignore" a resolution-detection event that shouldn't have notified the customer (e.g. a
 * developer said "resolved" about something unrelated) — purely a record-keeping action, since the
 * notification (if one was already queued/sent) cannot be un-sent. */
export async function ignoreIssueResolutionEvent(eventId: string): Promise<void> {
  await requireSession();
  const event = await prisma.issueResolutionEvent.findUniqueOrThrow({ where: { id: eventId } });
  await prisma.issueResolutionEvent.update({ where: { id: eventId }, data: { outcome: "SKIPPED_MANUALLY_IGNORED" } });
  revalidatePath(`/issues/${event.issueId}`);
}
