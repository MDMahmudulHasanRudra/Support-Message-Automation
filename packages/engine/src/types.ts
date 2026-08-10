import type {
  ActionType,
  MatchType,
  RuleAction,
  RuleConditions,
  RuleType,
} from "@support-automation/shared";

export interface MessageContext {
  body: string;
  senderPhone: string;
  isFromTeamMember: boolean;
  groupId?: string | null;
  chatId: string;
  timestamp: Date;
}

export interface PreviousMessageContext {
  senderPhone: string;
  isFromTeamMember: boolean;
}

export interface EngineRule {
  id: string;
  name: string;
  type: RuleType;
  matchType: MatchType;
  matchValue?: string | null;
  keywords: string[];
  conditions: RuleConditions;
  actions: RuleAction[];
  priority: number;
}

export interface EvaluationContext {
  message: MessageContext;
  previousMessage?: PreviousMessageContext | null;
  /** Already filtered to ACTIVE rules; the engine sorts by priority itself. */
  rules: EngineRule[];
}

export type FinalDecision =
  | "IGNORE"
  | "AUTO_REPLY"
  | "SUPPORT_REQUIRED"
  | "STOPPED"
  /** A rule matched but its actions were all side-effects (TAG/NOTIFY/FORWARD), no primary decision. */
  | "ACTIONED"
  | "NO_MATCH";

export interface DecisionTraceEntry {
  ruleId: string | null;
  ruleName: string;
  priority: number | null;
  /** Did this rule's conditions + text pattern match the message? */
  matched: boolean;
  /** Were this rule's actions actually executed (false if pre-empted by a higher-priority match)? */
  applied: boolean;
  reason: string;
}

export interface EvaluationResult {
  finalDecision: FinalDecision;
  matchedRule: EngineRule | null;
  actions: RuleAction[];
  trace: DecisionTraceEntry[];
}

export interface MatchResult {
  matched: boolean;
  reason: string;
}

export type { ActionType, MatchType, RuleAction, RuleConditions, RuleType };
