import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { MediaTooLargeError, type MediaStorage } from "@support-automation/media-storage";
import type { MediaDownloadInfo } from "../pipeline/types.js";
import { deriveMediaKeys, MediaIntegrityError, mediaKeyKindFor, WhatsAppMediaDecryptor } from "./whatsappMediaCrypto.js";

/**
 * Fetches one encrypted attachment from WhatsApp's media servers, decrypts it on the way through,
 * and writes the original file to media storage — streamed end to end, so a 200 MB video never
 * sits in memory.
 *
 * The request goes to the same CDN URL the WhatsApp Web session would use, with the same headers
 * OpenWA's own decryption module sends. It needs no browser and no live session — which is what
 * lets a download finish even if the account drops a minute after the message arrived.
 */

/** WhatsApp's media host, for a message that carries only a `directPath`. */
const MEDIA_HOST = "https://mmg.whatsapp.net";

const HEADERS = {
  "User-Agent":
    "WhatsApp/2.16.352 Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/81.0.4044.92 Safari/537.36",
  Origin: "https://web.whatsapp.com",
  Referer: "https://web.whatsapp.com/",
};

/** WhatsApp no longer has the file (404/410). Retrying cannot help. */
export class MediaExpiredError extends Error {
  constructor(status: number) {
    super(`WhatsApp no longer has this file (HTTP ${status}).`);
    this.name = "MediaExpiredError";
  }
}

/** Anything that may pass: a timeout, a dropped connection, a 5xx. */
export class MediaDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaDownloadError";
  }
}

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

/** The URLs to try, in order: WhatsApp's own full URL, then one built from the direct path. */
export function mediaDownloadUrls(info: Pick<MediaDownloadInfo, "url" | "directPath">): string[] {
  const urls: string[] = [];
  if (info.url && /^https:\/\//i.test(info.url)) urls.push(info.url.trim());
  if (info.directPath && info.directPath.startsWith("/")) urls.push(`${MEDIA_HOST}${info.directPath}`);
  return [...new Set(urls)];
}

/** Two minutes, plus a second per megabyte announced, capped at half an hour. */
export function downloadTimeoutMs(declaredSizeBytes: number | null): number {
  const mb = declaredSizeBytes ? declaredSizeBytes / (1024 * 1024) : 0;
  return Math.min(30 * 60_000, 120_000 + Math.ceil(mb) * 1_000);
}

export interface StoredMediaFile {
  size: number;
  sha256Hex: string;
}

export async function fetchAndStoreWhatsAppMedia(input: {
  info: MediaDownloadInfo;
  waType: string;
  mimeType: string | null;
  declaredSizeBytes: number | null;
  maxBytes: number;
  storage: MediaStorage;
  storageKey: string;
  fetchImpl?: FetchLike;
}): Promise<StoredMediaFile> {
  const urls = mediaDownloadUrls(input.info);
  if (urls.length === 0) throw new MediaDownloadError("WhatsApp gave no address to download this file from.");
  const keys = deriveMediaKeys(input.info.mediaKey, mediaKeyKindFor(input.waType, input.mimeType));
  const doFetch: FetchLike = input.fetchImpl ?? ((url, init) => fetch(url, init));

  let lastError: Error = new MediaDownloadError("The file could not be downloaded.");
  for (const url of urls) {
    const signal = AbortSignal.timeout(downloadTimeoutMs(input.declaredSizeBytes));
    let response: Response;
    try {
      response = await doFetch(url, { headers: HEADERS, signal });
    } catch (err) {
      // undici reports every network failure as "fetch failed" and keeps the reason in `cause`.
      const cause = (err as { cause?: { message?: string; code?: string } }).cause;
      const detail = cause ? `${(err as Error).message} (${cause.code ?? cause.message ?? "unknown cause"})` : (err as Error).message;
      lastError = new MediaDownloadError(`The download did not complete: ${detail}`);
      continue;
    }
    if (response.status === 404 || response.status === 410) {
      lastError = new MediaExpiredError(response.status);
      await response.body?.cancel().catch(() => undefined);
      continue;
    }
    if (!response.ok || !response.body) {
      lastError = new MediaDownloadError(`WhatsApp's media server answered HTTP ${response.status}.`);
      await response.body?.cancel().catch(() => undefined);
      continue;
    }
    // The encrypted file is the plaintext rounded up to a 16-byte block plus a 10-byte MAC.
    const announced = Number(response.headers.get("content-length") ?? NaN);
    if (Number.isFinite(announced) && announced > input.maxBytes + 26) {
      await response.body.cancel().catch(() => undefined);
      throw new MediaTooLargeError(input.maxBytes);
    }

    const decryptor = new WhatsAppMediaDecryptor(keys);
    const source = Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>);
    // `pipe` does not carry a network error forward, so a dropped connection would otherwise leave
    // the write waiting for an end that never comes.
    source.on("error", (err) => decryptor.destroy(new MediaDownloadError(`The download did not complete: ${err.message}`)));
    try {
      await input.storage.put(input.storageKey, source.pipe(decryptor), { maxBytes: input.maxBytes });
    } catch (err) {
      source.destroy();
      throw err;
    }
    const result = decryptor.result;
    if (!result) {
      await input.storage.delete(input.storageKey).catch(() => undefined);
      throw new MediaIntegrityError("The downloaded file could not be verified.");
    }
    // WhatsApp's own hash of the original: the stored file must be byte-for-byte the one sent.
    if (input.info.filehash && input.info.filehash !== result.sha256Base64) {
      await input.storage.delete(input.storageKey).catch(() => undefined);
      throw new MediaIntegrityError("The downloaded file does not match WhatsApp's checksum.");
    }
    return { size: result.size, sha256Hex: result.sha256Hex };
  }
  throw lastError;
}
