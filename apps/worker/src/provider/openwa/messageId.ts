/**
 * A WhatsApp message id as the string this system stores and looks up, whatever shape it arrived in.
 *
 * OpenWA types every message id as a string (`MessageId`, a branded `${boolean}_${chatId}_${id}`),
 * and on the live `onAnyMessage` path that is true — 1,257 quoted replies were resolved that way
 * before this existed. The history API is different. `getAllMessagesInChat`, which the missed-
 * message catch-up reads from, hands back the quoted message's id as WhatsApp's raw key object:
 *
 *   { fromMe: false, remote: "1203…@g.us", id: "A59A…", participant: "2521…@lid", _serialized: … }
 *
 * Passed straight to Prisma that is "Expected String, provided Object", and every reply that
 * quoted something was dropped from the sweep — 29 of 706 on the first catch-up in production,
 * all of them quoted replies. The type was never going to catch it: it describes the live payload.
 *
 * So this takes `unknown` on purpose. `_serialized` is the canonical form when present; when it is
 * not, the key is rebuilt from its parts in the same order WhatsApp serialises it, which is exactly
 * the value the failing rows carried.
 */
export function serializeMessageId(id: unknown): string | null {
  if (typeof id === "string") return id.length > 0 ? id : null;
  if (!id || typeof id !== "object") return null;

  const key = id as { _serialized?: unknown; fromMe?: unknown; remote?: unknown; id?: unknown; participant?: unknown };
  if (typeof key._serialized === "string" && key._serialized.length > 0) return key._serialized;

  const remote = asJid(key.remote);
  if (typeof key.fromMe !== "boolean" || !remote || typeof key.id !== "string" || !key.id) return null;

  // A group message carries its author as a fourth segment; a one-to-one message has none.
  const participant = asJid(key.participant);
  return participant ? `${key.fromMe}_${remote}_${key.id}_${participant}` : `${key.fromMe}_${remote}_${key.id}`;
}

/** A chat or participant id, which WhatsApp sometimes nests as `{ _serialized }` too. */
function asJid(value: unknown): string | null {
  if (typeof value === "string") return value || null;
  if (value && typeof value === "object") {
    const serialized = (value as { _serialized?: unknown })._serialized;
    if (typeof serialized === "string" && serialized) return serialized;
  }
  return null;
}
