/** OAuth error codes Microsoft's token endpoint returns that specifically mean "this refresh
 * token can never work again — the user must click through consent again," per
 * learn.microsoft.com/entra/identity-platform/reference-error-codes. Anything else (network
 * blips, `server_error`, `temporarily_unavailable`, a request timeout) is transient and worth
 * retrying on the next scheduled attempt without bothering the customer. */
const REAUTH_REQUIRED_CODES = new Set(["invalid_grant", "interaction_required", "consent_required"]);

/** Thrown by TeamsAuthClient when Microsoft's token endpoint returns an OAuth error — carries the
 * raw `error` code (e.g. `"invalid_grant"`) so callers can classify it via classifyTokenError()
 * instead of pattern-matching the human-readable message string. */
export class TeamsOAuthError extends Error {
  constructor(
    message: string,
    public readonly code: string | undefined,
  ) {
    super(message);
    this.name = "TeamsOAuthError";
  }
}

export type TokenErrorClassification = "REAUTH_REQUIRED" | "TRANSIENT_ERROR";

/**
 * Classifies a token-refresh failure so the caller can pick the right TeamsAccountStatus:
 * REAUTH_REQUIRED (only fix is the customer completing OAuth again) vs. TRANSIENT_ERROR (worth
 * retrying automatically — network issue, Graph API outage, timeout). Pure and independently
 * testable — the actual status write lives in apps/worker/src/teams/tokenRefresh.ts.
 */
export function classifyTokenError(error: unknown): TokenErrorClassification {
  if (error instanceof TeamsOAuthError && error.code && REAUTH_REQUIRED_CODES.has(error.code)) {
    return "REAUTH_REQUIRED";
  }
  return "TRANSIENT_ERROR";
}
