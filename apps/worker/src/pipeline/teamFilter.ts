import { prisma } from "../db.js";
import { createSenderResolver, type SenderResolution } from "@support-automation/shared";
import { countMetric } from "../health/metrics.js";

/**
 * Which ACTIVE roster member sent a message — the live pipeline's reading of the ONE identity rule
 * every report also uses (`createSenderResolver`, packages/shared/src/whatsappIdentity.ts;
 * WHATSAPP_IDENTITY.md).
 *
 * Two identifiers, because WhatsApp has changed what it puts on a message twice now:
 *
 *  1. **`whatsappId`**, compared exactly — WhatsApp migrated group participants to a "LID", a 14-15
 *     digit id that is deliberately *not* the person's phone number, so their real number never
 *     appears on a message they send in a group.
 *  2. **`phoneNumber`, digits-only on both sides** — still correct for members whose messages do
 *     carry their number, and tolerant of every format a person might type.
 *
 * What changed, and why: the WhatsApp id used to win outright, so when it named one colleague and
 * the phone digits named ANOTHER, the message was silently credited to the first. Now that is a
 * CONFLICT and nobody is credited — but the sender is still certainly a colleague, so
 * `isRosterMember` stays true and every safety behaviour that hangs off "this is staff" (no
 * auto-reply, no customer wait, human takeover) is unchanged. A group id is never a colleague: a
 * message whose author WhatsApp did not name falls back to the group's own id.
 *
 * Active members only: a departed colleague is a customer again, and deactivating somebody has to
 * actually stop them suppressing automation. Reports, which describe history, pass everyone.
 *
 * The roster is small (a support team, not a customer list), so loading it per message costs about
 * what a single indexed lookup did, and it needs no second normalized column that could drift.
 */
export interface TeamSenderResolution extends SenderResolution {
  member: { id: string; name: string } | null;
}

/** Conflicts are logged once per sender per process, not once per message. */
const reportedConflicts = new Set<string>();

export async function resolveTeamSender(senderPhone: string, senderJid?: string | null): Promise<TeamSenderResolution> {
  const members = await prisma.internalTeamMember.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, name: true, phoneNumber: true, whatsappId: true },
  });
  const resolution = createSenderResolver(members).resolve(senderPhone, senderJid);
  const member = resolution.memberId ? (members.find((m) => m.id === resolution.memberId) ?? null) : null;

  if (resolution.isRosterMember && !resolution.memberId) {
    countMetric("identityUnattributed");
    const key = `${resolution.status}:${senderJid ?? senderPhone}`;
    if (!reportedConflicts.has(key)) {
      reportedConflicts.add(key);
      console.warn(
        `[identity] ${resolution.status}: sender ${senderJid ?? senderPhone} matches team members ${resolution.candidateIds.join(", ")} — ` +
          "treated as staff, credited to nobody until the roster is corrected (Team Members → Identity check).",
      );
    }
  }
  return { ...resolution, member: member ? { id: member.id, name: member.name } : null };
}

/** The member credited with a message, or null — for a customer AND for an unsettled colleague. */
export async function resolveActiveTeamMember(
  senderId: string,
  senderJid?: string | null,
): Promise<{ id: string; name: string } | null> {
  return (await resolveTeamSender(String(senderId ?? ""), senderJid)).member;
}

/** Whether the sender is a colleague at all — true for a CONFLICT or AMBIGUOUS match as well. */
export async function isActiveTeamMember(senderId: string, senderJid?: string | null): Promise<boolean> {
  return (await resolveTeamSender(String(senderId ?? ""), senderJid)).isRosterMember;
}
