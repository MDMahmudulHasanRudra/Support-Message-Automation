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

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 40;
export const USERNAME_RULE_TEXT = `${USERNAME_MIN_LENGTH}–${USERNAME_MAX_LENGTH} characters: lowercase letters, numbers, dots, dashes and underscores, starting with a letter or number.`;

/**
 * The shape a username someone CHOOSES must have (My account → Change username). Existing usernames
 * created before this rule keep working; only a new choice is checked.
 */
export function validateUsername(username: string): string | null {
  if (username.length < USERNAME_MIN_LENGTH || username.length > USERNAME_MAX_LENGTH) return `A username is ${USERNAME_RULE_TEXT}`;
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(username)) return `A username is ${USERNAME_RULE_TEXT}`;
  return null;
}

/** A new password: long enough, not the username, and confirmed. Returns the reason, or null. */
export function validateNewPassword(password: string, confirm: string, username: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `The new password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > 200) return "The new password is too long (200 characters at most).";
  if (password.trim().toLowerCase() === username.trim().toLowerCase()) return "The new password cannot be your username.";
  if (password !== confirm) return "The two new passwords do not match.";
  return null;
}
