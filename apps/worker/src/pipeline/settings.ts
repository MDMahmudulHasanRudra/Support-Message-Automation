import { prisma } from "@support-automation/db";
import type { AutomationSettings } from "@prisma/client";

/** Guarantees the singleton settings row exists, defaulting to the safe configuration. */
export async function getAutomationSettings(): Promise<AutomationSettings> {
  return prisma.automationSettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });
}
