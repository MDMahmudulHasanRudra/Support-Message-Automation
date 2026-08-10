"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import type { Prisma } from "@prisma/client";
import { requireSession } from "@/server/auth";

/** Every action here just inserts a WorkerCommand row — the dashboard never calls the worker directly. */
async function enqueueCommand(type: "RECONNECT" | "RESYNC_GROUPS", payload?: Record<string, unknown>) {
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
