"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";

export async function toggleGroupMonitoring(id: string): Promise<void> {
  await requireSession();
  const group = await prisma.whatsAppGroup.findUniqueOrThrow({ where: { id } });
  await prisma.whatsAppGroup.update({ where: { id }, data: { isMonitored: !group.isMonitored } });
  revalidatePath("/groups");
}
