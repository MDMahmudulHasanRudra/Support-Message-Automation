import { prisma } from "@support-automation/db";
import type { LogLevel, Prisma } from "@prisma/client";

/** Web-side counterpart to apps/worker/src/logging/logSystemEvent.ts — same SystemLog table, so /logs shows both. */
export async function logSystemEvent(
  level: LogLevel,
  scope: string,
  message: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await prisma.systemLog.create({
      data: { level, scope, message, metadata: metadata as Prisma.InputJsonValue | undefined },
    });
  } catch (err) {
    console.error("[logging] failed to persist system log", err);
  }
}
