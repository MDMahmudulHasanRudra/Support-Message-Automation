/**
 * A stable colour and monogram per conversation.
 *
 * Every row in this list used to carry the same grey square with two letters in it, which meant
 * the avatar did no work at all: in a list of three hundred groups the eye has nothing to lock
 * onto and every scan starts by reading names. Giving each group a colour it keeps forever turns
 * the left edge into something navigable — you learn where a conversation *is* before you learn
 * what it is called, which is how people actually use a chat client.
 *
 * Colour comes from the chart slots rather than the status tokens, and that is the design
 * system's own rule rather than a preference: chart slots encode identity, status tokens encode
 * state. An avatar tinted with `--color-warning` would read as a warning about that group.
 *
 * Derived from the group id, not the name. A renamed group keeps its colour — losing it on a
 * rename would break the one thing the colour is for.
 */

/** The tint slots. Eight is enough to feel varied and few enough that each stays distinguishable. */
const SLOTS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
] as const;

/**
 * FNV-1a. Any stable hash would do; this one is four lines, has no dependency, and spreads short
 * similar strings ("cmtr5…a", "cmtr5…b") across different slots, which a naive char-sum does not.
 */
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return Math.abs(h);
}

export interface ConversationAvatar {
  /** Background: the slot mixed into the surface, so it stays a tint in light AND dark. */
  background: string;
  /** Foreground: the slot itself, which carries enough chroma to read on its own tint. */
  color: string;
  /** Up to two letters, skipping the punctuation most of these group names start with. */
  initials: string;
}

export function conversationAvatar(id: string, name: string): ConversationAvatar {
  const slot = SLOTS[hash(id) % SLOTS.length]!;

  // color-mix against the surface token rather than two hand-written light/dark values: the
  // surface flips with the theme, so the tint follows it without a second definition to keep in
  // sync — the same reason every other colour here is a token.
  return {
    background: `color-mix(in oklab, ${slot} 14%, var(--color-surface))`,
    color: slot,
    initials: initialsFor(name),
  };
}

/**
 * "Softifybd & PS INTERNET SERVICE" → "SP", not "SO".
 *
 * Nearly every group here is "<Customer> & Softifybd", so the first two characters are the same
 * on hundreds of rows. Taking the first letter of the first two *words* is what makes a monogram
 * distinguish anything.
 */
function initialsFor(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
}
