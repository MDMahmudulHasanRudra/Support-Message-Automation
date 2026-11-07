/**
 * The rules for a new login, shared by every place that creates one — the project portal's App Users
 * page and Main Admin → Users & Permissions — so the two can never accept different passwords or
 * store usernames differently.
 */
/** Platform operators' fixed rule. A customer's people follow server/passwordPolicy.ts. */
export const MIN_PASSWORD_LENGTH = 12;

/** A customer's password length: what it starts at, and how far it can go. Below 6 is guessed in minutes. */
export const DEFAULT_PASSWORD_LENGTH = 8;
export const PASSWORD_LENGTH_FLOOR = 6;
export const PASSWORD_LENGTH_CEILING = 128;

/** A length someone typed, or null when it is not a whole number inside the limits. */
export function readPasswordLength(raw: unknown): number | null {
  const value = Number(String(raw ?? "").trim());
  return Number.isInteger(value) && value >= PASSWORD_LENGTH_FLOOR && value <= PASSWORD_LENGTH_CEILING ? value : null;
}

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
export function validateNewPassword(password: string, confirm: string, username: string, minLength: number): string | null {
  if (password.length < minLength) return `The new password must be at least ${minLength} characters.`;
  if (password.length > 200) return "The new password is too long (200 characters at most).";
  if (password.trim().toLowerCase() === username.trim().toLowerCase()) return "The new password cannot be your username.";
  if (password !== confirm) return "The two new passwords do not match.";
  return null;
}
