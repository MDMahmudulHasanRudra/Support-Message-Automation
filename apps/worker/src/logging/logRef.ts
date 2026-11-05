import { createHmac, randomBytes } from "node:crypto";

/**
 * How a log line refers to a WhatsApp id without printing it.
 *
 * WhatsApp's ids are not opaque: a personal chat id is `<phone>@c.us`, a message id is
 * `<fromMe>_<chat>_<key>[_<participant>]`, and a group created before 2021 is `<creator's phone>-<time>@g.us`.
 * Printing any of them prints a phone number, and Docker keeps stdout (docs/get-assist-ultimate/20 §2, F1).
 * logPrivacy.test.ts fails the build if a log call prints one directly; logging/redact.ts rewrites any that
 * still reach the console or System Logs inside library text.
 *
 * Both references are keyed (HMAC-SHA256). Neither can be reversed by trying phone numbers, whatever
 * the id looks like.
 */

const PROCESS_KEY = randomBytes(32);

/**
 * For chats, groups and senders. Keyed with a random key made when the process starts, so a reference
 * matches lines within ONE worker run and nothing else: it cannot be recomputed from the database.
 */
export function logRef(id: string): string {
  return `r${createHmac("sha256", PROCESS_KEY).update(id).digest("hex").slice(0, 12)}`;
}

/**
 * The key for message trace ids: derived from the worker's persistent secret, so the same message gets
 * the same trace id in every process. That keeps a retry after a restart, and the durable correlation
 * on `AiFallbackDecision.correlationId` / `SystemLog.correlationId`, pointing at one message. It is
 * derived rather than reused: the encryption key itself never signs anything else.
 *
 * Rotating `AI_CREDENTIALS_ENCRYPTION_KEY` changes every trace id from then on; old rows keep theirs.
 * Without the variable (some local tests), the key is per process, so ids are stable within one run.
 */
export function deriveTraceKey(secret: string): Buffer {
  return createHmac("sha256", secret).update("get-assist/log-trace/v1").digest();
}

const persistentSecret = process.env.AI_CREDENTIALS_ENCRYPTION_KEY;
const TRACE_KEY = persistentSecret ? deriveTraceKey(persistentSecret) : PROCESS_KEY;
if (!persistentSecret) {
  console.warn("[logging] AI_CREDENTIALS_ENCRYPTION_KEY is not set: message trace ids are stable within this process only");
}

export function messageTraceIdWithKey(key: Buffer, accountId: string, whatsappMessageId: string): string {
  return `m${createHmac("sha256", key).update(`${accountId}:${whatsappMessageId}`).digest("hex").slice(0, 16)}`;
}

/** The pipeline's trace id for one received message: every log line about it, and its stored correlation. */
export function messageTraceId(accountId: string, whatsappMessageId: string): string {
  return messageTraceIdWithKey(TRACE_KEY, accountId, whatsappMessageId);
}
