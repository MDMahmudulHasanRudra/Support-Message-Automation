import { prisma } from "@support-automation/db";
import type { SupportActivitySettings } from "@prisma/client";

/** Guarantees the singleton settings row exists, defaulting to disabled (opt-in feature). */
export async function getSupportActivitySettings(): Promise<SupportActivitySettings> {
  return prisma.supportActivitySettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });
}
