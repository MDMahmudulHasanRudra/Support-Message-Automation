import { prisma } from "@/server/db";
import { createSenderResolver, normalizePhoneNumber, whatsappIdKey } from "@support-automation/shared";

/**
 * Queues the worker's `IdentityReattribution` (apps/worker teamManagement/reattribution.ts) after a
 * team member's identifiers change: the stored team-member stamp on their messages, the member on
 * Support Activity rows and their Duty History days are brought in line with the roster as it now
 * stands. Every report reads identity at read time already; these three were decided on arrival.
 *
 * `memberIds` is widened to every member any of the identifiers resolves to now, so a message that
 * moves from one person to another leaves the first one's Duty History as well as joining the
 * second's. Never throws: the roster change itself has been saved, and a failed queue write is
 * logged rather than undoing it.
 */
export async function queueReattribution(input: { reason: string; memberIds: string[]; identifiers: Array<string | null | undefined>; userId: string | null }): Promise<void> {
  try {
    const identifiers = [...new Set(input.identifiers.map((v) => String(v ?? "").trim()).filter(Boolean))];
    if (identifiers.length === 0 && input.memberIds.length === 0) return;
    const roster = await prisma.internalTeamMember.findMany({ select: { id: true, phoneNumber: true, whatsappId: true } });
    const resolver = createSenderResolver(roster);
    const memberIds = new Set(input.memberIds);
    for (const identifier of identifiers) for (const id of resolver.resolve(identifier).candidateIds) memberIds.add(id);
    await prisma.identityReattribution.create({
      data: { reason: input.reason.slice(0, 200), identifiers, memberIds: [...memberIds], requestedByUserId: input.userId },
    });
  } catch (err) {
    console.error("[reattribution] could not queue a re-attribution; reports are unaffected, stored stamps stay as they were", err);
  }
}

/** The identifiers a member's messages can carry, in every stored form. */
export function memberIdentifiers(member: { phoneNumber: string; whatsappId: string | null } | null | undefined): string[] {
  if (!member) return [];
  return [member.phoneNumber, normalizePhoneNumber(member.phoneNumber), whatsappIdKey(member.whatsappId)].filter((v): v is string => Boolean(v));
}
