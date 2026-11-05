import { createHash, createHmac, randomBytes } from "node:crypto";

/**
 * How a log line refers to a WhatsApp id without printing it.
 *
 * WhatsApp's ids are not opaque: a personal chat id is `<phone>@c.us`, a message id is
 * `<fromMe>_<chat>_<key>[_<participant>]`, and a group created before 2021 is `<creator's phone>-<time>@g.us`.
 * Printing any of them prints a phone number, and Docker keeps stdout (docs/get-assist-ultimate/20 §2, F1).
 * logPrivacy.test.ts fails the build if a log call prints one directly.
 */

const KEY = randomBytes(32);

/**
 * For ids with nothing random in them — chats, groups, senders. Keyed with a random key made when the
 * process starts: there are only about a billion phone numbers per country, so an unkeyed hash of
 * `<phone>@c.us` could be reversed by trying them all. The cost is deliberate: a reference matches lines
 * within ONE worker run only.
 */
export function logRef(id: string): string {
  return `r${createHmac("sha256", KEY).update(id).digest("hex").slice(0, 12)}`;
}

/**
 * The pipeline's trace id for one received message: every log line about it carries this, and so do the
 * durable records that name a correlation (`AiFallbackDecision.correlationId`, `SystemLog.correlationId`).
 *
 * Unkeyed, so it is the same in every process and can be recomputed from a stored row
 * (`Message.accountId` + `whatsappMessageId`). That is safe here, unlike `logRef`'s ids, because a WhatsApp
 * message id ends in a random message key: knowing the chat does not let anyone enumerate it.
 */
export function messageTraceId(accountId: string, whatsappMessageId: string): string {
  return `m${createHash("sha256").update(`${accountId}:${whatsappMessageId}`).digest("hex").slice(0, 16)}`;
}
