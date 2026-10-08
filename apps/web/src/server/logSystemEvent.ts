
import { prisma } from "@/server/db";
import type { LogLevel, Prisma } from "@prisma/client";

/**
 * Who did it, and to what. The web-side counterpart of the worker's own context type.
 *
 * Here it is almost always present, which is the difference between the two: a dashboard action
 * has a logged-in person behind it by definition, while most of what the worker logs is its own
 * background activity with no actor at all.
 */
export interface SystemEventContext {
  actorUserId?: string | null;
  /** What was acted on — "AiKnowledgeItem", "AiProvider". A free string, so recording a new kind
   *  of auditable thing is not a migration. */
  targetType?: string | null;
  targetId?: string | null;
  correlationId?: string | null;
}

/**
 * Web-side counterpart to apps/worker/src/logging/logSystemEvent.ts — same SystemLog table, so
 * /logs shows both.
 *
 * **Do not put customer message bodies or secrets in `metadata`.** This table has no retention
 * policy and is readable by anyone who can open the Logs page.
 */
export async function logSystemEvent(
  level: LogLevel,
  scope: string,
  message: string,
  metadata?: Record<string, unknown>,
  context?: SystemEventContext,
): Promise<void> {
  try {
    await prisma.systemLog.create({
      data: {
        level,
        scope,
        message,
        metadata: metadata as Prisma.InputJsonValue | undefined,
        actorUserId: context?.actorUserId ?? null,
        targetType: context?.targetType ?? null,
        targetId: context?.targetId ?? null,
        correlationId: context?.correlationId ?? null,
      },
    });
  } catch (err) {
    console.error("[logging] failed to persist system log", err);
  }
}
