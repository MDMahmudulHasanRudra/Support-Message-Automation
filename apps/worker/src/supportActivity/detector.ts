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
      triggerType: "KEYWORD_MATCH",
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

  let winner: { ruleId: string; keywordId: string } | null = null;
  for (const rule of candidateRules) {
    if (rule.triggerType !== "KEYWORD_MATCH") continue; // only trigger type today; extend here later
    const hit = rule.keywords.find((rk) =>
      matchSupportKeyword(input.body, {
        value: rk.keyword.value,
        mode: rk.keyword.matchMode,
        caseSensitive: rk.keyword.caseSensitive,
      }),
    );
    if (hit) {
      winner = { ruleId: rule.id, keywordId: hit.keywordId };
      break;
    }
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
