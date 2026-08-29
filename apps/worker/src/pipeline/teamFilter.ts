import { prisma } from "@support-automation/db";
import { normalizePhoneNumber } from "@support-automation/shared";

/**
 * Resolves the ACTIVE InternalTeamMember behind a message's sender, or null for a customer.
 *
 * Matching is on digits only, on both sides. It used to be an exact string equality against
 * `InternalTeamMember.phoneNumber`, which could not work: WhatsApp delivers a JID
 * ("8801XXXXXXXXX@c.us") while people enter their colleagues as "+8801XXXXXXXXX". Nothing ever
 * matched, so every team member was processed as a customer — no support activity was recorded,
 * human takeover never paused the AI, and the loop-prevention filter that stops the system
 * replying to its own staff never engaged.
 *
 * The roster is small (a support team, not a customer list), so loading the active members and
 * comparing in memory costs about what the old single indexed lookup did, and it tolerates every
 * format a human might type — "+880 170-000 0001" included — without demanding a migration or a
 * second normalized column that could drift from the one people actually edit.
 */
export async function resolveActiveTeamMember(
  phoneNumber: string,
): Promise<{ id: string; name: string } | null> {
  const senderDigits = normalizePhoneNumber(phoneNumber);
  if (!senderDigits) return null;

  const members = await prisma.internalTeamMember.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, name: true, phoneNumber: true },
  });

  const match = members.find((member) => normalizePhoneNumber(member.phoneNumber) === senderDigits);
  return match ? { id: match.id, name: match.name } : null;
}

export async function isActiveTeamMember(phoneNumber: string): Promise<boolean> {
  return (await resolveActiveTeamMember(phoneNumber)) !== null;
}
