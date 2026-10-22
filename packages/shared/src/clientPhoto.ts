/**
 * Client profile photos (CLIENTS_V3.md §6): pure checks on the uploaded bytes.
 *
 * The browser already shrinks a chosen picture to a small square WebP before it is sent, but the server
 * trusts none of that: the type is read from the bytes, the size and dimensions are capped, and every
 * metadata block (EXIF with the camera's GPS position, XMP, text comments) is removed before anything is
 * stored. What is stored is a bounded thumbnail, never the original file and never base64.
 */

export const CLIENT_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type ClientPhotoType = (typeof CLIENT_PHOTO_TYPES)[number];

/** The stored thumbnail's limits. The browser sends ~256 px; these leave room without allowing a full photo. */
export const CLIENT_PHOTO_LIMITS = { maxBytes: 200 * 1024, maxDimension: 1024, minDimension: 16 } as const;

/** The type, from the bytes — never from the file name or what the browser claimed. */
export function sniffClientPhoto(bytes: Uint8Array): ClientPhotoType | null {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

const u16be = (b: Uint8Array, i: number) => ((b[i]! << 8) | b[i + 1]!) >>> 0;
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const u32le = (b: Uint8Array, i: number) => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;
const fourcc = (b: Uint8Array, i: number) => String.fromCharCode(b[i]!, b[i + 1]!, b[i + 2]!, b[i + 3]!);

/** Width and height from the image's own header, or null when the header cannot be read. */
export function readPhotoSize(bytes: Uint8Array, type: ClientPhotoType): { width: number; height: number } | null {
  try {
    if (type === "image/png") {
      if (bytes.length < 24 || fourcc(bytes, 12) !== "IHDR") return null;
      return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
    }
    if (type === "image/jpeg") {
      let i = 2;
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) return null;
        const marker = bytes[i + 1]!;
        if (marker === 0xff) {
          i += 1;
          continue;
        }
        const len = u16be(bytes, i + 2);
        // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: u16be(bytes, i + 5), width: u16be(bytes, i + 7) };
        }
        if (marker === 0xda) return null;
        i += 2 + len;
      }
      return null;
    }
    // WebP
    let i = 12;
    while (i + 8 <= bytes.length) {
      const id = fourcc(bytes, i);
      const size = u32le(bytes, i + 4);
      const d = i + 8;
      if (id === "VP8X" && size >= 10) return { width: 1 + (bytes[d + 4]! | (bytes[d + 5]! << 8) | (bytes[d + 6]! << 16)), height: 1 + (bytes[d + 7]! | (bytes[d + 8]! << 8) | (bytes[d + 9]! << 16)) };
      if (id === "VP8 " && size >= 10 && bytes[d + 3] === 0x9d && bytes[d + 4] === 0x01 && bytes[d + 5] === 0x2a) {
        return { width: (bytes[d + 6]! | (bytes[d + 7]! << 8)) & 0x3fff, height: (bytes[d + 8]! | (bytes[d + 9]! << 8)) & 0x3fff };
      }
      if (id === "VP8L" && size >= 5 && bytes[d] === 0x2f) {
        const bits = u32le(bytes, d + 1);
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      }
      i = d + size + (size % 2);
    }
    return null;
  } catch {
    return null;
  }
}

const PNG_KEEP = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "sBIT", "pHYs"]);

/**
 * The same image with every metadata block removed: PNG text/EXIF/time chunks, JPEG APP1–APP13/APP15
 * (EXIF, XMP, IPTC…) and comments, WebP EXIF/XMP chunks (and their VP8X flags). Pixels are untouched.
 * Null when the structure is not what its header claims — such a file is refused, not stored.
 */
export function stripPhotoMetadata(bytes: Uint8Array, type: ClientPhotoType): Uint8Array | null {
  try {
    const parts: Uint8Array[] = [];
    if (type === "image/png") {
      parts.push(bytes.subarray(0, 8));
      let i = 8;
      let ended = false;
      while (i + 12 <= bytes.length) {
        const len = u32be(bytes, i);
        const id = fourcc(bytes, i + 4);
        const end = i + 12 + len;
        if (end > bytes.length) return null;
        if (PNG_KEEP.has(id)) parts.push(bytes.subarray(i, end));
        i = end;
        if (id === "IEND") {
          ended = true;
          break;
        }
      }
      if (!ended) return null;
    } else if (type === "image/jpeg") {
      parts.push(bytes.subarray(0, 2));
      let i = 2;
      let scanned = false;
      while (i + 4 <= bytes.length) {
        if (bytes[i] !== 0xff) return null;
        const marker = bytes[i + 1]!;
        if (marker === 0xff) {
          i += 1;
          continue;
        }
        if (marker === 0xda) {
          // Start of scan: the rest is image data, copied as it is.
          parts.push(bytes.subarray(i));
          scanned = true;
          break;
        }
        const end = i + 2 + u16be(bytes, i + 2);
        if (end > bytes.length) return null;
        const isMetadata = (marker >= 0xe1 && marker <= 0xed) || marker === 0xef || marker === 0xfe;
        if (!isMetadata) parts.push(bytes.subarray(i, end));
        i = end;
      }
      if (!scanned) return null;
    } else {
      const chunks: Uint8Array[] = [];
      let i = 12;
      while (i + 8 <= bytes.length) {
        const id = fourcc(bytes, i);
        const size = u32le(bytes, i + 4);
        const end = i + 8 + size + (size % 2);
        if (i + 8 + size > bytes.length) return null;
        if (id === "EXIF" || id === "XMP ") {
          i = end;
          continue;
        }
        const chunk = bytes.slice(i, Math.min(end, bytes.length));
        if (id === "VP8X" && chunk.length > 8) chunk[8] = chunk[8]! & ~0x0c; // clear the EXIF (0x08) and XMP (0x04) flags
        chunks.push(chunk);
        i = end;
      }
      if (!chunks.length) return null;
      const bodyLength = 4 + chunks.reduce((n, c) => n + c.length, 0);
      const header = new Uint8Array(12);
      header.set([0x52, 0x49, 0x46, 0x46], 0);
      header[4] = bodyLength & 0xff;
      header[5] = (bodyLength >>> 8) & 0xff;
      header[6] = (bodyLength >>> 16) & 0xff;
      header[7] = (bodyLength >>> 24) & 0xff;
      header.set([0x57, 0x45, 0x42, 0x50], 8);
      parts.push(header, ...chunks);
    }
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  } catch {
    return null;
  }
}

/** Everything a stored photo must satisfy, in one place: the bytes ready to store, or the reason they are not. */
export function prepareClientPhoto(bytes: Uint8Array): { ok: true; bytes: Uint8Array; type: ClientPhotoType; width: number; height: number } | { ok: false; error: string } {
  if (bytes.length === 0) return { ok: false, error: "The picture is empty." };
  if (bytes.length > CLIENT_PHOTO_LIMITS.maxBytes) return { ok: false, error: `The picture is larger than ${CLIENT_PHOTO_LIMITS.maxBytes / 1024} KB after resizing. Choose a smaller one.` };
  const type = sniffClientPhoto(bytes);
  if (!type) return { ok: false, error: "Only JPEG, PNG and WebP pictures are accepted." };
  const size = readPhotoSize(bytes, type);
  if (!size) return { ok: false, error: "The picture could not be read." };
  const { maxDimension, minDimension } = CLIENT_PHOTO_LIMITS;
  if (size.width > maxDimension || size.height > maxDimension) return { ok: false, error: `The picture is larger than ${maxDimension}×${maxDimension} pixels.` };
  if (size.width < minDimension || size.height < minDimension) return { ok: false, error: "The picture is too small." };
  const clean = stripPhotoMetadata(bytes, type);
  if (!clean) return { ok: false, error: "The picture's file structure is damaged." };
  return { ok: true, bytes: clean, type, ...size };
}

/** Two initials for an avatar without a photo: "Orchid Networks" → "ON"; a code-only client → "CL". */
export function clientInitials(name: string, companyName: string | null, code: string): string {
  const source = name.trim() || companyName?.trim();
  if (!source) return code.replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase() || "#";
  const words = source.split(/[\s._-]+/u).filter((w) => /\p{L}|\p{N}/u.test(w));
  const letters = words.length >= 2 ? [words[0]!, words[1]!].map((w) => [...w][0]) : [...(words[0] ?? "?")].slice(0, 2);
  return letters.join("").toUpperCase();
}

/** What to call a client on screen. A client saved with only a generated code is "Unnamed client". */
export function clientDisplayName(name: string, companyName?: string | null): string {
  return name.trim() || companyName?.trim() || "Unnamed client";
}
