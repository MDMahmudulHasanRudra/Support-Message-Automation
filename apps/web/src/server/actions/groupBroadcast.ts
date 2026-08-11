"use server";

import { revalidatePath } from "next/cache";
import * as XLSX from "xlsx";
import { prisma } from "@support-automation/db";
import type { Prisma } from "@prisma/client";
import {
  MAX_EXCEL_FILE_SIZE_BYTES,
  buildGroupBroadcastIdempotencyKey,
  matchExcelGroups,
  parseExcelRows,
  randomDelayMs,
  validateMessageText,
  type GroupMatchResult,
} from "@support-automation/shared";
import { requireSession } from "@/server/auth";

export interface ExcelPreviewPayload {
  fileErrors: string[];
  results: GroupMatchResult[];
}

/**
 * Step 2 (Excel import) + Step 3 (matching). Parsing/matching itself is
 * pure (packages/shared) — this action's own job is turning the uploaded
 * file into plain rows and loading this account's synchronized groups as
 * match candidates.
 */
export async function previewExcelUpload(formData: FormData): Promise<ExcelPreviewPayload> {
  await requireSession();

  const accountId = String(formData.get("accountId") ?? "").trim();
  if (!accountId) return { fileErrors: ["Select a WhatsApp account first."], results: [] };

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { fileErrors: ["No file was uploaded."], results: [] };
  }
  if (!/\.xlsx$/i.test(file.name)) {
    return { fileErrors: ["Only .xlsx files are supported."], results: [] };
  }
  if (file.size > MAX_EXCEL_FILE_SIZE_BYTES) {
    return {
      fileErrors: [`File is ${Math.ceil(file.size / (1024 * 1024))}MB, exceeding the ${MAX_EXCEL_FILE_SIZE_BYTES / (1024 * 1024)}MB limit.`],
      results: [],
    };
  }

  let rawRows: Array<Record<string, unknown>>;
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return { fileErrors: ["The file has no sheets."], results: [] };
    rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName]!, { defval: "" });
  } catch {
    return { fileErrors: ["The file could not be read — make sure it is a valid .xlsx file."], results: [] };
  }

  const { rows, errors: parseErrors } = parseExcelRows(rawRows);
  if (rows.length === 0) return { fileErrors: parseErrors, results: [] };

  const candidates = await prisma.whatsAppGroup.findMany({
    where: { accountId },
    select: { id: true, name: true },
  });

  return { fileErrors: parseErrors, results: matchExcelGroups(rows, candidates) };
}

export interface BroadcastTargetInput {
  groupId: string;
  groupName: string;
  /** Per-row Excel message override; null/omitted falls back to commonMessage. */
  message?: string | null;
}

export interface CreateBroadcastJobInput {
  accountId: string;
  source: "MANUAL" | "EXCEL" | "MIXED";
  commonMessage: string;
  targets: BroadcastTargetInput[];
  /** Rows that never made it to `targets` (UNMATCHED/AMBIGUOUS/DUPLICATE from the Excel preview) — kept only for the job's audit trail. */
  preQueueSkipReasons?: Array<{ groupName: string; reason: string }>;
}

export interface CreateBroadcastJobResult {
  jobId?: string;
  error?: string;
}

/**
 * Step 7 (confirm) -> Step 8 (queue). Re-derives and re-validates
 * everything server-side — the client's preview payload is a UI
 * convenience, never trusted as-is (per-account group ownership, message
 * length, per-job size cap, and duplicate-send cooldown are all
 * re-checked here against current DB state).
 */
export async function createGroupBroadcastJob(input: CreateBroadcastJobInput): Promise<CreateBroadcastJobResult> {
  const session = await requireSession();

  const account = await prisma.whatsAppAccount.findUnique({ where: { id: input.accountId } });
  if (!account) return { error: "WhatsApp account not found." };

  const commonMessageError = validateMessageText(input.commonMessage);
  if (commonMessageError) return { error: commonMessageError };

  const dedupedTargets = dedupeByGroupId(input.targets);
  if (dedupedTargets.length === 0) return { error: "No target groups selected." };

  const settings = await prisma.groupBroadcastSettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });

  if (dedupedTargets.length > settings.maxPerJob) {
    return {
      error: `This job has ${dedupedTargets.length} groups, exceeding the configured maximum of ${settings.maxPerJob} per job (Settings -> Group Message Sender). Split it into smaller jobs.`,
    };
  }

  // Never trust client-supplied group ids/names as-is — re-verify every target still belongs to this account.
  const groupRows = await prisma.whatsAppGroup.findMany({
    where: { accountId: input.accountId, id: { in: dedupedTargets.map((t) => t.groupId) } },
  });
  const groupById = new Map(groupRows.map((g) => [g.id, g]));

  const cooldownCutoff = new Date(Date.now() - settings.duplicateGroupCooldownMinutes * 60_000);
  const recentlySent = await prisma.outboundMessage.findMany({
    where: {
      actionType: "GROUP_BROADCAST",
      status: "SENT",
      groupId: { in: dedupedTargets.map((t) => t.groupId) },
      sentAt: { gte: cooldownCutoff },
    },
    select: { groupId: true },
  });
  const recentlySentGroupIds = new Set(recentlySent.map((r) => r.groupId));

  const preQueueSkipReasons: Array<{ groupName: string; reason: string }> = [...(input.preQueueSkipReasons ?? [])];
  const toQueue: Array<{ groupId: string; groupName: string; message: string }> = [];

  for (const target of dedupedTargets) {
    const group = groupById.get(target.groupId);
    if (!group) {
      preQueueSkipReasons.push({ groupName: target.groupName, reason: "Group no longer found for this account (it may have been removed or resynced away)." });
      continue;
    }
    if (recentlySentGroupIds.has(target.groupId)) {
      preQueueSkipReasons.push({
        groupName: group.name,
        reason: `Already sent to this group within the last ${settings.duplicateGroupCooldownMinutes} minutes (duplicate-send protection).`,
      });
      continue;
    }
    const finalMessage = (target.message ?? input.commonMessage).trim();
    const messageError = validateMessageText(finalMessage);
    if (messageError) {
      preQueueSkipReasons.push({ groupName: group.name, reason: messageError });
      continue;
    }
    toQueue.push({ groupId: target.groupId, groupName: group.name, message: finalMessage });
  }

  if (toQueue.length === 0) {
    return { error: "Every target group was skipped before queueing (see reasons shown in preview) — nothing to send." };
  }

  const job = await prisma.groupBroadcastJob.create({
    data: {
      accountId: input.accountId,
      createdById: session.userId,
      source: input.source,
      defaultMessage: input.commonMessage,
      totalRequested: dedupedTargets.length,
      queuedCount: toQueue.length,
      preQueueSkipped: preQueueSkipReasons.length,
      preQueueSkipReasons: preQueueSkipReasons as unknown as Prisma.InputJsonValue,
      delayMinMs: settings.delayMinMs,
      delayMaxMs: settings.delayMaxMs,
      maxPerMinute: settings.maxPerMinute,
      maxPerJob: settings.maxPerJob,
      retryMaxAttempts: settings.retryMaxAttempts,
    },
  });

  let cumulativeDelayMs = 0;
  for (const target of toQueue) {
    cumulativeDelayMs += randomDelayMs(settings.delayMinMs, settings.delayMaxMs);
    const whatsappGroupId = groupById.get(target.groupId)!.whatsappGroupId;
    await prisma.outboundMessage.create({
      data: {
        accountId: input.accountId,
        chatId: whatsappGroupId,
        toPhone: whatsappGroupId,
        body: target.message,
        actionType: "GROUP_BROADCAST",
        idempotencyKey: buildGroupBroadcastIdempotencyKey({ broadcastJobId: job.id, groupId: target.groupId }),
        groupId: target.groupId,
        groupNameSnapshot: target.groupName,
        broadcastJobId: job.id,
        createdById: session.userId,
        delayMs: cumulativeDelayMs,
        scheduledAt: new Date(Date.now() + cumulativeDelayMs),
      },
    });
  }

  revalidatePath("/group-message-sender/history");
  return { jobId: job.id };
}

/** Cancels a job's still-PENDING items (an in-flight PROCESSING send is left to finish naturally). */
export async function cancelBroadcastJob(jobId: string): Promise<void> {
  await requireSession();
  await prisma.outboundMessage.updateMany({
    where: { broadcastJobId: jobId, status: "PENDING" },
    data: { status: "CANCELLED", failureReason: "Cancelled by user." },
  });
  await prisma.groupBroadcastJob.updateMany({
    where: { id: jobId, status: { notIn: ["CANCELLED", "STOPPED_KILL_SWITCH", "COMPLETED"] } },
    data: { status: "CANCELLED", cancelledAt: new Date() },
  });
  revalidatePath(`/group-message-sender/jobs/${jobId}`);
  revalidatePath("/group-message-sender/history");
}

/**
 * Retries only FAILED rows of this job, resetting their retry budget — per
 * the requirement, SENT rows are never touched. Refuses to resume a job
 * the user or the kill switch explicitly stopped, since silently reviving a
 * stopped job would defeat the point of stopping it — the dashboard already
 * hides the Retry button in that state, this is the defense-in-depth check.
 * Returns void (rather than a result) so it can be bound directly to a
 * plain `<form action>`, matching every other mutation action in this app.
 */
export async function retryFailedBroadcastMessages(jobId: string): Promise<void> {
  await requireSession();
  const job = await prisma.groupBroadcastJob.findUnique({ where: { id: jobId } });
  if (!job || job.status === "CANCELLED" || job.status === "STOPPED_KILL_SWITCH") {
    return;
  }

  const result = await prisma.outboundMessage.updateMany({
    where: { broadcastJobId: jobId, status: "FAILED" },
    data: { status: "PENDING", attemptCount: 0, failureReason: null, scheduledAt: new Date() },
  });

  if (result.count > 0 && job.status === "COMPLETED") {
    await prisma.groupBroadcastJob.update({ where: { id: jobId }, data: { status: "RUNNING", completedAt: null } });
  }

  revalidatePath(`/group-message-sender/jobs/${jobId}`);
}

function dedupeByGroupId(targets: BroadcastTargetInput[]): BroadcastTargetInput[] {
  const seen = new Map<string, BroadcastTargetInput>();
  for (const target of targets) {
    if (!seen.has(target.groupId)) seen.set(target.groupId, target);
  }
  return [...seen.values()];
}
