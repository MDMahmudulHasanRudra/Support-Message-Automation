/**
 * The placeholder text that stands in for a message this system cannot read.
 *
 * WhatsApp delivers images, voice notes, stickers, documents and locations as media, and this
 * product stores text. The provider therefore substitutes a short label so the message still
 * exists in the inbox, in reporting and in a conversation transcript — "[Image]", "[Voice
 * message]" and so on, with the caption appended when there is one.
 *
 * The label is a record that something arrived. It is NOT a description of the content, and
 * nothing in this system can see inside the media: there is no image understanding, no
 * transcription and no document parsing anywhere in the pipeline. Treating the label as if it
 * were the customer's question is how "[Image]" reaches the AI as a message to answer, and the
 * model — asked to help with a message that says only "[Image]" — produces a confident, generic
 * reply to a screenshot nobody looked at.
 *
 * `AiSettings.screenshotResponseEnabled` exists and is read by nothing; it was clearly intended
 * to gate exactly this. Until real image understanding exists, the honest behaviour is to hand
 * these to a person, which is what `isMediaOnlyBody` is for.
 */

/** The labels the provider emits, without the caption that may follow. */
export const MEDIA_PLACEHOLDER_LABELS = [
  "[Image]",
  "[Video]",
  "[Audio]",
  "[Voice message]",
  "[Document]",
  "[Sticker]",
  "[Location]",
  "[Contact card]",
  "[Media]",
] as const;

/**
 * True when a message body is nothing but a media placeholder — no caption, no words of the
 * customer's own.
 *
 * A captioned image ("[Image] amar bill ashe nai") is deliberately NOT media-only: the caption is
 * a real question the customer typed, and it can be answered on its own terms. Only a bare label
 * means there is genuinely nothing to read.
 */
export function isMediaOnlyBody(body: string | null | undefined): boolean {
  if (!body) return false;
  const trimmed = body.trim();
  return MEDIA_PLACEHOLDER_LABELS.some((label) => trimmed === label);
}
