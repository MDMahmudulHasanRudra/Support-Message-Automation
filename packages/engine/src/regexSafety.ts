import { runInNewContext } from "node:vm";

export interface RegexSafetyResult {
  safe: boolean;
  reason?: string;
}

const MAX_PATTERN_LENGTH = 200;
const MAX_QUANTIFIER_COUNT = 10;

// Catches the classic catastrophic-backtracking shapes: a quantified group
// or character class whose own body is itself quantified, e.g. (a+)+,
// (a*)*, ([a-z]+)*, (\d+)+. This is a heuristic, not a formal proof of
// linear-time behavior — it is deliberately conservative (rejects some safe
// patterns) rather than permissive.
const NESTED_QUANTIFIER_PATTERN =
  /\((?:[^()]*[+*][^()]*)\)[+*]|\[[^\]]*[+*][^\]]*\][+*]{2,}/;

/**
 * Mandatory save-time gate for administrator-authored regex rules (per the
 * locked architecture, section on regex safety): a pattern must pass this
 * check before it can be saved as an ACTIVE rule. Rejects patterns that are
 * too long, too complex, invalid, or shaped like known ReDoS triggers.
 */
export function validateRegexSafety(pattern: string): RegexSafetyResult {
  if (pattern.length === 0) {
    return { safe: false, reason: "Pattern is empty." };
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return {
      safe: false,
      reason: `Pattern exceeds the maximum allowed length of ${MAX_PATTERN_LENGTH} characters.`,
    };
  }

  const quantifierCount = (pattern.match(/[+*{]/g) ?? []).length;
  if (quantifierCount > MAX_QUANTIFIER_COUNT) {
    return {
      safe: false,
      reason: `Pattern has ${quantifierCount} quantifiers, exceeding the limit of ${MAX_QUANTIFIER_COUNT}.`,
    };
  }

  if (NESTED_QUANTIFIER_PATTERN.test(pattern)) {
    return {
      safe: false,
      reason:
        "Pattern contains a nested quantifier shape (e.g. (a+)+) known to cause catastrophic backtracking.",
    };
  }

  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern);
  } catch (err) {
    return {
      safe: false,
      reason: `Pattern is not a valid regular expression: ${(err as Error).message}`,
    };
  }

  return { safe: true };
}

const DEFAULT_MATCH_TIMEOUT_MS = 50;

/**
 * Runtime safety net for the mandatory bounded regex evaluation requirement:
 * even a pattern that slipped past `validateRegexSafety` (or one saved
 * before the validator existed) cannot hang the worker's event loop. Runs
 * the match in an isolated V8 context with a hard wall-clock timeout; a
 * timeout is treated as "no match", never as a thrown error that could
 * crash the pipeline.
 */
export function safeRegexTest(
  pattern: string,
  input: string,
  timeoutMs: number = DEFAULT_MATCH_TIMEOUT_MS,
): { matched: boolean; timedOut: boolean } {
  try {
    const result = runInNewContext(
      "new RegExp(__pattern__, 'u').test(__input__)",
      { __pattern__: pattern, __input__: input },
      { timeout: timeoutMs },
    );
    return { matched: Boolean(result), timedOut: false };
  } catch (err) {
    const message = (err as Error).message ?? "";
    const timedOut = message.includes("Script execution timed out");
    return { matched: false, timedOut };
  }
}
