/**
 * WhatsApp Chat v2 (CHAT_UI_V2.md): reactions this account SENT, and only what is known about them.
 *
 * A reaction is a `REACT_TO_MESSAGE` WorkerCommand; the worker calls the provider and records
 * DONE (WhatsApp Web accepted it) or FAILED with the reason. Queuing the command proves nothing, so a
 * reaction is "sent" only once its command is DONE — until then it is pending, and a failure is shown
 * as a failure. Reactions OTHER people make cannot be shown at all: receiving them needs the library's
 * Insiders licence (`onReaction`), which this deployment does not have, and none is invented.
 *
 * WhatsApp keeps one reaction per person per message, so the newest command decides what is on the
 * message; an older confirmed reaction is still what WhatsApp shows while a newer one is pending or
 * after it failed.
 */

/** The quick row, in WhatsApp's own order. */
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"] as const;

const GRAPHEMES = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/**
 * Exactly one emoji: one grapheme cluster that is pictographic (or a flag / keycap), with no letters.
 * WhatsApp takes one emoji per reaction, and the worker refuses an empty one.
 */
export function isValidReactionEmoji(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const emoji = value.trim();
  if (!emoji || emoji.length > 32 || emoji !== value) return false;
  if (/[\p{L}\s]/u.test(emoji)) return false;
  if (!/\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(emoji)) return false;
  if (GRAPHEMES) {
    let count = 0;
    for (const _ of GRAPHEMES.segment(emoji)) if (++count > 1) return false;
  }
  return true;
}

export type ReactionCommandStatus = "PENDING" | "PROCESSING" | "DONE" | "FAILED";

export interface ReactionCommandRow {
  messageId: string;
  emoji: string;
  status: ReactionCommandStatus | string;
  createdAt: Date;
  error: string | null;
  /** The software user who asked for it, when recorded. */
  requestedById: string | null;
}

export interface OwnReactionState {
  /** What WhatsApp accepted most recently (DONE), if anything. */
  confirmed: { emoji: string; at: Date; requestedById: string | null } | null;
  /** A newer request still waiting for the worker. */
  pending: { emoji: string } | null;
  /** A newer request that failed, with the worker's reason. */
  failed: { emoji: string; error: string } | null;
}

export function summariseOwnReactions(rows: readonly ReactionCommandRow[]): Map<string, OwnReactionState> {
  const byMessage = new Map<string, ReactionCommandRow[]>();
  for (const row of rows) {
    const list = byMessage.get(row.messageId);
    if (list) list.push(row);
    else byMessage.set(row.messageId, [row]);
  }
  const out = new Map<string, OwnReactionState>();
  for (const [messageId, list] of byMessage) {
    const newestFirst = [...list].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const latest = newestFirst[0]!;
    const lastDone = newestFirst.find((r) => r.status === "DONE") ?? null;
    out.set(messageId, {
      confirmed: lastDone ? { emoji: lastDone.emoji, at: lastDone.createdAt, requestedById: lastDone.requestedById } : null,
      pending: latest.status === "PENDING" || latest.status === "PROCESSING" ? { emoji: latest.emoji } : null,
      failed: latest.status === "FAILED" ? { emoji: latest.emoji, error: latest.error || "WhatsApp did not accept the reaction." } : null,
    });
  }
  return out;
}
