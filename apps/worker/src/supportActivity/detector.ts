import { prisma } from "@support-automation/db";
import { matchSupportKeyword } from "@support-automation/engine";
import { getSupportActivitySettings } from "./settings.js";

export interface SupportActivityDetectionInput {
  accountId: string;
  /** Already-resolved WhatsAppGroup.id, or null for a non-group chat. */
  groupId: string | null;
  /** Already computed once by isActiveTeamMember() upstream in the pipeline — reused, not recomputed. */
  isFromTeamMember: boolean;
  senderPhone: string;
  messageId: string;
  body: string;
  timestampWa: Date;
  /** The message this one quotes (swipe-to-reply), already resolved to our own Message row by the
   *  pipeline — null if not a reply, or if the quoted message predates tracking. */
  quotedMessage?: { senderPhone: string; isFromTeamMember: boolean } | null;
  /** Digits-only phone numbers @-mentioned in this message. */
  mentionedPhones?: string[];
}

/**
 * Cheap-filter-first detector for Support Activity Tracking: is-group-message? ->
 * is-sender-a-support-member? -> is-feature-enabled? -> does-a-rule-apply? -> keyword-match? ->
 * create-activity. Entirely a no-op (zero queries beyond the two boolean checks) when the input
 * isn't a group message or the sender isn't a team member, and a no-op after one settings read
 * when the feature is disabled — matching the master prompt's "cheap filtering before any real
 * work" performance requirement. Never throws for "no match" cases; the caller
 * (processIncomingMessage.ts) wraps the call in its own try/catch so an unexpected error here can
 * never break message processing.
 */
export async function detectSupportActivity(input: SupportActivityDetectionInput): Promise<void> {
  if (!input.groupId) return;
  if (!input.isFromTeamMember) return;

  const settings = await getSupportActivitySettings();
  if (!settings.enabled) return;

  const teamMember = await prisma.internalTeamMember.findUnique({
    where: { phoneNumber: input.senderPhone },
    select: { id: true },
  });
  if (!teamMember) return; // defensive; isActiveTeamMember() already implies this row exists

  const candidateRules = await prisma.supportRule.findMany({
    where: {
      isActive: true,
      triggerType: { in: ["KEYWORD_MATCH", "REPLY_TO_CUSTOMER", "MENTION"] },
      AND: [
        { OR: [{ appliesToAllGroups: true }, { groups: { some: { groupId: input.groupId } } }] },
        { OR: [{ appliesToAllTeamMembers: true }, { teamMembers: { some: { teamMemberId: teamMember.id } } }] },
      ],
    },
    orderBy: { createdAt: "asc" },
    include: {
      keywords: {
        where: { keyword: { isActive: true } },
        include: { keyword: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (candidateRules.length === 0) return;

  const mentionedPhones = input.mentionedPhones ?? [];
  // Only queried when a MENTION-type candidate rule actually exists and there's something to check
  // — keeps the common case (no MENTION rules configured) free of this extra lookup.
  let mentionsACustomer: boolean | null = null;
  async function mentionsSomeoneOutsideTeam(): Promise<boolean> {
    if (mentionsACustomer !== null) return mentionsACustomer;
    if (mentionedPhones.length === 0) {
      mentionsACustomer = false;
      return mentionsACustomer;
    }
    const mentionedTeamMembers = await prisma.internalTeamMember.findMany({
      where: { phoneNumber: { in: mentionedPhones } },
      select: { phoneNumber: true },
    });
    const teamPhones = new Set(mentionedTeamMembers.map((m) => m.phoneNumber));
    mentionsACustomer = mentionedPhones.some((phone) => !teamPhones.has(phone));
    return mentionsACustomer;
  }

  let winner: { ruleId: string; keywordId: string | null } | null = null;
  for (const rule of candidateRules) {
    switch (rule.triggerType) {
      case "KEYWORD_MATCH": {
        const hit = rule.keywords.find((rk) =>
          matchSupportKeyword(input.body, {
            value: rk.keyword.value,
            mode: rk.keyword.matchMode,
            caseSensitive: rk.keyword.caseSensitive,
          }),
        );
        if (hit) winner = { ruleId: rule.id, keywordId: hit.keywordId };
        break;
      }
      case "REPLY_TO_CUSTOMER": {
        if (input.quotedMessage && !input.quotedMessage.isFromTeamMember) {
          winner = { ruleId: rule.id, keywordId: null };
        }
        break;
      }
      case "MENTION": {
        if (await mentionsSomeoneOutsideTeam()) {
          winner = { ruleId: rule.id, keywordId: null };
        }
        break;
      }
    }
    if (winner) break;
  }
  if (!winner) return;

  try {
    await prisma.supportActivity.create({
      data: {
        accountId: input.accountId,
        groupId: input.groupId,
        teamMemberId: teamMember.id,
        ruleId: winner.ruleId,
        keywordId: winner.keywordId,
        messageId: input.messageId,
        occurredAt: input.timestampWa,
      },
    });
  } catch (err: any) {
    if (err?.code !== "P2002") throw err;
    // Already recorded for this message (reprocess/redelivery) — safe idempotent no-op.
  }
}
