import { prisma } from "@support-automation/db";
import type { LogLevel, Prisma } from "@prisma/client";

/**
 * Who did it, to what, and as part of which request.
 *
 * Optional throughout, and that is the design rather than laziness: most of what this worker logs
 * is its own background activity — a loop tick, a reconnect, a sweep — which genuinely has no
 * actor and no target. Requiring them would mean inventing values for the majority of entries,
 * which is worse than leaving them null.
 *
 * Where they DO apply, they turn the log from "something happened" into an audit trail. "Who
 * verified this knowledge entry, and when" was unanswerable before, even though the entire
 * customer-facing safety gate rests on that approval.
 */
export interface SystemEventContext {
  /** The person who caused this, when a person did. Null for the worker's own activity. */
  actorUserId?: string | null;
  /** What was acted on — "AiKnowledgeItem", "WhatsAppAccount". A free string: the set of auditable
   *  things grows with the product, and an enum would need a migration to record a new one. */
  targetType?: string | null;
  targetId?: string | null;
  /** The pipeline's trace id, so every entry for one incoming message groups together. */
  correlationId?: string | null;
}

/**
 * Persists a structured log entry so the dashboard's System Logs page has real data to show.
 *
 * **Do not put customer message bodies or secrets in `metadata`.** This table has no retention
 * policy and is readable by anyone who can open the Logs page, so it is the wrong place for
 * either. A message id is a reference; the message itself is a copy.
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
    // Logging must never crash the worker; fall back to console only.
    console.error("[logging] failed to persist system log", err);
  }
  console.log(`[${level}] [${scope}] ${message}`);
}
