import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Where WhatsApp media files live (MEDIA_STORAGE.md). Postgres holds each file's metadata and its
 * storage KEY; the bytes live behind this interface and nowhere else.
 *
 * The worker writes through it, the dashboard reads through it, and neither knows what is
 * underneath. Today that is a directory on a volume shared by both containers
 * (`LocalMediaStorage`). Moving to an S3-compatible store (MinIO, S3, R2) is a second
 * implementation of this interface and a configuration change — the message pipeline, the
 * `MessageMedia` model and the chat UI do not change, because none of them ever see a path.
 */
export interface MediaStorage {
  /** Which implementation this is, for logs and the Settings page. */
  readonly driver: string;
  /**
   * Stores `body` under `key`, replacing nothing until the whole file has arrived: a reader never
   * sees half a file, and a failed or aborted write leaves nothing behind. `maxBytes` aborts the
   * write once exceeded (`MediaTooLargeError`).
   */
  put(key: string, body: Readable | Buffer, options?: { maxBytes?: number }): Promise<{ size: number }>;
  /** A stream of the object, or of an inclusive byte range of it. `size` is the WHOLE object's size. */
  get(key: string, range?: MediaByteRange): Promise<{ stream: Readable; size: number }>;
  /** The object's size, or null when there is no such object. */
  stat(key: string): Promise<{ size: number } | null>;
  exists(key: string): Promise<boolean>;
  /** Removes the object. Removing one that is already gone succeeds: a retried cleanup must converge. */
  delete(key: string): Promise<void>;
  /** Free space where new objects go, in bytes, or null when the backend cannot say. */
  freeBytes(): Promise<number | null>;
}

/** An inclusive byte range, as HTTP `Range` means it. */
export interface MediaByteRange {
  start: number;
  end: number;
}

export class MediaObjectNotFoundError extends Error {
  constructor(key: string) {
    super(`No media object is stored under ${key}.`);
    this.name = "MediaObjectNotFoundError";
  }
}

export class MediaTooLargeError extends Error {
  constructor(public readonly limitBytes: number) {
    super(`The file is larger than the ${limitBytes}-byte limit, so it was not stored.`);
    this.name = "MediaTooLargeError";
  }
}

export class InvalidStorageKeyError extends Error {
  constructor(key: string) {
    super(`Refused an invalid media storage key: ${JSON.stringify(key).slice(0, 120)}`);
    this.name = "InvalidStorageKeyError";
  }
}

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*(\/[A-Za-z0-9][A-Za-z0-9_.-]*)*$/;

/**
 * Keys are built by this application from ids, so anything else is refused outright rather than
 * cleaned up: no `..`, no leading slash, no backslash, no empty segment, nothing but
 * letters/digits/`_`/`-`/`.` between slashes. A path can therefore never leave the storage root.
 */
export function assertValidStorageKey(key: string): void {
  if (typeof key !== "string" || key.length === 0 || key.length > 512 || !KEY_PATTERN.test(key)) {
    throw new InvalidStorageKeyError(key);
  }
  if (key.split("/").some((segment) => segment === "." || segment === "..")) throw new InvalidStorageKeyError(key);
}

/**
 * The storage key for a message's file:
 *
 *     whatsapp/<projectId>/<accountId>/<groupId | direct>/<yyyy>/<mm>/<mediaId>
 *
 * Ids only — never a phone number, a group name, a file name or anything a customer wrote. The
 * date is the media row's creation month (UTC), which keeps any one directory a manageable size.
 */
export function buildMediaStorageKey(input: {
  projectId: string;
  accountId: string;
  groupId: string | null;
  mediaId: string;
  createdAt: Date;
  variant?: "original" | "thumbnail";
}): string {
  const yyyy = String(input.createdAt.getUTCFullYear());
  const mm = String(input.createdAt.getUTCMonth() + 1).padStart(2, "0");
  const name = input.variant === "thumbnail" ? `${input.mediaId}.thumb` : input.mediaId;
  const key = ["whatsapp", input.projectId, input.accountId, input.groupId ?? "direct", yyyy, mm, name].join("/");
  assertValidStorageKey(key);
  return key;
}

/** Counts bytes on the way through and stops the stream once a limit is passed. */
class ByteLimit extends Transform {
  bytes = 0;
  constructor(private readonly limit: number | undefined) {
    super();
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.limit !== undefined && this.bytes > this.limit) {
      callback(new MediaTooLargeError(this.limit));
      return;
    }
    callback(null, chunk);
  }
}

/**
 * Media on a local directory — in Docker, a named volume mounted into BOTH the worker (which
 * writes) and the dashboard (which reads) at the same path.
 */
export class LocalMediaStorage implements MediaStorage {
  readonly driver = "local";
  readonly root: string;

  constructor(root: string) {
    if (!root) throw new Error("LocalMediaStorage needs a root directory.");
    this.root = path.resolve(root);
  }

  /** The absolute path for a key, refused unless it is inside the root. */
  private pathFor(key: string): string {
    assertValidStorageKey(key);
    const resolved = path.resolve(this.root, ...key.split("/"));
    if (!resolved.startsWith(this.root + path.sep)) throw new InvalidStorageKeyError(key);
    return resolved;
  }

  async put(key: string, body: Readable | Buffer, options: { maxBytes?: number } = {}): Promise<{ size: number }> {
    const target = this.pathFor(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Written beside the target and renamed into place: rename within one directory is atomic, so
    // a reader sees either no file or the whole file, never a partial one.
    const temp = `${target}.part-${randomUUID()}`;
    const limit = new ByteLimit(options.maxBytes);
    const source = Buffer.isBuffer(body) ? Readable.from([body]) : body;
    try {
      await pipeline(source, limit, createWriteStream(temp, { flags: "wx" }));
      await fs.rename(temp, target);
    } catch (err) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw err;
    }
    return { size: limit.bytes };
  }

  async get(key: string, range?: MediaByteRange): Promise<{ stream: Readable; size: number }> {
    const target = this.pathFor(key);
    const info = await fs.stat(target).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") throw new MediaObjectNotFoundError(key);
      throw err;
    });
    const stream = range ? createReadStream(target, { start: range.start, end: range.end }) : createReadStream(target);
    return { stream, size: info.size };
  }

  async stat(key: string): Promise<{ size: number } | null> {
    try {
      const info = await fs.stat(this.pathFor(key));
      return info.isFile() ? { size: info.size } : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== null;
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.pathFor(key), { force: true });
  }

  async freeBytes(): Promise<number | null> {
    try {
      await fs.mkdir(this.root, { recursive: true });
      const info = await fs.statfs(this.root);
      return Number(info.bavail) * Number(info.bsize);
    } catch {
      return null;
    }
  }
}

/**
 * The configured storage, or null when none is configured.
 *
 * `MEDIA_STORAGE_DRIVER` names the implementation (only `local` exists today; anything else is
 * refused rather than silently falling back to the local disk). `MEDIA_STORAGE_DIR` is its root,
 * and must be the SAME path in the worker and the dashboard. There is deliberately no default
 * directory: a guessed one differs between the two processes in development, and media written
 * where the dashboard cannot read it looks exactly like media that failed to download.
 */
export function createMediaStorageFromEnv(env: NodeJS.ProcessEnv = process.env): MediaStorage | null {
  const driver = (env.MEDIA_STORAGE_DRIVER ?? "local").trim().toLowerCase();
  if (driver !== "local") {
    throw new Error(`MEDIA_STORAGE_DRIVER="${driver}" is not supported. The only driver available is "local".`);
  }
  const dir = env.MEDIA_STORAGE_DIR?.trim();
  return dir ? new LocalMediaStorage(dir) : null;
}

/**
 * Parses an HTTP `Range` header against an object's size. One range only — browsers seeking in a
 * video or audio element ask for one. Returns null for "no usable range" (serve the whole file),
 * or "unsatisfiable" for a range entirely past the end (HTTP 416).
 */
export function parseRangeHeader(header: string | null | undefined, size: number): MediaByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, startText, endText] = match;
  if (startText === "" && endText === "") return null;
  if (size === 0) return "unsatisfiable";
  if (startText === "") {
    // "bytes=-500": the last 500 bytes.
    const suffix = Number(endText);
    if (suffix === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(startText);
  if (start >= size) return "unsatisfiable";
  const end = endText === "" ? size - 1 : Math.min(Number(endText), size - 1);
  if (end < start) return null;
  return { start, end };
}
