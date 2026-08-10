import { prisma } from "@support-automation/db";
import type { LogLevel, Prisma } from "@prisma/client";

/** Persists a structured log entry so the dashboard's System Logs page has real data to show. */
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
    // Logging must never crash the worker; fall back to console only.
    console.error("[logging] failed to persist system log", err);
  }
  console.log(`[${level}] [${scope}] ${message}`);
}
