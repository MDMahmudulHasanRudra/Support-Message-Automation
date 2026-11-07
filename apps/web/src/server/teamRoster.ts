import { fillRosterFromPattern } from "@support-automation/db";
import { prisma } from "@/server/db";

/**
 * After a weekly pattern changes: dates still exactly as the pattern wrote them are rewritten from the new one.
 * Today and the past stay as they were, and so does anything a person changed, and leave. Callers check permission.
 */
export async function refreshFutureRoster(memberIds: string[]): Promise<void> {
  const settings = await prisma.teamManagementSettings.findFirst({ select: { autoRoster: true } });
  if (settings && !settings.autoRoster) return;
  const tomorrow = new Date(Date.now() + 6 * 3_600_000 + 86_400_000);
  const from = new Date(Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate()));
  await prisma.dutyAssignment.deleteMany({
    where: { teamMemberId: { in: memberIds }, dutyDate: { gte: from }, source: "WEEKLY_SCHEDULE", status: { in: ["DUTY", "OFF", "HOLIDAY"] } },
  });
  await fillRosterFromPattern(prisma);
}
