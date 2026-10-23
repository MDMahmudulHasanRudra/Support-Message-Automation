/**
 * Chat v2 rich messaging (CHAT_RICH_MESSAGING.md): the rules the worker and the dashboard must agree
 * on, as pure functions — receipts, deleted messages, polls, locations, stickers and forwards.
 *
 * Every rule here describes only what WhatsApp told us. A receipt is the ack level WhatsApp reported,
 * a deletion is WhatsApp saying "revoked", a poll is the poll WhatsApp delivered. Nothing is inferred
 * from silence: no receipt means "not reported", never "not delivered".
 */

// ---- Receipts ---------------------------------------------------------------------------------

/** WhatsApp's ack levels, as the library reports them (MessageAck). */
export const ACK_LEVEL = { ERROR: -1, PENDING: 0, SENT: 1, DELIVERED: 2, READ: 3, PLAYED: 4 } as const;

/**
 * The ack level worth recording, or null. Only 1–4 are facts about a message that left: -1 and 0 are
 * the sending device's own state (failed / clock), which the outbound queue already reports, and
 * anything else is a value this code has no reading for.
 */
export function recordableAckLevel(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n)) return null;
  return n >= ACK_LEVEL.SENT && n <= ACK_LEVEL.PLAYED ? n : null;
}

export interface ReceiptColumns {
  ackLevel: number | null;
  deliveredAt: Date | null;
  readAt: Date | null;
  playedAt: Date | null;
}

/**
 * What a new ack changes on a stored message, or null when it changes nothing. A level only ever
 * rises — acks can arrive out of order, and "read" must never fall back to "delivered" — and each
 * time is the moment we first learned that step, never overwritten. Reaching a level implies the ones
 * below it (a "read" with no "delivered" seen first is still delivered).
 *
 * The worker applies the same rule in one conditional UPDATE so two acks racing cannot lower it; this
 * function is that rule written once, for tests and for any reader that holds the columns.
 */
export function applyAck(current: ReceiptColumns, level: number, now: Date): ReceiptColumns | null {
  const next = recordableAckLevel(level);
  if (next === null) return null;
  if (current.ackLevel !== null && current.ackLevel >= next) return null;
  return {
    ackLevel: next,
    deliveredAt: current.deliveredAt ?? (next >= ACK_LEVEL.DELIVERED ? now : null),
    readAt: current.readAt ?? (next >= ACK_LEVEL.READ ? now : null),
    playedAt: current.playedAt ?? (next >= ACK_LEVEL.PLAYED ? now : null),
  };
}

export interface ReceiptView {
  /** One tick (sent) or two (delivered or further). */
  ticks: 1 | 2;
  /** Blue: read (or played). */
  read: boolean;
  /** What the ticks mean, in words — a group's "read" means every participant. */
  label: string;
}

/**
 * The ticks for a message this account sent. `ackLevel` null means no receipt was reported for it
 * (older rows, or WhatsApp has said nothing yet): one tick, "Sent", which is what storing it proves.
 */
export function describeReceipt(ackLevel: number | null, isGroup: boolean): ReceiptView {
  const level = recordableAckLevel(ackLevel) ?? ACK_LEVEL.SENT;
  if (level >= ACK_LEVEL.PLAYED) return { ticks: 2, read: true, label: isGroup ? "Played by everyone" : "Played" };
  if (level >= ACK_LEVEL.READ) return { ticks: 2, read: true, label: isGroup ? "Read by everyone" : "Read" };
  if (level >= ACK_LEVEL.DELIVERED) return { ticks: 2, read: false, label: isGroup ? "Delivered to everyone" : "Delivered" };
  return { ticks: 1, read: false, label: "Sent" };
}

// ---- Deleted for everyone -------------------------------------------------------------------------

/** WhatsApp's own type for a message deleted for everyone. */
export const REVOKED_WA_TYPE = "revoked";

/**
 * How the thread names a deleted message. The original text stays visible to staff underneath, since
 * what was said is part of the record; WhatsApp does not say WHO deleted it (a group admin can delete
 * other people's messages), so neither do we.
 */
export function describeRevoked(outgoing: boolean): string {
  return outgoing ? "Deleted for everyone on WhatsApp — the text below is what was sent." : "Deleted for everyone on WhatsApp — the text below is what was received.";
}

// ---- Polls ----------------------------------------------------------------------------------------

export const POLL_LIMITS = { nameMax: 255, optionMax: 100, minOptions: 2, maxOptions: 12 } as const;

export interface PollContent {
  name: string;
  options: string[];
  allowMultiple: boolean;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * A poll a person is about to send, checked. Refused rather than trimmed: a poll that silently lost
 * an option is a different poll from the one somebody wrote.
 */
export function validatePoll(input: unknown): Checked<PollContent> {
  const raw = (input ?? {}) as { name?: unknown; options?: unknown; allowMultiple?: unknown };
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) return { ok: false, error: "Write the poll question." };
  if (name.length > POLL_LIMITS.nameMax) return { ok: false, error: `Keep the question under ${POLL_LIMITS.nameMax} characters.` };
  if (!Array.isArray(raw.options)) return { ok: false, error: "Add the poll's options." };
  const options = raw.options.map((o) => (typeof o === "string" ? o.trim() : "")).filter(Boolean);
  if (options.length !== raw.options.length) return { ok: false, error: "Every option needs some text — remove the empty ones." };
  if (options.length < POLL_LIMITS.minOptions) return { ok: false, error: `A poll needs at least ${POLL_LIMITS.minOptions} options.` };
  if (options.length > POLL_LIMITS.maxOptions) return { ok: false, error: `WhatsApp allows at most ${POLL_LIMITS.maxOptions} options.` };
  const long = options.find((o) => o.length > POLL_LIMITS.optionMax);
  if (long) return { ok: false, error: `Keep each option under ${POLL_LIMITS.optionMax} characters.` };
  const seen = new Set<string>();
  for (const option of options) {
    const key = option.toLocaleLowerCase();
    if (seen.has(key)) return { ok: false, error: `"${option}" is listed twice. Each option must be different.` };
    seen.add(key);
  }
  return { ok: true, value: { name, options, allowMultiple: raw.allowMultiple === true } };
}

// ---- Locations ------------------------------------------------------------------------------------

export const LOCATION_NAME_MAX = 120;

export interface LocationContent {
  latitude: number;
  longitude: number;
  /** What the pin is called on WhatsApp; empty = WhatsApp shows the coordinates. */
  name: string;
}

function toCoordinate(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value.trim()) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** A location a person is about to send, checked: real coordinates, and not the empty 0,0. */
export function validateLocation(input: unknown): Checked<LocationContent> {
  const raw = (input ?? {}) as { latitude?: unknown; longitude?: unknown; name?: unknown };
  const latitude = toCoordinate(raw.latitude);
  const longitude = toCoordinate(raw.longitude);
  if (latitude === null || longitude === null) return { ok: false, error: "Enter a latitude and a longitude, or paste a map link." };
  if (latitude < -90 || latitude > 90) return { ok: false, error: "Latitude must be between -90 and 90." };
  if (longitude < -180 || longitude > 180) return { ok: false, error: "Longitude must be between -180 and 180." };
  // 0,0 is in the sea off West Africa — always an empty form, never a place somebody meant.
  if (latitude === 0 && longitude === 0) return { ok: false, error: "0, 0 is not a real place. Check the coordinates." };
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (name.length > LOCATION_NAME_MAX) return { ok: false, error: `Keep the place name under ${LOCATION_NAME_MAX} characters.` };
  return { ok: true, value: { latitude: round6(latitude), longitude: round6(longitude), name } };
}

/** Six decimals is about 10 cm — finer is noise from a copied value, not precision. */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Coordinates from what people actually paste: "23.8103, 90.4125", or a Google Maps / OpenStreetMap
 * link carrying them (`@lat,lng`, `q=lat,lng`, `query=lat,lng`, `ll=`, `mlat=…&mlon=…`). Null when
 * nothing in it reads as a coordinate pair — a short link (maps.app.goo.gl) carries none, and is not
 * followed: the server never fetches a URL somebody typed.
 */
export function parseCoordinates(text: string): { latitude: number; longitude: number } | null {
  const value = text.trim();
  if (!value) return null;
  const pair = String.raw`(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)`;
  const patterns = [
    new RegExp(`^${pair}$`),
    new RegExp(`@${pair}`),
    new RegExp(`[?&](?:q|query|ll|destination|center)=${pair}`),
  ];
  let match: RegExpExecArray | null = null;
  for (const pattern of patterns) {
    match = pattern.exec(value.replace(/%2C/gi, ","));
    if (match) break;
  }
  let latitude: number | null = match ? Number(match[1]) : null;
  let longitude: number | null = match ? Number(match[2]) : null;
  if (!match) {
    const lat = /[?&]mlat=(-?\d+(?:\.\d+)?)/.exec(value);
    const lon = /[?&]mlon=(-?\d+(?:\.\d+)?)/.exec(value);
    if (!lat || !lon) return null;
    latitude = Number(lat[1]);
    longitude = Number(lon[1]);
  }
  const checked = validateLocation({ latitude, longitude });
  return checked.ok ? { latitude: checked.value.latitude, longitude: checked.value.longitude } : null;
}

/** A link that opens the pin in a map. Built from numbers only, so nothing a sender typed reaches it. */
export function locationMapUrl(latitude: number, longitude: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${latitude},${longitude}`)}`;
}

// ---- What a stored message shows ---------------------------------------------------------------

export type RichContent =
  | ({ kind: "POLL" } & PollContent)
  | ({ kind: "LOCATION" } & LocationContent);

/** A stored `Message.richContent` value, read defensively: an unknown or malformed shape is null. */
export function readRichContent(value: unknown): RichContent | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { kind?: unknown };
  if (raw.kind === "POLL") {
    const poll = validatePollShape(value);
    return poll ? { kind: "POLL", ...poll } : null;
  }
  if (raw.kind === "LOCATION") {
    const r = value as { latitude?: unknown; longitude?: unknown; name?: unknown };
    const latitude = toCoordinate(r.latitude);
    const longitude = toCoordinate(r.longitude);
    if (latitude === null || longitude === null || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
    return { kind: "LOCATION", latitude, longitude, name: typeof r.name === "string" ? r.name.slice(0, 300) : "" };
  }
  return null;
}

/** A poll as WhatsApp delivered it — looser than `validatePoll`, which governs what WE send. */
function validatePollShape(value: unknown): PollContent | null {
  const r = value as { name?: unknown; options?: unknown; allowMultiple?: unknown };
  if (typeof r.name !== "string" || !Array.isArray(r.options)) return null;
  const options = r.options.filter((o): o is string => typeof o === "string").slice(0, 32);
  return { name: r.name.slice(0, 1000), options, allowMultiple: r.allowMultiple === true };
}

// ---- What we send ---------------------------------------------------------------------------------

/** Mirrors the Prisma enum `OutboundContentType`. */
export type OutboundContentKind = "TEXT" | "POLL" | "LOCATION" | "STICKER" | "FORWARD" | "MEDIA";

/**
 * The readable summary an outbound row carries in `body` for a poll, location, sticker or forward —
 * what the queued bubble, the delivery log and a search show. It uses the same labels the provider
 * writes for a received one, so a poll we sent and a poll we received read alike.
 */
export function outboundSummary(
  kind: Exclude<OutboundContentKind, "TEXT" | "MEDIA">,
  content: { poll?: PollContent; location?: LocationContent; forwardedBody?: string },
): string {
  switch (kind) {
    case "POLL":
      return `[Poll] ${content.poll?.name ?? ""}`.trim();
    case "LOCATION": {
      const loc = content.location;
      if (!loc) return "[Location]";
      return `[Location] ${loc.name || `${loc.latitude}, ${loc.longitude}`}`;
    }
    case "STICKER":
      return "[Sticker]";
    case "FORWARD": {
      const text = (content.forwardedBody ?? "").trim();
      return text ? `[Forwarded] ${text.length > 500 ? `${text.slice(0, 500)}…` : text}` : "[Forwarded]";
    }
  }
}

/** A sticker WhatsApp will accept as one: a stored WebP, under its size ceiling. */
export const STICKER_MAX_BYTES = 1_000_000;
export function isSendableSticker(media: { mediaType: string; mimeType: string | null; status: string; sizeBytes: number | bigint | null }): boolean {
  const size = media.sizeBytes === null ? null : Number(media.sizeBytes);
  return media.mediaType === "STICKER" && media.mimeType === "image/webp" && media.status === "STORED" && size !== null && size > 0 && size <= STICKER_MAX_BYTES;
}

/** The forward rule: only a stored message of the same account, never one deleted for everyone. */
export function forwardRefusal(source: { accountId: string; revokedAt: Date | null } | null, accountId: string): string | null {
  if (!source) return "That message could not be found.";
  if (source.accountId !== accountId) return "Only a message from this account's own conversations can be forwarded from it.";
  if (source.revokedAt) return "That message was deleted for everyone on WhatsApp, so it cannot be forwarded.";
  return null;
}
