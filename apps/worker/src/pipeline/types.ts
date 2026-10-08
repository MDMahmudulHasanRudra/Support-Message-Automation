import type { MessageMediaKind } from "@support-automation/shared";

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
  /** The attachment, when the message carried a file. Absent for text, locations and contact cards. */
  media?: RawMediaDescriptor | null;
}

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
