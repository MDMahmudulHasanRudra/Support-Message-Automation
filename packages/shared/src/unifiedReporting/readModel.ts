import type { IntelActor } from "../intelligence/model.js";
import type { SenderMatchStatus } from "../whatsappIdentity.js";
import type { ReportScope } from "./reportScope.js";

export type { ReportScope };

/** Which collection a conversation belongs to. Derived from the chat id, never stored. */
export type ConversationKind = "GROUP" | "PERSONAL";

/**
 * One LOGICAL message (copies collapsed), classified once at read time.
 * GROUP:    conversationKey = WhatsApp group id (`WhatsAppGroup.whatsappGroupId`).
 * PERSONAL: conversationKey = `${accountId}|${chatId}` — a personal chat belongs to the account
 *           that holds its messages.
 */
export interface UnifiedMessage {
  conversationKind: ConversationKind;
  conversationKey: string;
  /** `logicalMessageKey(chatId, whatsappMessageId)` — stable across copies. */
  logicalKey: string;
  accountId: string;
  chatId: string;
  /** Message.timestampWa (event time), epoch ms. */
  ts: number;
  /** Message.createdAt of the kept copy — tie-break and late-arrival. */
  storedAt: number;
  kind: "CUSTOMER" | "MEMBER" | "BUSINESS";
  actor: IntelActor;
  memberId: string | null;
  operatorUserId: string | null;
  matchStatus: SenderMatchStatus | null;
  customerIds: string[];
  quotedKey: string | null;
  mentionedIds: string[];
  /** Body only where the Support-Intelligence prefilter allows it. Never exported. */
  text: string | null;
  /** True for rows inside [rangeStart, rangeEnd); false for context and look-ahead rows. */
  inPeriod: boolean;
}

export const conversationKeyOf = (kind: ConversationKind, accountId: string, chatId: string, whatsappGroupId: string | null): string =>
  kind === "GROUP" ? (whatsappGroupId ?? chatId) : `${accountId}|${chatId}`;
