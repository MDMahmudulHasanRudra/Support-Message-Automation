import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalMediaStorage, MediaTooLargeError } from "@support-automation/media-storage";
import {
  deriveMediaKeys,
  encryptLikeWhatsApp,
  MediaIntegrityError,
  mediaKeyKindFor,
  WhatsAppMediaDecryptor,
} from "../media/whatsappMediaCrypto.js";
import { fetchAndStoreWhatsAppMedia, MediaExpiredError, mediaDownloadUrls } from "../media/fetchWhatsAppMedia.js";

/**
 * The decryption is checked against OpenWA's OWN module (`@open-wa/wa-decrypt`, what the library's
 * `decryptMedia` calls), on the same encrypted file served over HTTP. That is the reason to trust a
 * second implementation at all: the two must produce the same bytes. Loaded by path from the
 * library's own dependencies — nothing in the worker imports it.
 */
const waDecrypt = createRequire(createRequire(import.meta.url).resolve("@open-wa/wa-automate"))("@open-wa/wa-decrypt") as {
  decryptMedia: (message: Record<string, unknown>) => Promise<Buffer>;
};

const files = new Map<string, { status: number; body: Buffer }>();
let server: Server;
let base: string;
let root: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const file = files.get(req.url ?? "");
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(file.status, { "content-length": file.body.length }).end(file.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  root = await mkdtemp(path.join(tmpdir(), "wa-media-"));
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});

async function decryptAll(encrypted: Buffer, mediaKey: string, kind: "Image" | "Video" | "Audio" | "Document"): Promise<{ plain: Buffer; d: WhatsAppMediaDecryptor }> {
  const d = new WhatsAppMediaDecryptor(deriveMediaKeys(mediaKey, kind));
  // Odd chunk sizes, so the MAC straddles chunk boundaries the way a network delivers it.
  const chunks: Buffer[] = [];
  for (let i = 0; i < encrypted.length; i += 777) chunks.push(encrypted.subarray(i, i + 777));
  const out: Buffer[] = [];
  for await (const chunk of Readable.from(chunks).pipe(d)) out.push(chunk as Buffer);
  return { plain: Buffer.concat(out), d };
}

const sha256b64 = (b: Buffer) => createHash("sha256").update(b).digest("base64");

describe("WhatsApp media decryption", () => {
  it("decrypts what WhatsApp encrypts, and reports the original's SHA-256", async () => {
    const plain = randomBytes(10_000 + 7);
    const mediaKey = randomBytes(32).toString("base64");
    const { plain: out, d } = await decryptAll(encryptLikeWhatsApp(plain, mediaKey, "Image"), mediaKey, "Image");
    expect(out.equals(plain)).toBe(true);
    expect(d.result?.sha256Base64).toBe(sha256b64(plain));
    expect(d.result?.size).toBe(plain.length);
  });

  it("produces exactly what OpenWA's own wa-decrypt produces from the same download", async () => {
    for (const [waType, mimetype, kind, size] of [
      ["image", "image/jpeg", "Image", 4_321],
      ["video", "video/mp4", "Video", 70_001],
      ["ptt", "audio/ogg; codecs=opus", "Audio", 2_048],
      ["document", "application/pdf", "Document", 33_333],
    ] as const) {
      const plain = randomBytes(size);
      const mediaKey = randomBytes(32).toString("base64");
      const encrypted = encryptLikeWhatsApp(plain, mediaKey, kind);
      const urlPath = `/mms/${waType}/${size}`;
      files.set(urlPath, { status: 200, body: encrypted });

      const theirs = await waDecrypt.decryptMedia({
        type: waType,
        mimetype,
        mediaKey,
        filehash: sha256b64(plain),
        size,
        deprecatedMms3Url: `${base}${urlPath}`,
      });
      const ours = await decryptAll(encrypted, mediaKey, mediaKeyKindFor(waType, mimetype));
      // wa-decrypt skips the final padding step, so when the file size is an exact multiple of 16
      // it hands back a whole padding block too (measured: 2048 bytes in, 2064 out). Every byte
      // of the file itself must agree; ours is the file and nothing more.
      const theirsBytes = Buffer.from(theirs);
      expect(theirsBytes.length - size, `wa-decrypt length ${waType}`).toBe(size % 16 === 0 ? 16 : 0);
      expect(theirsBytes.subarray(0, size).equals(plain), `wa-decrypt ${waType}`).toBe(true);
      expect(ours.plain.equals(theirsBytes.subarray(0, size)), `ours vs wa-decrypt ${waType}`).toBe(true);
      expect(ours.plain.length).toBe(size);
    }
  });

  it("refuses a file whose MAC does not match — it is not the file WhatsApp sent", async () => {
    const mediaKey = randomBytes(32).toString("base64");
    const encrypted = encryptLikeWhatsApp(randomBytes(500), mediaKey, "Image");
    encrypted[encrypted.length - 1]! ^= 0xff;
    await expect(decryptAll(encrypted, mediaKey, "Image")).rejects.toBeInstanceOf(MediaIntegrityError);
  });

  it("refuses a body tampered with in the middle", async () => {
    const mediaKey = randomBytes(32).toString("base64");
    const encrypted = encryptLikeWhatsApp(randomBytes(500), mediaKey, "Image");
    encrypted[100]! ^= 0x01;
    await expect(decryptAll(encrypted, mediaKey, "Image")).rejects.toBeInstanceOf(MediaIntegrityError);
  });

  it("refuses a download cut short", async () => {
    const mediaKey = randomBytes(32).toString("base64");
    const encrypted = encryptLikeWhatsApp(randomBytes(500), mediaKey, "Image");
    await expect(decryptAll(encrypted.subarray(0, 6), mediaKey, "Image")).rejects.toBeInstanceOf(MediaIntegrityError);
    await expect(decryptAll(encrypted.subarray(0, 300), mediaKey, "Image")).rejects.toBeInstanceOf(MediaIntegrityError);
  });

  it("the key kind matters: a video decrypted with image keys fails rather than producing garbage", async () => {
    const mediaKey = randomBytes(32).toString("base64");
    const encrypted = encryptLikeWhatsApp(randomBytes(500), mediaKey, "Video");
    await expect(decryptAll(encrypted, mediaKey, "Image")).rejects.toBeInstanceOf(MediaIntegrityError);
  });

  it("maps WhatsApp types to key kinds: stickers are images, voice notes audio", () => {
    expect(mediaKeyKindFor("sticker", "image/webp")).toBe("Image");
    expect(mediaKeyKindFor("ptt", "audio/ogg")).toBe("Audio");
    expect(mediaKeyKindFor("video", "video/mp4")).toBe("Video");
    expect(mediaKeyKindFor("document", "application/zip")).toBe("Document");
    expect(mediaKeyKindFor("unknown", "audio/mpeg")).toBe("Audio");
    expect(mediaKeyKindFor("unknown", "application/x-msdownload")).toBe("Document");
  });
});

/** The code only follows https URLs; the test's media server is plain http on localhost. */
const toTestServer = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) =>
  fetch(url.replace("https://media.test", base), init);

describe("fetchAndStoreWhatsAppMedia", () => {
  const storage = () => new LocalMediaStorage(root);

  async function stored(): Promise<string[]> {
    const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  }

  it("streams, decrypts and stores the original byte for byte", async () => {
    const plain = randomBytes(3 * 1024 * 1024 + 5);
    const mediaKey = randomBytes(32).toString("base64");
    files.set("/v/big", { status: 200, body: encryptLikeWhatsApp(plain, mediaKey, "Video") });
    const s = storage();
    const result = await fetchAndStoreWhatsAppMedia({
      info: { mediaKey, filehash: sha256b64(plain), encFilehash: null, url: "https://media.test/v/big", directPath: null, thumbnailJpegBase64: null },
      waType: "video",
      mimeType: "video/mp4",
      declaredSizeBytes: plain.length,
      maxBytes: 10 * 1024 * 1024,
      storage: s,
      storageKey: "whatsapp/p/a/g/2026/10/big",
      fetchImpl: toTestServer,
    });
    expect(result.size).toBe(plain.length);
    expect(result.sha256Hex).toBe(createHash("sha256").update(plain).digest("hex"));
    const chunks: Buffer[] = [];
    for await (const c of (await s.get("whatsapp/p/a/g/2026/10/big")).stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).equals(plain)).toBe(true);
  });

  it("a file WhatsApp no longer has is EXPIRED, and nothing is stored", async () => {
    await expect(
      fetchAndStoreWhatsAppMedia({
        info: { mediaKey: randomBytes(32).toString("base64"), filehash: null, encFilehash: null, url: "https://media.test/gone", directPath: null, thumbnailJpegBase64: null },
        waType: "image",
        mimeType: "image/jpeg",
        declaredSizeBytes: 10,
        maxBytes: 1000,
        storage: storage(),
        storageKey: "whatsapp/p/a/g/2026/10/gone",
        fetchImpl: toTestServer,
      }),
    ).rejects.toBeInstanceOf(MediaExpiredError);
    expect(await stored()).not.toContain("gone");
  });

  it("a file over the limit is refused before or while it streams, leaving nothing", async () => {
    const plain = randomBytes(5000);
    const mediaKey = randomBytes(32).toString("base64");
    files.set("/i/large", { status: 200, body: encryptLikeWhatsApp(plain, mediaKey, "Image") });
    await expect(
      fetchAndStoreWhatsAppMedia({
        info: { mediaKey, filehash: null, encFilehash: null, url: "https://media.test/i/large", directPath: null, thumbnailJpegBase64: null },
        waType: "image",
        mimeType: "image/jpeg",
        declaredSizeBytes: null,
        maxBytes: 1000,
        storage: storage(),
        storageKey: "whatsapp/p/a/g/2026/10/large",
        fetchImpl: toTestServer,
      }),
    ).rejects.toBeInstanceOf(MediaTooLargeError);
    expect(await stored()).not.toContain("large");
  });

  it("a file that does not match WhatsApp's checksum is removed and refused", async () => {
    const plain = randomBytes(800);
    const mediaKey = randomBytes(32).toString("base64");
    files.set("/i/mismatch", { status: 200, body: encryptLikeWhatsApp(plain, mediaKey, "Image") });
    await expect(
      fetchAndStoreWhatsAppMedia({
        info: { mediaKey, filehash: sha256b64(Buffer.from("something else")), encFilehash: null, url: "https://media.test/i/mismatch", directPath: null, thumbnailJpegBase64: null },
        waType: "image",
        mimeType: "image/jpeg",
        declaredSizeBytes: 800,
        maxBytes: 10_000,
        storage: storage(),
        storageKey: "whatsapp/p/a/g/2026/10/mismatch",
        fetchImpl: toTestServer,
      }),
    ).rejects.toBeInstanceOf(MediaIntegrityError);
    expect(await stored()).not.toContain("mismatch");
  });

  it("builds the fallback URL from WhatsApp's direct path, and never follows a non-https URL", () => {
    expect(mediaDownloadUrls({ url: "https://mmg.whatsapp.net/v/t62/abc?x=1", directPath: "/v/t62/abc" })).toEqual([
      "https://mmg.whatsapp.net/v/t62/abc?x=1",
      "https://mmg.whatsapp.net/v/t62/abc",
    ]);
    expect(mediaDownloadUrls({ url: "file:///etc/passwd", directPath: null })).toEqual([]);
    expect(mediaDownloadUrls({ url: null, directPath: "relative/path" })).toEqual([]);
  });
});
