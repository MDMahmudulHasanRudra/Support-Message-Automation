"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import type { Prisma } from "@prisma/client";
import { requireSession } from "@/server/auth";

/**
 * Every action here just inserts a WorkerCommand row — the dashboard never calls the worker
 * directly. ENGINEERING_STANDARDS.md §9: a command of the same type that's still PENDING/
 * PROCESSING must not get a duplicate queued behind it (this is exactly how the real incident
 * happened — two stale RECONNECT commands queued back-to-back). Skips silently rather than
 * erroring: the existing command will still run, so there's nothing for the admin to fix.
 */
async function enqueueCommand(type: "RECONNECT" | "RESYNC_GROUPS", payload?: Record<string, unknown>) {
  const existing = await prisma.workerCommand.findFirst({
    where: { type, status: { in: ["PENDING", "PROCESSING"] } },
  });
  if (existing) return;

  await prisma.workerCommand.create({
    data: { type, payload: payload as Prisma.InputJsonValue | undefined },
  });
}

export async function requestReconnect(): Promise<void> {
  await requireSession();
  await enqueueCommand("RECONNECT");
  revalidatePath("/accounts");
}

export async function requestGroupResync(): Promise<void> {
  await requireSession();
  await enqueueCommand("RESYNC_GROUPS");
  revalidatePath("/accounts");
  revalidatePath("/groups");
}
