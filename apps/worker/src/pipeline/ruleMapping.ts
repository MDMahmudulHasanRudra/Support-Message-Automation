import type { AutomationRule } from "@prisma/client";
import {
  isRuleActionArray,
  isRuleConditions,
  type RuleAction,
  type RuleConditions,
} from "@support-automation/shared";
import type { EngineRule } from "@support-automation/engine";

/** Converts a DB row's untyped Json columns into the engine's typed shapes, defensively. */
export function toEngineRule(row: AutomationRule): EngineRule {
  const conditions: RuleConditions = isRuleConditions(row.conditions)
    ? (row.conditions as RuleConditions)
    : {};
  const actions: RuleAction[] = isRuleActionArray(row.actions) ? row.actions : [];

  return {
    id: row.id,
    name: row.name,
    type: row.type,
    matchType: row.matchType,
    matchValue: row.matchValue,
    keywords: row.keywords,
    conditions,
    actions,
    priority: row.priority,
  };
}
