import type {
  EvaluationContext,
  MatchResult,
  PreviousMessageContext,
  RuleConditions,
} from "./types.js";
import type {
  GroupScope,
  SenderCondition,
  TimeWindowCondition,
} from "@support-automation/shared";

function matchSenderCondition(
  condition: SenderCondition | undefined,
  sender: { phone: string; isFromTeamMember: boolean } | null,
  label: string,
): MatchResult {
  if (!condition) return { matched: true, reason: `No ${label} condition configured.` };
  if (!sender) {
    return {
      matched: false,
      reason: `${label} condition configured but no ${label.toLowerCase()} is available (e.g. no previous message in this chat).`,
    };
  }

  switch (condition.type) {
    case "ANY":
      return { matched: true, reason: `${label}: any sender allowed.` };
    case "TEAM_MEMBER":
      return {
        matched: sender.isFromTeamMember,
        reason: sender.isFromTeamMember
          ? `${label} is an internal team member.`
          : `${label} is not an internal team member.`,
      };
    case "CLIENT":
      return {
        matched: !sender.isFromTeamMember,
        reason: !sender.isFromTeamMember
          ? `${label} is a client (not an internal team member).`
          : `${label} is an internal team member, not a client.`,
      };
    case "SPECIFIC_NUMBERS": {
      const numbers = condition.phoneNumbers ?? [];
      const matched = numbers.includes(sender.phone);
      return {
        matched,
        reason: matched
          ? `${label} phone ${sender.phone} is in the configured list.`
          : `${label} phone ${sender.phone} is not in the configured list.`,
      };
    }
    default:
      return { matched: false, reason: `Unknown ${label} condition type.` };
  }
}

function matchGroupScope(
  scope: GroupScope | undefined,
  groupId: string | null | undefined,
): MatchResult {
  if (!scope || scope.type === "ALL") {
    return { matched: true, reason: "Rule applies to all groups." };
  }
  const groupIds = scope.groupIds ?? [];
  const matched = Boolean(groupId) && groupIds.includes(groupId as string);
  return {
    matched,
    reason: matched
      ? `Group ${groupId} is in the rule's configured group scope.`
      : `Group ${groupId ?? "(none)"} is not in the rule's configured group scope.`,
  };
}

function matchTimeWindow(
  window: TimeWindowCondition | undefined,
  timestamp: Date,
): MatchResult {
  if (!window) return { matched: true, reason: "No time condition configured." };

  const hour = timestamp.getHours();
  const day = timestamp.getDay();

  if (window.days && window.days.length > 0 && !window.days.includes(day)) {
    return {
      matched: false,
      reason: `Message day (${day}) is not in the configured days [${window.days.join(", ")}].`,
    };
  }

  const inWindow =
    window.startHour <= window.endHour
      ? hour >= window.startHour && hour < window.endHour
      : hour >= window.startHour || hour < window.endHour; // overnight window, e.g. 22-6

  return {
    matched: inWindow,
    reason: inWindow
      ? `Message hour (${hour}) is within the configured window [${window.startHour}-${window.endHour}).`
      : `Message hour (${hour}) is outside the configured window [${window.startHour}-${window.endHour}).`,
  };
}

/** Every specified condition must pass (AND). Unspecified conditions pass by default. */
export function matchRuleConditions(
  conditions: RuleConditions,
  context: EvaluationContext,
): MatchResult {
  const checks: MatchResult[] = [
    matchSenderCondition(
      conditions.sender,
      { phone: context.message.senderPhone, isFromTeamMember: context.message.isFromTeamMember },
      "Current sender",
    ),
    matchSenderCondition(
      conditions.previousSender,
      toSenderShape(context.previousMessage),
      "Previous sender",
    ),
    matchGroupScope(conditions.groupScope, context.message.groupId),
    matchTimeWindow(conditions.timeWindow, context.message.timestamp),
  ];

  const failed = checks.find((c) => !c.matched);
  if (failed) return failed;

  return { matched: true, reason: checks.map((c) => c.reason).join(" ") };
}

function toSenderShape(
  previous: PreviousMessageContext | null | undefined,
): { phone: string; isFromTeamMember: boolean } | null {
  if (!previous) return null;
  return { phone: previous.senderPhone, isFromTeamMember: previous.isFromTeamMember };
}
