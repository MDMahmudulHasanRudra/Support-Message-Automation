import { isResolutionError, prisma, resolveWhatsAppAccount } from "@support-automation/db";
import { matchSupportKeyword } from "@support-automation/engine";
import type { IssueResolutionOutcome, SupportIssue, TeamsIntegrationSettings, TeamsMessage } from "@prisma/client";
import { logSystemEvent } from "../logging/logSystemEvent.js";

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => vars[key] ?? match);
}

/** Resolves the external id of the thread root a given TeamsMessage belongs to — its own
 * externalMessageId if it's a top-level message, or its parent's if it's a reply. Teams channel
 * threads are exactly one level deep (a reply never has its own replies), so no recursion needed. */
async function resolveThreadExternalId(message: TeamsMessage): Promise<string> {
  if (!message.parentMessageId) return message.externalMessageId;
  const parent = await prisma.teamsMessage.findUnique({
    where: { id: message.parentMessageId },
    select: { externalMessageId: true },
  });
  return parent?.externalMessageId ?? message.externalMessageId;
}

function findMatch(
  body: string,
  rules: Array<{ id: string; keywords: Array<{ keyword: { value: string; matchMode: "CONTAINS" | "EXACT"; caseSensitive: boolean; isActive: boolean } }> }>,
): { ruleId: string; keyword: string } | null {
  for (const rule of rules) {
    for (const { keyword } of rule.keywords) {
      if (!keyword.isActive) continue;
      if (matchSupportKeyword(body, { value: keyword.value, mode: keyword.matchMode, caseSensitive: keyword.caseSensitive })) {
        return { ruleId: rule.id, keyword: keyword.value };
      }
    }
  }
  return null;
}

/**
 * Evaluates one newly-synced Teams message against every open SupportIssue linked to its channel
 * (and, if the issue specifies one, its exact thread) — called only for messages graphSync.ts has
 * just inserted for the first time, never re-evaluated on a later tick, since a message's content
 * never changes after being recorded. No-ops entirely when TeamsIntegrationSettings.
 * enableResolutionDetection is off (default true, but still a real kill switch) or no rule matches.
 */
export async function evaluateResolutionForMessage(message: TeamsMessage): Promise<void> {
  const settings = await prisma.teamsIntegrationSettings.upsert({
    where: { id: "global" },
    update: {},
    create: {},
  });
  if (!settings.enableResolutionDetection) return;

  const threadExternalId = await resolveThreadExternalId(message);

  const issues = await prisma.supportIssue.findMany({
    where: {
      teamsChannelId: message.channelId,
      // CLOSED is the only truly terminal state here (an admin explicitly closed it) — RESOLVED
      // issues are still included so a later matching message still gets an audit-trail event
      // (outcome SKIPPED_ALREADY_RESOLVED in recordResolutionEvent below) instead of being
      // silently dropped, per this feature's "never silently fail to notify without a recorded
      // reason" requirement.
      status: { notIn: ["CLOSED"] },
      OR: [{ teamsThreadExternalId: null }, { teamsThreadExternalId: threadExternalId }],
    },
  });
  if (issues.length === 0) return;

  const rules = await prisma.teamsResolutionRule.findMany({
    where: { isActive: true },
    include: { keywords: { include: { keyword: true } } },
  });
  const matched = findMatch(message.body, rules);
  if (!matched) return;

  for (const issue of issues) {
    await recordResolutionEvent(issue, message, matched, settings);
  }
}

async function recordResolutionEvent(
  issue: SupportIssue,
  message: TeamsMessage,
  matched: { ruleId: string; keyword: string },
  settings: TeamsIntegrationSettings,
): Promise<void> {
  // Decide the outcome BEFORE inserting anything — the IssueResolutionEvent row (created exactly
  // once below, guarded by @@unique([issueId, teamsMessageId])) is the single source of truth for
  // both the audit trail and the duplicate-notification guard; a P2002 here means another sync
  // tick already handled this exact (issue, message) pair, so this call is a no-op.
  let outcome: IssueResolutionOutcome;
  let outboundMessageId: string | null = null;

  if (issue.status === "RESOLVED" || issue.status === "CLOSED") {
    outcome = "SKIPPED_ALREADY_RESOLVED";
  } else if (!settings.enableCustomerNotification) {
    outcome = "SKIPPED_NOTIFICATIONS_DISABLED";
  } else if (!issue.clientPhone) {
    outcome = "SKIPPED_NO_PHONE_MAPPING";
  } else {
    const resolution = await resolveWhatsAppAccount("TEAMS_RESOLUTION_NOTIFY");
    if (isResolutionError(resolution)) {
      await logSystemEvent("WARN", "teams", "TEAMS_RESOLUTION_NOTIFY_ACCOUNT_UNAVAILABLE", {
        issueId: issue.id,
        error: resolution.error,
      });
      outcome = "SKIPPED_ACCOUNT_UNAVAILABLE";
    } else {
      const executive = issue.supportExecutiveId
        ? await prisma.internalTeamMember.findUnique({ where: { id: issue.supportExecutiveId }, select: { name: true } })
        : null;
      const body = renderTemplate(settings.notificationTemplate, {
        customerName: issue.clientPhone,
        issueId: issue.id,
        executiveName: executive?.name ?? "our team",
      });

      // Queues into the EXISTING outbound send queue (drained by startOutboundQueueProcessor) —
      // never a second send path. Not routed through pipeline/enqueueOutbound.ts's
      // enqueueOutboundMessage() because that helper is shaped specifically for the incoming-
      // message pipeline (requires a non-null incomingMessageId and applies rule-cooldown checks
      // that don't apply here); this is a direct, equally-idempotent insert into the same table.
      const created = await prisma.outboundMessage.create({
        data: {
          accountId: resolution.accountId,
          chatId: issue.chatId,
          toPhone: issue.clientPhone,
          body,
          relatedMessageId: issue.triggerMessageId,
          ruleId: null,
          actionType: "AUTO_REPLY",
          idempotencyKey: `teams-resolution:${issue.id}:${message.id}`,
          scheduledAt: new Date(),
        },
      });
      outboundMessageId = created.id;
      outcome = "NOTIFIED";
    }
  }

  try {
    await prisma.issueResolutionEvent.create({
      data: {
        issueId: issue.id,
        teamsMessageId: message.id,
        matchedRuleId: matched.ruleId,
        matchedKeyword: matched.keyword,
        outcome,
        outboundMessageId,
      },
    });
  } catch (err: any) {
    if (err?.code === "P2002") return; // already recorded by a concurrent/earlier tick — no-op
    throw err;
  }

  if (outcome === "NOTIFIED") {
    await prisma.supportIssue.update({ where: { id: issue.id }, data: { status: "RESOLVED", resolvedAt: new Date() } });
  } else if (outcome === "SKIPPED_NOTIFICATIONS_DISABLED" || outcome === "SKIPPED_NO_PHONE_MAPPING" || outcome === "SKIPPED_ACCOUNT_UNAVAILABLE") {
    // A real resolution keyword was seen even though the customer couldn't be (or wasn't
    // configured to be) notified — reflect that in the issue's status so an admin sees it needs a
    // manual look, rather than the issue silently sitting at OPEN/IN_PROGRESS forever.
    await prisma.supportIssue.update({ where: { id: issue.id }, data: { status: "RESOLUTION_DETECTED" } });
  }

  await logSystemEvent("INFO", "teams", "TEAMS_RESOLUTION_EVALUATED", { issueId: issue.id, outcome, matchedKeyword: matched.keyword });
}
