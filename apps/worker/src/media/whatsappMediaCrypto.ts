import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, timingSafeEqual, type Decipher, type Hash, type Hmac } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";

/**
 * Decrypting a WhatsApp attachment, as a stream.
 *
 * WhatsApp stores every attachment on its media servers encrypted, and gives each recipient a
 * per-file media key. The scheme is the one OpenWA's own `@open-wa/wa-decrypt` implements (and
 * `whatsappMediaCrypto.test.ts` checks this against it on the same file):
 *
 *   expanded   = HKDF-SHA256(mediaKey, salt = 32 zero bytes, info = "WhatsApp <Kind> Keys", 112 bytes)
 *   iv         = expanded[0..16]   cipherKey = expanded[16..48]   macKey = expanded[48..80]
 *   file       = AES-256-CBC(plaintext) ‖ HMAC-SHA256(macKey, iv ‖ ciphertext)[0..10]
 *
 * Why not just call `wa-decrypt`: it reads the whole file into memory and then converts it to a
 * hex string and to a JavaScript array of numbers one byte at a time — a 100 MB video becomes
 * several gigabytes of heap. This does the same arithmetic on a stream, so memory stays flat
 * whatever the file size, and it also checks what that library skips: the MAC (the file is the
 * one WhatsApp sent, unaltered) and the padding.
 */

export type WhatsAppMediaKeyKind = "Image" | "Video" | "Audio" | "Document";

/** The HKDF "info" WhatsApp uses for a message type. Stickers are images, GIFs and voice notes are video and audio. */
export function mediaKeyKindFor(waType: string, mimeType: string | null): WhatsAppMediaKeyKind {
  switch (waType.toLowerCase()) {
    case "image":
    case "sticker":
      return "Image";
    case "video":
      return "Video";
    case "audio":
    case "ptt":
      return "Audio";
    case "document":
      return "Document";
    default: {
      const mime = (mimeType ?? "").toLowerCase();
      if (mime.startsWith("image/")) return "Image";
      if (mime.startsWith("video/")) return "Video";
      if (mime.startsWith("audio/")) return "Audio";
      return "Document";
    }
  }
}

export interface WhatsAppMediaKeys {
  iv: Buffer;
  cipherKey: Buffer;
  macKey: Buffer;
}

export function deriveMediaKeys(mediaKeyBase64: string, kind: WhatsAppMediaKeyKind): WhatsAppMediaKeys {
  const mediaKey = Buffer.from(mediaKeyBase64, "base64");
  if (mediaKey.length !== 32) throw new MediaIntegrityError("The media key WhatsApp gave is not 32 bytes.");
  const expanded = Buffer.from(hkdfSync("sha256", mediaKey, Buffer.alloc(32), `WhatsApp ${kind} Keys`, 112));
  return { iv: expanded.subarray(0, 16), cipherKey: expanded.subarray(16, 48), macKey: expanded.subarray(48, 80) };
}

/** The file is not the one WhatsApp sent: a bad MAC, bad padding, a truncated download or a hash mismatch. */
export class MediaIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaIntegrityError";
  }
}

const MAC_LENGTH = 10;

/**
 * Encrypted bytes in, decrypted bytes out. The trailing 10-byte MAC is held back as it streams
 * past, and checked at the end; a mismatch fails the stream, which makes the storage write that
 * consumes it fail and leave nothing behind.
 */
export class WhatsAppMediaDecryptor extends Transform {
  private tail = Buffer.alloc(0);
  private readonly hmac: Hmac;
  private readonly decipher: Decipher;
  private readonly plainHash: Hash = createHash("sha256");
  private readonly encHash: Hash = createHash("sha256");
  plainBytes = 0;
  /** Set once the stream has ended successfully. */
  result: { sha256Hex: string; sha256Base64: string; encSha256Base64: string; size: number } | null = null;

  constructor(keys: WhatsAppMediaKeys) {
    super();
    this.hmac = createHmac("sha256", keys.macKey).update(keys.iv);
    this.decipher = createDecipheriv("aes-256-cbc", keys.cipherKey, keys.iv);
  }

  private pushPlain(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.plainHash.update(chunk);
    this.plainBytes += chunk.length;
    this.push(chunk);
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.encHash.update(chunk);
      const data = this.tail.length ? Buffer.concat([this.tail, chunk]) : chunk;
      if (data.length <= MAC_LENGTH) {
        this.tail = Buffer.from(data);
        callback();
        return;
      }
      const body = data.subarray(0, data.length - MAC_LENGTH);
      this.tail = Buffer.from(data.subarray(data.length - MAC_LENGTH));
      this.hmac.update(body);
      this.pushPlain(this.decipher.update(body));
      callback();
    } catch (err) {
      callback(err as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      if (this.tail.length !== MAC_LENGTH) throw new MediaIntegrityError("The downloaded file was cut short.");
      const expected = this.hmac.digest().subarray(0, MAC_LENGTH);
      if (!timingSafeEqual(expected, this.tail)) {
        throw new MediaIntegrityError("The downloaded file failed WhatsApp's integrity check (MAC mismatch).");
      }
      let last: Buffer;
      try {
        last = this.decipher.final();
      } catch {
        throw new MediaIntegrityError("The downloaded file could not be decrypted (bad padding).");
      }
      this.pushPlain(last);
      const digest = this.plainHash.digest();
      this.result = {
        sha256Hex: digest.toString("hex"),
        sha256Base64: digest.toString("base64"),
        encSha256Base64: this.encHash.digest("base64"),
        size: this.plainBytes,
      };
      callback();
    } catch (err) {
      callback(err as Error);
    }
  }
}

/** For tests and fixtures: encrypts a file exactly as WhatsApp does. */
export function encryptLikeWhatsApp(plaintext: Buffer, mediaKeyBase64: string, kind: WhatsAppMediaKeyKind): Buffer {
  const { iv, cipherKey, macKey } = deriveMediaKeys(mediaKeyBase64, kind);
  const cipher = createCipheriv("aes-256-cbc", cipherKey, iv);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const mac = createHmac("sha256", macKey).update(iv).update(enc).digest().subarray(0, MAC_LENGTH);
  return Buffer.concat([enc, mac]);
}
