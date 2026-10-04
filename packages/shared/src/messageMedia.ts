import { MEDIA_PLACEHOLDER_LABELS } from "./mediaPlaceholders.js";

/**
 * WhatsApp Message & Media Storage (MEDIA_STORAGE.md): the decisions the worker and the dashboard
 * must agree on, kept here as pure functions so both read one answer and it can be tested without
 * WhatsApp, a database or a disk.
 *
 * Text is not configurable anywhere in this file: every message row is always stored. What is
 * decided here is only whether a message's FILE is fetched, how it is described, and for how long
 * it is kept.
 */

/** Mirrors the Prisma enum `MessageMediaType`. */
export const MESSAGE_MEDIA_TYPES = ["IMAGE", "VIDEO", "AUDIO", "DOCUMENT", "STICKER", "GIF", "OTHER"] as const;
export type MessageMediaKind = (typeof MESSAGE_MEDIA_TYPES)[number];

/** Mirrors the Prisma enum `MessageMediaStatus`. */
export const MESSAGE_MEDIA_STATUSES = ["PENDING", "DOWNLOADING", "STORED", "NOT_STORED", "FAILED", "DELETED"] as const;
export type MessageMediaState = (typeof MESSAGE_MEDIA_STATUSES)[number];

export const MESSAGE_MEDIA_TYPE_LABELS: Record<MessageMediaKind, string> = {
  IMAGE: "Images",
  VIDEO: "Videos",
  AUDIO: "Audio & voice messages",
  DOCUMENT: "Documents",
  STICKER: "Stickers",
  GIF: "GIFs",
  OTHER: "Other files",
};

/** What each switch covers, in the words an admin needs to decide. */
export const MESSAGE_MEDIA_TYPE_HINTS: Record<MessageMediaKind, string> = {
  IMAGE: "Photos and screenshots.",
  VIDEO: "Video messages. Usually the largest files by far.",
  AUDIO: "Voice notes and audio files.",
  DOCUMENT: "Any file sent as a document — PDF, Word, Excel, PowerPoint, ZIP, CSV, APK and anything else, whatever the extension.",
  STICKER: "WhatsApp stickers, including animated ones.",
  GIF: "WhatsApp GIFs (WhatsApp sends these as short looping videos).",
  OTHER: "Attachments WhatsApp did not label as one of the above.",
};

/** The settings column that switches each type. */
export const MESSAGE_MEDIA_SETTING_FIELD = {
  IMAGE: "storeImages",
  VIDEO: "storeVideos",
  AUDIO: "storeAudio",
  DOCUMENT: "storeDocuments",
  STICKER: "storeStickers",
  GIF: "storeGifs",
  OTHER: "storeOther",
} as const satisfies Record<MessageMediaKind, string>;

export type MediaStorageSwitches = { [K in (typeof MESSAGE_MEDIA_SETTING_FIELD)[MessageMediaKind]]: boolean };

/** What an absent settings row means: everything stored, kept indefinitely. */
export const DEFAULT_MEDIA_STORAGE_SWITCHES: MediaStorageSwitches = {
  storeImages: true,
  storeVideos: true,
  storeAudio: true,
  storeDocuments: true,
  storeStickers: true,
  storeGifs: true,
  storeOther: true,
};

const MB = 1024 * 1024;

/**
 * The largest file of each type this application will fetch. WhatsApp allows documents and videos
 * up to 2 GB; these are deliberately stricter, because the files land on a disk shared with the
 * database — a full disk stops Postgres too. A file over its limit is recorded NOT_STORED with
 * reason TOO_LARGE, never silently dropped.
 */
export const MEDIA_SIZE_LIMIT_BYTES: Record<MessageMediaKind, number> = {
  IMAGE: 32 * MB,
  VIDEO: 256 * MB,
  AUDIO: 64 * MB,
  DOCUMENT: 256 * MB,
  STICKER: 5 * MB,
  GIF: 64 * MB,
  OTHER: 256 * MB,
};

/**
 * WhatsApp's message type → what we store it as. Null means "not a file": a location or a contact
 * card is text-shaped and is already fully stored as the message body.
 *
 * - `ptt` (push-to-talk) is a voice note: AUDIO, with `waType` keeping the distinction.
 * - A GIF is WhatsApp's own looping mp4, flagged `isGif` on a video message.
 * - Anything else that carries a MIME type is a file WhatsApp did not label: OTHER, never guessed.
 */
export function classifyWhatsAppMedia(input: {
  waType: string | null | undefined;
  mimeType: string | null | undefined;
  isGif?: boolean | null;
}): MessageMediaKind | null {
  switch ((input.waType ?? "").toLowerCase()) {
    case "image":
      return "IMAGE";
    case "video":
      return input.isGif ? "GIF" : "VIDEO";
    case "audio":
    case "ptt":
      return "AUDIO";
    case "document":
      return "DOCUMENT";
    case "sticker":
      return "STICKER";
    case "chat":
    case "location":
    case "vcard":
    case "multi_vcard":
    case "revoked":
      return null;
    default:
      return input.mimeType ? "OTHER" : null;
  }
}

/** Short codes stored in `MessageMedia.statusReason`. */
export const MEDIA_STATUS_REASONS = [
  "SETTING_OFF",
  "TOO_LARGE",
  "NO_DOWNLOAD_INFO",
  "EXPIRED",
  "INTEGRITY",
  "DOWNLOAD_FAILED",
  "STORAGE_UNAVAILABLE",
  "DISK_LOW",
  "RETENTION",
  "MANUAL_CLEANUP",
] as const;
export type MediaStatusReason = (typeof MEDIA_STATUS_REASONS)[number];

export type MediaRegistrationDecision = { status: "PENDING" } | { status: "NOT_STORED"; reason: "SETTING_OFF" | "TOO_LARGE" };

/**
 * Whether a newly arrived attachment is queued for the worker, or recorded as not stored.
 *
 * The size check uses the size WhatsApp announced, so an oversized video is refused before a byte
 * of it is fetched. An unknown size is queued: the worker enforces the same limit while streaming.
 */
export function decideMediaRegistration(input: {
  type: MessageMediaKind;
  switches: MediaStorageSwitches;
  declaredSizeBytes: number | null;
}): MediaRegistrationDecision {
  if (!input.switches[MESSAGE_MEDIA_SETTING_FIELD[input.type]]) return { status: "NOT_STORED", reason: "SETTING_OFF" };
  if (input.declaredSizeBytes !== null && input.declaredSizeBytes > MEDIA_SIZE_LIMIT_BYTES[input.type]) {
    return { status: "NOT_STORED", reason: "TOO_LARGE" };
  }
  return { status: "PENDING" };
}

/** Retention choices offered on Settings. Null keeps everything; any other value is days. */
export const MEDIA_RETENTION_PRESETS: ReadonlyArray<{ days: number | null; label: string }> = [
  { days: null, label: "Keep everything (never delete)" },
  { days: 90, label: "Keep the last 3 months" },
  { days: 180, label: "Keep the last 6 months" },
  { days: 365, label: "Keep the last 12 months" },
];

/** A custom retention must be at least a week (anything shorter is almost certainly a typo) and at most ten years. */
export const MEDIA_RETENTION_MIN_DAYS = 7;
export const MEDIA_RETENTION_MAX_DAYS = 3650;

/** Validates a retention value from a form. Returns the days to store (null = keep everything) or an error. */
export function parseMediaRetentionDays(raw: string | null | undefined): { days: number | null } | { error: string } {
  const value = (raw ?? "").trim();
  if (value === "" || value === "never") return { days: null };
  if (!/^\d+$/.test(value)) return { error: "Retention must be a whole number of days." };
  const days = Number(value);
  if (days < MEDIA_RETENTION_MIN_DAYS || days > MEDIA_RETENTION_MAX_DAYS) {
    return { error: `Retention must be between ${MEDIA_RETENTION_MIN_DAYS} and ${MEDIA_RETENTION_MAX_DAYS} days.` };
  }
  return { days };
}

/** What a person types to confirm a manual media cleanup. */
export const MEDIA_CLEANUP_CONFIRMATION = "DELETE";

/** Files whose media row was created before this instant are past retention. */
export function mediaRetentionCutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

export function describeMediaRetention(days: number | null): string {
  if (days === null) return "Keep everything";
  const preset = MEDIA_RETENTION_PRESETS.find((p) => p.days === days);
  return preset ? preset.label : `Keep the last ${days} days`;
}

/**
 * The caption a person typed, with the provider's "[Image]" / "[Document] name" label removed —
 * once the attachment itself is drawn, the label says nothing. Null when there is no caption.
 * A body that does not start with a label is returned unchanged.
 */
export function mediaCaption(body: string, type: MessageMediaKind | null): string | null {
  const trimmed = body.trim();
  const label = MEDIA_PLACEHOLDER_LABELS.find((l) => trimmed === l || trimmed.startsWith(`${l} `));
  if (!label) return trimmed || null;
  // "[Document] report.pdf" carries the file NAME, not a caption — the card shows the name already.
  if (label === "[Document]" && type === "DOCUMENT") return null;
  const rest = trimmed.slice(label.length).trim();
  return rest || null;
}

/** True when a stored body is one of the provider's media labels — a message that carried a file. */
export function isMediaPlaceholderBody(body: string): boolean {
  const trimmed = body.trim();
  return MEDIA_PLACEHOLDER_LABELS.some(
    (l) => l !== "[Location]" && l !== "[Contact card]" && (trimmed === l || trimmed.startsWith(`${l} `)),
  );
}

/**
 * How a stored file may be shown in the browser. Only types a browser renders as media are served
 * inline; everything else is a download, so an HTML or SVG file a customer sent can never run in
 * the dashboard's origin. PDF opens in the browser's own viewer.
 */
export type MediaInlineKind = "image" | "video" | "audio" | "pdf";

const INLINE_MIME: Record<string, MediaInlineKind> = {
  "image/jpeg": "image",
  "image/png": "image",
  "image/webp": "image",
  "image/gif": "image",
  "video/mp4": "video",
  "video/3gpp": "video",
  "video/webm": "video",
  "video/quicktime": "video",
  "audio/ogg": "audio",
  "audio/mpeg": "audio",
  "audio/mp4": "audio",
  "audio/aac": "audio",
  "audio/amr": "audio",
  "audio/webm": "audio",
  "audio/wav": "audio",
  "audio/x-wav": "audio",
  "application/pdf": "pdf",
};

/** The media kind of a MIME type for inline display, or null when it must be downloaded instead. */
export function inlineMediaKind(mimeType: string | null | undefined): MediaInlineKind | null {
  if (!mimeType) return null;
  const base = mimeType.split(";")[0]!.trim().toLowerCase();
  return INLINE_MIME[base] ?? null;
}

/** "18.7 GB", "2.4 MB", "512 KB", "40 bytes". */
export function formatMediaBytes(bytes: number | bigint | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  const n = Number(bytes);
  if (n < 1024) return `${n} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** "0:32", "2:14", "1:02:09". */
export function formatMediaDuration(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return null;
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
