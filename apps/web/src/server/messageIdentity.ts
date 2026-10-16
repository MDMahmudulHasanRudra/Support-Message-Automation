import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { createSenderResolver, type SenderResolver } from "@support-automation/shared";

/**
 * The web side of WHATSAPP_IDENTITY.md: who sent a message, and which stored rows are one message.
 * Every report and the chat read these two, so a sender is the same person on every screen.
 */

/**
 * ONE logical WhatsApp message in SQL — the same rule as `logicalMessageKey` in packages/shared,
 * pinned to it by `whatsappIdentityReports.integration.test.ts`.
 *
 * `whatsappMessageId` starts with `true_` on the account that sent a message and `false_` on every
 * other of our accounts that received it, and carries the author's id as that account saw it — so
 * `DISTINCT ON (whatsappMessageId)` kept BOTH copies of anything one of our numbers posted in a group
 * another of our numbers is also in: once as the business's reply, once as a customer message that
 * opened a wait nobody could close. WhatsApp's own key id (the third segment) is shared by every
 * copy. An id not in OpenWA's shape is its own key and is never merged with anything.
 *
 * Use with `PREFER_SENDER_COPY_SQL` in the ORDER BY, so the copy kept is the sending account's own
 * (OUTGOING) record rather than another account's echo of it.
 */
export function messageKeySql(alias = "m"): Prisma.Sql {
  const col = `${alias}."whatsappMessageId"`;
  return Prisma.raw(`(CASE WHEN ${col} ~ '^(true|false)_[^_]*@[^_]*_[^_]+' THEN split_part(${col}, '_', 3) ELSE ${col} END)`);
}

/** ORDER BY tiebreak: of two copies of one message, keep the one our sending account stored. */
export function preferSenderCopySql(alias = "m"): Prisma.Sql {
  return Prisma.raw(`(${alias}."direction" = 'OUTGOING') DESC`);
}

/**
 * The project's roster as a sender resolver — every member, deactivated ones included, because a
 * report describes history and a person who has since left still owns what they sent. The live
 * pipeline (apps/worker teamFilter.ts) passes ACTIVE members only; the rule is the same.
 */
export async function loadReportSenderResolver(): Promise<SenderResolver> {
  const members = await prisma.internalTeamMember.findMany({ select: { id: true, phoneNumber: true, whatsappId: true, attributeFrom: true } });
  return createSenderResolver(members);
}
