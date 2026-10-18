import type { MessageMediaKind, RichContent } from "@support-automation/shared";

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
  /** The sender's id with the domain stripped — digits for a phone number, the bare LID otherwise. */
  senderPhone: string;
  /**
   * The sender exactly as WhatsApp named them, domain kept (`…@c.us`, `…@lid`). The domain is the
   * only thing that tells a phone number from a LID (WHATSAPP_IDENTITY.md). Null when unknown.
   */
  senderJid?: string | null;
  senderName?: string | null;
  direction: "INCOMING" | "OUTGOING" | "SYSTEM";
  body: string;
  timestampWa: Date;
  /** WhatsApp message id of the message this one quotes (swipe-to-reply), if any. */
  quotedWhatsappMessageId?: string | null;
  /** Digits-only phone numbers @-mentioned in this message. */
  mentionedPhones?: string[];
  /** The attachment, when the message carried a file. Absent for text, locations and contact cards. */
  media?: RawMediaDescriptor | null;
  /**
   * WhatsApp delivered this as deleted for everyone (type "revoked") — no content is left, so it is
   * never stored as a message of its own; it marks the stored original instead (CHAT_RICH_MESSAGING.md §3).
   */
  revoked?: boolean;
  /**
   * Handed over AFTER its arrival — WhatsApp delivered it encrypted and decrypted it later
   * (OpenWAProvider `awaitDecryption`). The registry applies the catch-up's automation window to it,
   * so an old question is stored and counted but not answered late.
   */
  deliveredLate?: boolean;
  /** For a message this account sent: the ack level WhatsApp reported with it (1–4), else null. */
  ackLevel?: number | null;
  /** A poll or a location, as WhatsApp described it (display only; `body` stays the text). */
  richContent?: RichContent | null;
}

/** A change to a message already sent or received, reported by the provider after the fact. */
export type MessageUpdateEvent =
  | { kind: "ACK"; accountId: string; whatsappMessageId: string; ackLevel: number }
  | { kind: "REVOKED"; accountId: string; whatsappMessageId: string };

/**
 * The file a message carried, as the provider described it (MEDIA_STORAGE.md). Only metadata and
 * what is needed to fetch it later: the pipeline never downloads anything — it records this and
 * moves on, and the media worker fetches the file in the background.
 */
export interface RawMediaDescriptor {
  /** WhatsApp's own type ("image", "ptt", "document", …). */
  waType: string;
  mediaType: MessageMediaKind;
  mimeType: string | null;
  fileName: string | null;
  declaredSizeBytes: number | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  isAnimated: boolean;
  /** Null when WhatsApp handed over nothing to fetch it with; the worker then asks the live session. */
  download: MediaDownloadInfo | null;
}

/**
 * What WhatsApp gives a client to fetch and decrypt an attachment: the encrypted file's URL, its
 * media key, and the hashes that prove the decrypted file is the one that was sent.
 */
export interface MediaDownloadInfo {
  /** Base64 media key — decrypts the file. Held only until the file is stored. */
  mediaKey: string;
  /** Base64 SHA-256 of the decrypted file, as WhatsApp computed it. */
  filehash: string | null;
  /** Base64 SHA-256 of the encrypted file. */
  encFilehash: string | null;
  url: string | null;
  directPath: string | null;
  /** WhatsApp's own small JPEG preview, base64, when it sent one. */
  thumbnailJpegBase64: string | null;
}
