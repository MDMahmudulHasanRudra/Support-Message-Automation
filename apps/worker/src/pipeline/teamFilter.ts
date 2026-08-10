import { prisma } from "@support-automation/db";

/** Checks the sender against the internal team member list before anything else runs. */
export async function isActiveTeamMember(phoneNumber: string): Promise<boolean> {
  const member = await prisma.internalTeamMember.findUnique({
    where: { phoneNumber },
    select: { status: true },
  });
  return member?.status === "ACTIVE";
}
