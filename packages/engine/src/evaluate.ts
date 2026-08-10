import { dedupeActions, deriveFinalDecision } from "./actions";
import { matchRuleConditions } from "./conditions";
import { matchRuleText } from "./matchers";
import { normalizeText } from "./normalize";
import type {
  DecisionTraceEntry,
  EngineRule,
  EvaluationContext,
  EvaluationResult,
} from "./types";

/**
 * Evaluates every active rule against a message and returns which one (if
 * any) wins, plus a full explainable trace of every rule considered — the
 * Rule Tester's "rules evaluated / matched rule / ignored rules" view reads
 * directly off this trace.
 *
 * Default system behavior (not itself a rule row): if no admin-configured
 * rule matches and the sender is an active internal team member, the
 * message is ignored. Administrators can override this by creating a
 * specific higher-priority rule (see the TEAM MEMBER SAFETY FILTER spec).
 */
export function evaluate(context: EvaluationContext): EvaluationResult {
  const normalizedBody = normalizeText(context.message.body);

  const sortedRules = [...context.rules].sort((a, b) => b.priority - a.priority);

  const evaluated = sortedRules.map((rule) => {
    const conditionResult = matchRuleConditions(rule.conditions, context);
    const textResult = conditionResult.matched
      ? matchRuleText(rule, normalizedBody)
      : { matched: false, reason: "Skipped text match: conditions did not match." };

    return {
      rule,
      matched: conditionResult.matched && textResult.matched,
      reason: `${conditionResult.reason} ${textResult.reason}`.trim(),
    };
  });

  const winner = evaluated.find((e) => e.matched);

  const trace: DecisionTraceEntry[] = evaluated.map((e) => ({
    ruleId: e.rule.id,
    ruleName: e.rule.name,
    priority: e.rule.priority,
    matched: e.matched,
    applied: winner ? e.rule.id === winner.rule.id : false,
    reason: e.reason,
  }));

  if (winner) {
    const actions = dedupeActions(winner.rule.actions);
    return {
      finalDecision: deriveFinalDecision(actions),
      matchedRule: winner.rule,
      actions,
      trace,
    };
  }

  if (context.message.isFromTeamMember) {
    trace.push({
      ruleId: null,
      ruleName: "system:team-member-filter",
      priority: null,
      matched: true,
      applied: true,
      reason:
        "No active rule matched; sender is an active internal team member, so the default system behavior is to ignore.",
    });
    return {
      finalDecision: "IGNORE",
      matchedRule: null,
      actions: [{ type: "IGNORE" }],
      trace,
    };
  }

  trace.push({
    ruleId: null,
    ruleName: "system:no-match",
    priority: null,
    matched: true,
    applied: true,
    reason: "No active rule matched this message; no automation action applies.",
  });
  return {
    finalDecision: "NO_MATCH",
    matchedRule: null,
    actions: [],
    trace,
  };
}

export type { EngineRule };
