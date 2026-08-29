import { prisma } from "@support-automation/db";
import { matchSupportKeyword } from "@support-automation/engine";
import { normalizePhoneNumber } from "@support-automation/shared";
import { resolveActiveTeamMember } from "../pipeline/teamFilter.js";
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

export interface SupportActivityDetectionResult {
  activityId: string;
  accountId: string;
  groupId: string;
  teamMemberId: string;
  occurredAt: Date;
  /** True only for a KEYWORD_MATCH winner whose matched SupportKeyword.marksCompletion is true —
   *  read off the already-loaded keyword, never a second matching pass. Always false for
   *  REPLY_TO_CUSTOMER/MENTION winners (no keyword is involved in those triggers). Consumed by
   *  apps/worker/src/supportActivity/sessionTracker.ts to decide open-vs-close. */
  marksCompletion: boolean;
}

/**
 * Cheap-filter-first detector for Support Activity Tracking: is-group-message? ->
 * is-sender-a-support-member? -> is-feature-enabled? -> does-a-rule-apply? -> keyword-match? ->
 * create-activity. Entirely a no-op (zero queries beyond the two boolean checks) when the input
 * isn't a group message or the sender isn't a team member, and a no-op after one settings read
 * when the feature is disabled — matching the master prompt's "cheap filtering before any real
 * work" performance requirement. Never throws for "no match" cases; the caller
 * (processIncomingMessage.ts) wraps the call in its own try/catch so an unexpected error here can
 * never break message processing. Returns null whenever no SupportActivity was recorded —
 * including on a redelivered messageId (P2002) — so the caller never runs session tracking twice
 * for the same message.
 */
export async function detectSupportActivity(
  input: SupportActivityDetectionInput,
): Promise<SupportActivityDetectionResult | null> {
  if (!input.groupId) return null;
  if (!input.isFromTeamMember) return null;

  const settings = await getSupportActivitySettings();
  if (!settings.enabled) return null;

  // Same digits-only match the pipeline's own team-member check uses. This was an exact string
  // lookup on phoneNumber, which never matched a real WhatsApp sender — see teamFilter.ts.
  const teamMember = await resolveActiveTeamMember(input.senderPhone);
  if (!teamMember) return null; // defensive; isActiveTeamMember() already implies this row exists

  const candidateRules = await prisma.supportRule.findMany({
    where: {
      isActive: true,
      triggerType: { in: ["KEYWORD_MATCH", "REPLY_TO_CUSTOMER", "MENTION", "ANY_MESSAGE"] },
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
  if (candidateRules.length === 0) return null;

  // ANY_MESSAGE matches everything a team member sends, so evaluating it in creation order would
  // let it shadow a keyword rule that also matched — and only a keyword rule can carry
  // marksCompletion, which is what closes a SupportSession. Adding an "any message" rule would
  // otherwise quietly stop sessions from ever completing. Specific triggers are tried first;
  // ANY_MESSAGE is the fallback, and creation order still decides between equals.
  const TRIGGER_PRECEDENCE: Record<string, number> = {
    KEYWORD_MATCH: 0,
    REPLY_TO_CUSTOMER: 1,
    MENTION: 2,
    ANY_MESSAGE: 3,
  };
  const orderedRules = [...candidateRules].sort(
    (a, b) => (TRIGGER_PRECEDENCE[a.triggerType] ?? 99) - (TRIGGER_PRECEDENCE[b.triggerType] ?? 99),
  );

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
    // Mentions arrive as bare JIDs already split by the provider, but roster numbers are still
    // human-entered — so this comparison needs normalizing on both sides too, or every mention
    // would look like a customer mention.
    const allMembers = await prisma.internalTeamMember.findMany({ select: { phoneNumber: true } });
    const teamDigits = new Set(
      allMembers.map((m) => normalizePhoneNumber(m.phoneNumber)).filter((d): d is string => d !== null),
    );
    mentionsACustomer = mentionedPhones.some((phone) => {
      const digits = normalizePhoneNumber(phone);
      return digits !== null && !teamDigits.has(digits);
    });
    return mentionsACustomer;
  }

  let winner: { ruleId: string; keywordId: string | null; marksCompletion: boolean } | null = null;
  for (const rule of orderedRules) {
    switch (rule.triggerType) {
      case "KEYWORD_MATCH": {
        const hit = rule.keywords.find((rk) =>
          matchSupportKeyword(input.body, {
            value: rk.keyword.value,
            mode: rk.keyword.matchMode,
            caseSensitive: rk.keyword.caseSensitive,
          }),
        );
        if (hit) winner = { ruleId: rule.id, keywordId: hit.keywordId, marksCompletion: hit.keyword.marksCompletion };
        break;
      }
      case "REPLY_TO_CUSTOMER": {
        if (input.quotedMessage && !input.quotedMessage.isFromTeamMember) {
          winner = { ruleId: rule.id, keywordId: null, marksCompletion: false };
        }
        break;
      }
      case "MENTION": {
        if (await mentionsSomeoneOutsideTeam()) {
          winner = { ruleId: rule.id, keywordId: null, marksCompletion: false };
        }
        break;
      }
      case "ANY_MESSAGE": {
        // The team-member, in-scope-group and feature-enabled checks above are the whole
        // condition — reaching this case already means all of them passed.
        winner = { ruleId: rule.id, keywordId: null, marksCompletion: false };
        break;
      }
    }
    if (winner) break;
  }
  if (!winner) return null;

  try {
    const created = await prisma.supportActivity.create({
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
    return {
      activityId: created.id,
      accountId: input.accountId,
      groupId: input.groupId,
      teamMemberId: teamMember.id,
      occurredAt: input.timestampWa,
      marksCompletion: winner.marksCompletion,
    };
  } catch (err: any) {
    if (err?.code !== "P2002") throw err;
    // Already recorded for this message (reprocess/redelivery) — safe idempotent no-op. Return
    // null so the caller never runs session-open/close logic a second time for this message.
    return null;
  }
}
