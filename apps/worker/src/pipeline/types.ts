/** Provider-agnostic shape of a message event, as delivered by any WhatsAppProvider. */
export interface RawIncomingMessage {
  accountId: string;
  whatsappMessageId: string;
  chatId: string;
  /** Present when the chat is a group; absent for a 1:1 DM. */
  whatsappGroupId?: string | null;
  /** The group's name as WhatsApp shows it, when the message carried one. Used only to register a
   *  group the group sync has not stored yet — the sync remains the authority on names. */
  groupName?: string | null;
  senderPhone: string;
  senderName?: string | null;
  direction: "INCOMING" | "OUTGOING" | "SYSTEM";
  body: string;
  timestampWa: Date;
  /** WhatsApp message id of the message this one quotes (swipe-to-reply), if any. */
  quotedWhatsappMessageId?: string | null;
  /** Digits-only phone numbers @-mentioned in this message. */
  mentionedPhones?: string[];
}
