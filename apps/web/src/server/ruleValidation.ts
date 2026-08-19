import { validateRegexSafety } from "@support-automation/engine";
import type { RuleAction } from "@support-automation/shared";

/**
 * Plain module (no "use server") — a "use server" file's exports must all be async Server
 * Actions, which this pure validator isn't. Lives here so both createRule/updateRule
 * (apps/web/src/server/actions/rules.ts) and the bulk Excel-import path
 * (apps/web/src/server/actions/rulesBulk.ts) reuse the EXACT same business rules rather than a
 * second, silently-diverging copy — "if Create Rule rejects a value, Excel import must reject it
 * too."
 */

/** Mandatory regex-safety gate: a REGEX rule cannot be saved unless its pattern passes packages/engine's validator. */
function validateIfRegex(matchType: string, matchValue: string | null): string | null {
  if (matchType !== "REGEX") return null;
  if (!matchValue) return "A REGEX rule requires a pattern.";
  const result = validateRegexSafety(matchValue);
  return result.safe ? null : `Regex rejected: ${result.reason}`;
}

export interface RuleBusinessInput {
  name: string;
  matchType: string;
  matchValue: string | null;
  actions: RuleAction[];
  /** True only when the manual form's schedule toggle is on; the Excel-import path doesn't use a
   * toggle — it derives this from whether a time window is present in its parsed conditions. */
  timeWindowEnabled: boolean;
  timeWindowStartHour?: number;
  timeWindowEndHour?: number;
}

/**
 * The single source of truth for every business rule Create/Edit Rule enforces. Order and
 * behavior are unchanged from what createRule/updateRule did inline before this extraction.
 */
export function validateRuleBusinessRules(input: RuleBusinessInput): string | null {
  if (!input.name) return "Rule name is required.";

  const regexError = validateIfRegex(input.matchType, input.matchValue);
  if (regexError) return regexError;

  if (input.timeWindowEnabled && input.timeWindowStartHour === input.timeWindowEndHour) {
    return "Active-from and active-until cannot be the same hour — this would never match. Use Disable instead if you want the rule inactive.";
  }

  if (input.actions.length === 0) return "At least one action is required.";

  return null;
}
