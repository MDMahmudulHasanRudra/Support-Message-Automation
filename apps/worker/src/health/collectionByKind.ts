import { collectedChatKind } from "@support-automation/shared";

/**
 * What this process has collected, per account and per kind of conversation (group / personal).
 *
 * The account-wide figures in `metrics.ts` could not answer the question the 18 Oct 2026 incident
 * asked — "groups arrive, many personal messages do not" — because every counter mixed the two. A
 * personal message that never reached the pipeline, or was dropped, or was only recovered later,
 * looked the same as a group one. These say which.
 *
 * In memory, like `metrics.ts` and for the same reason: they describe what THIS process saw, and the
 * durable record is the `Message` rows themselves. Counts and account ids only — never a chat id, a
 * number or a message.
 */
export interface KindCounters {
  /** Handed over by the provider's live listener. */
  received: number;
  /** A `Message` row was written (live, late, or recovered). */
  stored: number;
  /** Received and not stored: empty body, or a pipeline failure after every retry. */
  dropped: number;
  /** Not in the database although WhatsApp held it, stored by the reconcile sweep or a gap catch-up. */
  recovered: number;
  /** Arrived still encrypted ("Waiting for this message"), with nothing yet to store. */
  undecrypted: number;
  /** One of those, read again once WhatsApp had decrypted it, and handed to the pipeline. */
  decryptedLater: number;
  /** One of those that was still encrypted after the last re-read — not stored by the live path. */
  undecryptedGaveUp: number;
}

export type CollectionEvent = keyof KindCounters;
export type ConversationKind = "GROUP" | "PERSONAL" | "OTHER";

const counters = new Map<string, Record<ConversationKind, KindCounters>>();

const empty = (): KindCounters => ({
  received: 0,
  stored: 0,
  dropped: 0,
  recovered: 0,
  undecrypted: 0,
  decryptedLater: 0,
  undecryptedGaveUp: 0,
});

/** The kind of a chat id: a group, a one-to-one chat, or anything else (status, channels, unknown). */
export function conversationKind(chatId: string | null | undefined): ConversationKind {
  return (chatId && collectedChatKind(chatId)) || "OTHER";
}

export function recordCollection(accountId: string, chatId: string | null | undefined, event: CollectionEvent, by = 1): void {
  let row = counters.get(accountId);
  if (!row) {
    row = { GROUP: empty(), PERSONAL: empty(), OTHER: empty() };
    counters.set(accountId, row);
  }
  row[conversationKind(chatId)][event] += by;
}

/** Per account, per kind. Kinds with nothing recorded are left out so the output stays readable. */
export function readCollectionByKind(): Record<string, Partial<Record<ConversationKind, KindCounters>>> {
  const out: Record<string, Partial<Record<ConversationKind, KindCounters>>> = {};
  for (const [accountId, kinds] of counters) {
    const shown: Partial<Record<ConversationKind, KindCounters>> = {};
    for (const kind of ["GROUP", "PERSONAL", "OTHER"] as const) {
      if (Object.values(kinds[kind]).some((value) => value > 0)) shown[kind] = { ...kinds[kind] };
    }
    out[accountId] = shown;
  }
  return out;
}

/** Test seam. */
export function resetCollectionByKindForTests(): void {
  counters.clear();
}
