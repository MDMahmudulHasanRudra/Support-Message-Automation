/**
 * Sending a file from WhatsApp Chat (CHAT_FILE_SENDING.md): which files may go, how WhatsApp is asked
 * to show each, and the limits. Pure — the upload route decides with it, and the worker checks the
 * queued row against it again before anything is sent.
 *
 * The type is read from the file's own bytes, never from its name or what the browser claimed. A file
 * whose bytes and name disagree in a way that matters (a program named .pdf) is refused.
 */

/** How WhatsApp shows the file. */
export type OutgoingFileKind = "IMAGE" | "VIDEO" | "AUDIO" | "VOICE" | "DOCUMENT";

/** What the person asked for: the natural form, a plain file (no preview), or a voice note. */
export type OutgoingFileMode = "AUTO" | "DOCUMENT" | "VOICE";

/**
 * Size ceilings, per kind. Below WhatsApp's own limits on purpose: the file crosses into the browser
 * session on the server, and a smaller ceiling keeps one send from holding the queue for long.
 */
export const OUTGOING_FILE_LIMITS: Record<OutgoingFileKind, number> = {
  IMAGE: 10 * 1024 * 1024,
  VIDEO: 16 * 1024 * 1024,
  AUDIO: 16 * 1024 * 1024,
  VOICE: 16 * 1024 * 1024,
  DOCUMENT: 16 * 1024 * 1024,
};
export const OUTGOING_FILE_MAX_BYTES = 16 * 1024 * 1024;
export const OUTGOING_CAPTION_MAX = 1024;

/** Programs and scripts never go to a customer, whatever they are called. */
const BLOCKED_EXTENSIONS = new Set([
  "exe", "msi", "bat", "cmd", "com", "scr", "pif", "cpl", "dll", "sys", "vbs", "vbe", "js", "jse", "ws", "wsf", "wsh",
  "ps1", "psm1", "sh", "bash", "apk", "aab", "ipa", "jar", "app", "dmg", "pkg", "deb", "rpm", "lnk", "hta", "reg",
  "iso", "img", "html", "htm", "svg", "xhtml", "php", "py", "rb", "pl",
]);

interface Sniffed {
  mimeType: string;
  /** The kinds this file may be sent as, natural one first. */
  kinds: OutgoingFileKind[];
  /** Extensions that name this type; a different one is renamed, never trusted. */
  extensions: string[];
}

const ascii = (bytes: Uint8Array, start: number, length: number) =>
  String.fromCharCode(...bytes.subarray(start, start + length));
const startsWith = (bytes: Uint8Array, sig: number[], offset = 0) => sig.every((b, i) => bytes[offset + i] === b);

/** Office documents are ZIP files; which one is told by the name, after the bytes said ZIP. */
const OOXML: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const OLE: Record<string, string> = { doc: "application/msword", xls: "application/vnd.ms-excel", ppt: "application/vnd.ms-powerpoint" };

export function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
}

/** Reads the type from the first bytes (at least 64 are needed). Null = not a type this sends. */
export function sniffOutgoingFile(head: Uint8Array, fileName: string): Sniffed | null {
  const ext = fileExtension(fileName);
  if (startsWith(head, [0xff, 0xd8, 0xff])) return { mimeType: "image/jpeg", kinds: ["IMAGE", "DOCUMENT"], extensions: ["jpg", "jpeg"] };
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mimeType: "image/png", kinds: ["IMAGE", "DOCUMENT"], extensions: ["png"] };
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WEBP") return { mimeType: "image/webp", kinds: ["IMAGE", "DOCUMENT"], extensions: ["webp"] };
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WAVE") return { mimeType: "audio/wav", kinds: ["AUDIO", "DOCUMENT"], extensions: ["wav"] };
  if (ascii(head, 4, 4) === "ftyp") {
    const brand = ascii(head, 8, 4);
    if (/^M4A|^M4B/.test(brand)) return { mimeType: "audio/mp4", kinds: ["AUDIO", "DOCUMENT"], extensions: ["m4a"] };
    if (/^qt/.test(brand)) return { mimeType: "video/quicktime", kinds: ["DOCUMENT"], extensions: ["mov"] };
    if (/^3gp|^3g2/.test(brand)) return { mimeType: "video/3gpp", kinds: ["VIDEO", "DOCUMENT"], extensions: ["3gp"] };
    return { mimeType: "video/mp4", kinds: ["VIDEO", "DOCUMENT"], extensions: ["mp4", "m4v"] };
  }
  if (ascii(head, 0, 4) === "OggS") {
    // Opus in Ogg is what a WhatsApp voice note is; other Ogg audio goes as an audio file.
    const opus = ascii(head, 28, 8) === "OpusHead";
    return { mimeType: "audio/ogg", kinds: opus ? ["AUDIO", "VOICE", "DOCUMENT"] : ["AUDIO", "DOCUMENT"], extensions: ["ogg", "opus", "oga"] };
  }
  if (ascii(head, 0, 3) === "ID3" || (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0 && ext === "mp3")) {
    return { mimeType: "audio/mpeg", kinds: ["AUDIO", "DOCUMENT"], extensions: ["mp3"] };
  }
  if (ascii(head, 0, 5) === "%PDF-") return { mimeType: "application/pdf", kinds: ["DOCUMENT"], extensions: ["pdf"] };
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) {
    if (OOXML[ext]) return { mimeType: OOXML[ext]!, kinds: ["DOCUMENT"], extensions: [ext] };
    return { mimeType: "application/zip", kinds: ["DOCUMENT"], extensions: ["zip"] };
  }
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) && OLE[ext]) return { mimeType: OLE[ext]!, kinds: ["DOCUMENT"], extensions: [ext] };
  if (ascii(head, 0, 5) === "{\\rtf") return { mimeType: "application/rtf", kinds: ["DOCUMENT"], extensions: ["rtf"] };
  // Plain text (txt, csv): no NUL bytes and no program header in what was read.
  if ((ext === "txt" || ext === "csv") && head.length > 0 && !head.includes(0) && ascii(head, 0, 2) !== "#!") {
    return { mimeType: ext === "csv" ? "text/csv" : "text/plain", kinds: ["DOCUMENT"], extensions: [ext] };
  }
  return null;
}

/** A file name safe to hand to WhatsApp: no path, no control characters, a sensible length. */
export function sanitizeFileName(raw: string, fallbackExt: string): string {
  const base = String(raw ?? "")
    .split(/[\\/]/)
    .pop()!
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  const name = base && !/^\.+$/.test(base) ? base : `file.${fallbackExt}`;
  return name;
}

export type OutgoingFilePlan =
  | { ok: true; kind: OutgoingFileKind; mimeType: string; fileName: string }
  | { ok: false; error: string };

const KIND_LABEL: Record<OutgoingFileKind, string> = { IMAGE: "photo", VIDEO: "video", AUDIO: "audio file", VOICE: "voice note", DOCUMENT: "document" };

/** Decides whether this file may be sent, and how. */
export function planOutgoingFile(input: { head: Uint8Array; fileName: string; size: number; mode: OutgoingFileMode }): OutgoingFilePlan {
  if (!(input.size > 0)) return { ok: false, error: "The file is empty." };
  if (input.size > OUTGOING_FILE_MAX_BYTES) return { ok: false, error: `The file is larger than ${OUTGOING_FILE_MAX_BYTES / 1024 / 1024} MB. Send a smaller one.` };
  const ext = fileExtension(input.fileName);
  if (BLOCKED_EXTENSIONS.has(ext)) return { ok: false, error: `A .${ext} file cannot be sent from here: programs, scripts and web pages are never sent to a customer.` };
  if (startsWith(input.head, [0x4d, 0x5a]) || startsWith(input.head, [0x7f, 0x45, 0x4c, 0x46]) || ascii(input.head, 0, 2) === "#!") {
    return { ok: false, error: "This file is a program, so it cannot be sent from here." };
  }
  const sniffed = sniffOutgoingFile(input.head, input.fileName);
  if (!sniffed) {
    return { ok: false, error: "This type of file cannot be sent from here. Photos (JPEG, PNG, WebP), videos (MP4), audio (MP3, M4A, OGG, WAV) and documents (PDF, Word, Excel, PowerPoint, text, CSV, ZIP) can." };
  }
  const kind: OutgoingFileKind | undefined =
    input.mode === "DOCUMENT" ? "DOCUMENT" : input.mode === "VOICE" ? (sniffed.kinds.includes("VOICE") ? "VOICE" : undefined) : sniffed.kinds[0];
  if (!kind) return { ok: false, error: "Only an Opus audio file (.ogg / .opus) can be sent as a voice note. Send it as an audio file instead." };
  if (input.size > OUTGOING_FILE_LIMITS[kind]) {
    return { ok: false, error: `A ${KIND_LABEL[kind]} can be at most ${OUTGOING_FILE_LIMITS[kind] / 1024 / 1024} MB.` };
  }
  // The name keeps what the person called it, with an extension that matches what the file IS.
  let fileName = sanitizeFileName(input.fileName, sniffed.extensions[0]!);
  if (!sniffed.extensions.includes(fileExtension(fileName))) fileName = `${fileName}.${sniffed.extensions[0]}`;
  return { ok: true, kind, mimeType: sniffed.mimeType, fileName };
}

/** What a queued file row carries in `OutboundMessage.content`. */
export interface OutgoingFileContent {
  storageKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  kind: OutgoingFileKind;
  caption: string;
}

/** The worker's re-check of a queued row: everything it names, before a byte is read. */
export function validateOutgoingFileContent(raw: unknown, projectId: string): { ok: true; value: OutgoingFileContent } | { ok: false; error: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const kind = r.kind as OutgoingFileKind;
  if (!(kind in OUTGOING_FILE_LIMITS)) return { ok: false, error: "The file has no known way to be sent." };
  const storageKey = typeof r.storageKey === "string" ? r.storageKey : "";
  if (!storageKey.startsWith(`outbound/${projectId}/`) || storageKey.includes("..")) return { ok: false, error: "The file is not this project's." };
  const sizeBytes = typeof r.sizeBytes === "number" ? r.sizeBytes : 0;
  if (!(sizeBytes > 0) || sizeBytes > OUTGOING_FILE_LIMITS[kind]) return { ok: false, error: "The file is larger than allowed." };
  const fileName = typeof r.fileName === "string" ? r.fileName : "";
  if (!fileName || fileName !== sanitizeFileName(fileName, "bin") || BLOCKED_EXTENSIONS.has(fileExtension(fileName))) return { ok: false, error: "The file name is not allowed." };
  const mimeType = typeof r.mimeType === "string" ? r.mimeType : "";
  if (!/^[a-z]+\/[a-z0-9.+-]+$/.test(mimeType)) return { ok: false, error: "The file type is not allowed." };
  const caption = typeof r.caption === "string" ? r.caption.slice(0, OUTGOING_CAPTION_MAX) : "";
  return { ok: true, value: { storageKey, fileName, mimeType, sizeBytes, kind, caption } };
}

/** The readable line a queued file shows in the thread, the delivery log and search. */
export function outgoingFileSummary(kind: OutgoingFileKind, fileName: string, caption: string): string {
  const label = { IMAGE: "[Photo]", VIDEO: "[Video]", AUDIO: "[Audio]", VOICE: "[Voice note]", DOCUMENT: "[Document]" }[kind];
  const text = caption.trim() || (kind === "DOCUMENT" || kind === "AUDIO" ? fileName : "");
  return text ? `${label} ${text.length > 500 ? `${text.slice(0, 500)}…` : text}` : label;
}

/** The storage key for a file a person sends: ids only, under the project. */
export function buildOutgoingFileKey(input: { projectId: string; accountId: string; id: string; createdAt: Date }): string {
  const yyyy = String(input.createdAt.getUTCFullYear());
  const mm = String(input.createdAt.getUTCMonth() + 1).padStart(2, "0");
  return ["outbound", input.projectId, input.accountId, yyyy, mm, input.id].join("/");
}
