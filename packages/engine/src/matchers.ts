import { containsWholeWord, normalizeText } from "./normalize.js";
import { safeRegexTest, validateRegexSafety } from "./regexSafety.js";
import type { EngineRule, MatchResult } from "./types.js";

/**
 * Text matching for a rule's trigger. Assumes `normalizedBody` was already
 * produced by `normalizeText` (the pipeline normalizes once per message and
 * reuses it across every rule evaluation).
 */
export function matchRuleText(
  rule: Pick<EngineRule, "matchType" | "matchValue" | "keywords">,
  normalizedBody: string,
): MatchResult {
  switch (rule.matchType) {
    case "ALWAYS":
      return { matched: true, reason: "Match type is ALWAYS." };

    case "EXACT": {
      if (!rule.matchValue) {
        return { matched: false, reason: "EXACT rule has no matchValue configured." };
      }
      const matched = normalizedBody === normalizeText(rule.matchValue);
      return {
        matched,
        reason: matched
          ? `Message exactly equals "${rule.matchValue}".`
          : `Message does not exactly equal "${rule.matchValue}".`,
      };
    }

    case "CONTAINS": {
      if (!rule.matchValue) {
        return { matched: false, reason: "CONTAINS rule has no matchValue configured." };
      }
      const matched = normalizedBody.includes(normalizeText(rule.matchValue));
      return {
        matched,
        reason: matched
          ? `Message contains "${rule.matchValue}".`
          : `Message does not contain "${rule.matchValue}".`,
      };
    }

    case "KEYWORDS": {
      if (!rule.keywords || rule.keywords.length === 0) {
        return { matched: false, reason: "KEYWORDS rule has no keywords configured." };
      }
      const matchedKeyword = rule.keywords.find((k) =>
        containsWholeWord(normalizedBody, normalizeText(k)),
      );
      return {
        matched: Boolean(matchedKeyword),
        reason: matchedKeyword
          ? `Message contains keyword "${matchedKeyword}".`
          : `Message does not contain any of [${rule.keywords.join(", ")}].`,
      };
    }

    case "REGEX": {
      if (!rule.matchValue) {
        return { matched: false, reason: "REGEX rule has no pattern configured." };
      }
      const safety = validateRegexSafety(rule.matchValue);
      if (!safety.safe) {
        return {
          matched: false,
          reason: `Regex rejected as unsafe at evaluation time (${safety.reason}); treated as no-match.`,
        };
      }
      const { matched, timedOut } = safeRegexTest(rule.matchValue, normalizedBody);
      if (timedOut) {
        return {
          matched: false,
          reason: "Regex evaluation exceeded the safety timeout; treated as no-match.",
        };
      }
      return {
        matched,
        reason: matched
          ? `Message matches pattern /${rule.matchValue}/.`
          : `Message does not match pattern /${rule.matchValue}/.`,
      };
    }

    default:
      return { matched: false, reason: `Unknown matchType.` };
  }
}
