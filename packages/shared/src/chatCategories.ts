/**
 * The colours a chat category may be, and the rules for naming one.
 *
 * A fixed palette rather than a free colour picker: these are 10px dots scanned down the left edge
 * of a list, so they have to stay distinguishable from each other and legible on both themes. A
 * picker guarantees somebody eventually chooses a near-white on white, and a category nobody can
 * see is worse than one with a colour they did not pick.
 *
 * Shared because the form validates against it and the list renders from it — two hand-written
 * copies of a palette drift the moment one gains a colour.
 */

export const CHAT_CATEGORY_COLORS = [
  "gray",
  "blue",
  "green",
  "amber",
  "red",
  "purple",
  "teal",
  "pink",
] as const;

export type ChatCategoryColor = (typeof CHAT_CATEGORY_COLORS)[number];

export function isChatCategoryColor(value: string): value is ChatCategoryColor {
  return (CHAT_CATEGORY_COLORS as readonly string[]).includes(value);
}

/** Long enough to be descriptive, short enough to stay on one line in a filter chip. */
export const MAX_CHAT_CATEGORY_NAME = 32;

export interface CategoryNameCheck {
  error?: string;
  name?: string;
}

/**
 * Validates and normalises a category name.
 *
 * Whitespace is collapsed rather than merely trimmed, because "VIP  clients" and "VIP clients"
 * are the same folder to everybody except the unique index, and discovering that through a
 * confusing duplicate is a worse lesson than having it quietly fixed on the way in.
 */
export function checkChatCategoryName(raw: string): CategoryNameCheck {
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name) return { error: "Give the category a name." };
  if (name.length > MAX_CHAT_CATEGORY_NAME) {
    return { error: `Keep the name under ${MAX_CHAT_CATEGORY_NAME} characters so it fits the filter bar.` };
  }
  return { name };
}
