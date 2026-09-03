import { prisma } from "@support-automation/db";
import { normalizePhoneNumber } from "@support-automation/shared";

/**
 * Resolves the ACTIVE InternalTeamMember behind a message's sender, or null for a customer.
 *
 * Two identifiers are tried, because WhatsApp has changed what it puts on a message twice now:
 *
 *  1. **`whatsappId`** — the sender identifier exactly as WhatsApp delivered it. WhatsApp migrated
 *     group participants to a "LID": a 14-15 digit number that is deliberately *not* the person's
 *     phone number, so their real number never appears on a message sent in a group. Matching on
 *     phone number alone silently stopped working when that landed.
 *  2. **`phoneNumber`, compared digits-only on both sides** — still correct for members whose
 *     messages do carry their number, and tolerant of every format a person might type
 *     ("+880 170-000 0001" included). This replaced an exact string equality that could never
 *     match, because WhatsApp delivers a JID ("8801XXXXXXXXX@c.us") while people enter colleagues
 *     as "+8801XXXXXXXXX".
 *
 * Both failures had the same consequence, which is why this function is worth the care: every
 * colleague gets processed as a customer. No support activity is recorded, human takeover never
 * pauses the AI, and the loop-prevention filter that stops the system replying to its own staff
 * never engages.
 *
 * The roster is small (a support team, not a customer list), so loading the active members and
 * comparing in memory costs about what a single indexed lookup did, and it needs no second
 * normalized column that could drift from the one people actually edit.
 */
export async function resolveActiveTeamMember(
  senderId: string,
): Promise<{ id: string; name: string } | null> {
  const raw = String(senderId ?? "").trim();
  if (!raw) return null;

  const members = await prisma.internalTeamMember.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, name: true, phoneNumber: true, whatsappId: true },
  });

  // Exact first. A LID is an opaque identifier, so it is compared as given rather than normalized
  // — there is no "format" for a person to have typed it in wrongly.
  const byWhatsAppId = members.find((member) => member.whatsappId && member.whatsappId === raw);
  if (byWhatsAppId) return { id: byWhatsAppId.id, name: byWhatsAppId.name };

  const senderDigits = normalizePhoneNumber(raw);
  if (!senderDigits) return null;

  const byPhone = members.find((member) => normalizePhoneNumber(member.phoneNumber) === senderDigits);
  return byPhone ? { id: byPhone.id, name: byPhone.name } : null;
}

export async function isActiveTeamMember(senderId: string): Promise<boolean> {
  return (await resolveActiveTeamMember(senderId)) !== null;
}
