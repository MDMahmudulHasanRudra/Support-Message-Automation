import { PLATFORM_LOG_CUSTOMER, prisma as globalPrisma } from "@support-automation/db";
import type { LogLevel, Prisma } from "@prisma/client";

/**
 * The RELQIVO platform's own log entries (SAAS_PLATFORM_PLAN.md §12). Marked as the platform's, so no
 * customer's System Log ever lists them; shown on the platform's Activity page. Never throws.
 */
export async function logPlatformEvent(
  level: LogLevel,
  message: string,
  metadata: Record<string, unknown> = {},
  target?: { type: string; id: string },
): Promise<void> {
  try {
    await globalPrisma.systemLog.create({
      data: {
        level,
        scope: "platform",
        message,
        metadata: metadata as Prisma.InputJsonValue,
        customerId: PLATFORM_LOG_CUSTOMER,
        targetType: target?.type ?? null,
        targetId: target?.id ?? null,
      },
    });
  } catch (err) {
    console.error("[platform] failed to persist a platform log entry", err);
  }
}
