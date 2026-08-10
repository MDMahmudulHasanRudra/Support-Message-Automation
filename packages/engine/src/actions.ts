import type { FinalDecision, RuleAction } from "./types";

/**
 * Removes exact duplicate action entries from a rule's action list. Distinct
 * entries of the same type (e.g. two different TAG values) are preserved —
 * only byte-identical duplicates are collapsed. This is a rule-authoring
 * safety net ("the system must prevent the same action from being executed
 * multiple times for the same message"), not the idempotency layer itself
 * (that lives in the outbound queue, Phase 6).
 */
export function dedupeActions(actions: RuleAction[]): RuleAction[] {
  const seen = new Set<string>();
  const result: RuleAction[] = [];
  for (const action of actions) {
    const key = JSON.stringify(action);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(action);
  }
  return result;
}

/**
 * Picks one headline decision for display/logging out of a rule's (possibly
 * multi-action) action list, in order of operational precedence.
 */
export function deriveFinalDecision(actions: RuleAction[]): FinalDecision {
  const types = new Set(actions.map((a) => a.type));
  if (types.has("STOP_PROCESSING")) return "STOPPED";
  if (types.has("SUPPORT_REQUIRED")) return "SUPPORT_REQUIRED";
  if (types.has("AUTO_REPLY")) return "AUTO_REPLY";
  if (types.has("IGNORE")) return "IGNORE";
  return actions.length > 0 ? "ACTIONED" : "NO_MATCH";
}
