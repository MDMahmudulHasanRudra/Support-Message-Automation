import type { ActionType } from "./enums";

/**
 * Shapes for AutomationRule.conditions / AutomationRule.actions (stored as
 * Prisma Json columns). One rule shape covers every kind of rule (ignore,
 * escalation, auto-reply, last-sender, exception) — `type` on the rule row
 * is metadata, not a structural discriminator.
 */

export interface SenderCondition {
  type: "ANY" | "TEAM_MEMBER" | "CLIENT" | "SPECIFIC_NUMBERS";
  phoneNumbers?: string[];
}

export interface GroupScope {
  type: "ALL" | "SPECIFIC";
  groupIds?: string[];
}

/** Hour bounds are 0-23, server-local time. `days`: 0=Sunday..6=Saturday. */
export interface TimeWindowCondition {
  startHour: number;
  endHour: number;
  days?: number[];
}

export interface RuleConditions {
  /** Sender of the message currently being evaluated. */
  sender?: SenderCondition;
  /** Sender of the previous message in the same chat (last-sender rules). */
  previousSender?: SenderCondition;
  groupScope?: GroupScope;
  timeWindow?: TimeWindowCondition;
}

export interface RuleAction {
  type: ActionType;
  /** TAG */
  tag?: string;
  /** SUPPORT_REQUIRED */
  category?: string;
  /** FORWARD */
  forwardToChatId?: string;
}

export function isRuleConditions(value: unknown): value is RuleConditions {
  return typeof value === "object" && value !== null;
}

export function isRuleActionArray(value: unknown): value is RuleAction[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as RuleAction).type === "string",
    )
  );
}
