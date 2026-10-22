import { describeSenderId, isPersonKind, parseWhatsAppId } from "./whatsappIdentity.js";
import { normalizePhoneNumber } from "./groupParticipantAdd.js";

/**
 * WhatsApp pictures and phone identity, as rules (WHATSAPP_AVATARS.md). Pure — the worker and the
 * dashboard both call these, so what the worker accepts and what the dashboard shows cannot drift.
 */

/**
 * The global emergency switch. "true" stops avatar work everywhere at once — nothing is recorded,
 * nothing is downloaded, nothing is served — whatever any project's feature switch says.
 */
export function avatarsGloballyDisabled(env: Record<string, string | undefined>): boolean {
  return /^(1|true|yes|on)$/i.test(env.WHATSAPP_AVATARS_DISABLED ?? "");
}

/** The only hosts a picture is ever fetched from: WhatsApp's own picture CDN. */
const PICTURE_HOST = /^(?:[a-z0-9-]+\.)*whatsapp\.net$/;
const MAX_URL_LENGTH = 2048;

/**
 * Whether a picture address may be fetched. Refuses anything that is not plain HTTPS to a
 * `*.whatsapp.net` host on the default port with no credentials — so an address carried in an event
 * can never point the worker at an internal service, another site, or an IP address (SSRF).
 */
export function isAllowedPictureUrl(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  if (url.port && url.port !== "443") return false;
  return PICTURE_HOST.test(url.hostname.toLowerCase());
}

/** A picture WhatsApp attached to an event: where it can be fetched, and WhatsApp's version tag. */
export interface PictureRef {
  url: string;
  /** Changes when the person or group changes their picture; null when WhatsApp gave none. */
  tag: string | null;
}

/**
 * Reads OpenWA's `profilePicThumbObj` (as carried on an incoming message). The small thumbnail
 * (`img`) is preferred — it is all an avatar needs — then the full picture. Anything that is not an
 * allowed address is dropped, so a missing, empty or unexpected object is simply "no picture".
 */
export function pictureRefFromThumb(thumb: unknown): PictureRef | null {
  if (!thumb || typeof thumb !== "object") return null;
  const t = thumb as Record<string, unknown>;
  const url = [t.img, t.eurl, t.imgFull].find(isAllowedPictureUrl);
  if (!url) return null;
  const tag = typeof t.tag === "string" && t.tag.trim() ? t.tag.trim().slice(0, 120) : null;
  return { url, tag };
}

/** Avatars are the thumbnail size; anything larger is refused rather than stored. */
export const WHATSAPP_PICTURE_LIMITS = { maxBytes: 100 * 1024, maxAttempts: 3 } as const;

export type PhoneSource = "WHATSAPP" | "TEAM_ROSTER" | "CLIENT_RECORD";

export type ContactPhone =
  | { state: "KNOWN"; phone: string; source: PhoneSource }
  | { state: "UNAVAILABLE"; reason: "HIDDEN_BY_WHATSAPP" | "NOT_A_PERSON" | "UNKNOWN_ID" };

export const PHONE_SOURCE_LABELS: Record<PhoneSource, string> = {
  WHATSAPP: "Provided by WhatsApp",
  TEAM_ROSTER: "From the Team Members record",
  CLIENT_RECORD: "From the linked client record",
};

/**
 * The phone number to show for a WhatsApp sender, and where it came from — evidence only, never a
 * guess. In order:
 *   1. WhatsApp itself named a phone number (`…@c.us`);
 *   2. the sender is a team member whose record holds a number somebody typed;
 *   3. the conversation is linked to a client whose record holds a number.
 * A LID (`…@lid`) is an opaque WhatsApp id, deliberately not a number: its digits are NEVER read as
 * one. With no evidence the answer is UNAVAILABLE, shown as "Phone number unavailable".
 */
export function resolveContactPhone(input: {
  senderPhone: string | null | undefined;
  senderJid?: string | null;
  rosterPhone?: { phoneNumber: string; whatsappId: string | null } | null;
  clientPhone?: string | null;
}): ContactPhone {
  const described = describeSenderId(input.senderPhone, input.senderJid);
  if (described.kind && !isPersonKind(described.kind)) return { state: "UNAVAILABLE", reason: "NOT_A_PERSON" };
  if (described.phone) return { state: "KNOWN", phone: described.phone, source: "WHATSAPP" };
  const typed = (value: string | null | undefined): string | null => {
    if (!value) return null;
    // A value equal to a WhatsApp id is the id stored as a placeholder, not a number anyone typed.
    const parsed = parseWhatsAppId(value);
    if (parsed && parsed.kind === "LID") return null;
    const digits = normalizePhoneNumber(value);
    return digits ? `+${digits}` : null;
  };
  const roster = input.rosterPhone;
  if (roster && (!roster.whatsappId || roster.phoneNumber.trim() !== roster.whatsappId.trim())) {
    const phone = typed(roster.phoneNumber);
    if (phone) return { state: "KNOWN", phone, source: "TEAM_ROSTER" };
  }
  const client = typed(input.clientPhone);
  if (client) return { state: "KNOWN", phone: client, source: "CLIENT_RECORD" };
  return { state: "UNAVAILABLE", reason: described.kind === "LID" ? "HIDDEN_BY_WHATSAPP" : "UNKNOWN_ID" };
}
