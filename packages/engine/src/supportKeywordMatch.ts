import { containsWholeWord, normalizeText } from "./normalize.js";

export interface SupportKeywordSpec {
  value: string;
  mode: "CONTAINS" | "EXACT";
  caseSensitive: boolean;
}

/**
 * Support Activity Tracking's keyword matcher. Reuses normalizeText/containsWholeWord (zero-width
 * stripping, script-aware whole-word check) rather than forking AutomationRule's matchRuleText —
 * SupportKeyword is a CRUD-independent, cross-rule-reusable shape, not an inline rule field.
 */
export function matchSupportKeyword(body: string, keyword: SupportKeywordSpec): boolean {
  const haystack = keyword.caseSensitive ? body : normalizeText(body);
  const needle = keyword.caseSensitive ? keyword.value : normalizeText(keyword.value);
  if (!needle.trim()) return false;

  return keyword.mode === "EXACT" ? haystack.trim() === needle.trim() : containsWholeWord(haystack, needle);
}
