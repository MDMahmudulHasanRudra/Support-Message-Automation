/**
 * The rules for a new login, shared by every place that creates one — the project portal's App Users
 * page and Main Admin → Users & Permissions — so the two can never accept different passwords or
 * store usernames differently.
 */
export const MIN_PASSWORD_LENGTH = 12;

/** Logins are by username, compared lowercase and trimmed. */
export function normalizeUsername(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}
