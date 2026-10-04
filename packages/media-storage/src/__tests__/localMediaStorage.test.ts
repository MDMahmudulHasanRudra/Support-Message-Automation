import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertValidStorageKey,
  buildMediaStorageKey,
  createMediaStorageFromEnv,
  InvalidStorageKeyError,
  LocalMediaStorage,
  MediaObjectNotFoundError,
  MediaTooLargeError,
  parseRangeHeader,
} from "../index.js";

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Every file under a directory, relative — to prove a failed write leaves nothing behind. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath ?? (e as unknown as { path: string }).path, e.name)));
}

let root: string;
let storage: LocalMediaStorage;
const KEY = "whatsapp/proj_a/acc_1/grp_1/2026/10/media_1";

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "media-storage-test-"));
  storage = new LocalMediaStorage(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("LocalMediaStorage", () => {
  it("puts, reads, stats and deletes a file", async () => {
    const body = Buffer.from("hello media");
    expect(await storage.put(KEY, body)).toEqual({ size: body.length });
    expect(await storage.exists(KEY)).toBe(true);
    expect(await storage.stat(KEY)).toEqual({ size: body.length });
    const { stream, size } = await storage.get(KEY);
    expect(size).toBe(body.length);
    expect((await readAll(stream)).toString()).toBe("hello media");

    await storage.delete(KEY);
    expect(await storage.exists(KEY)).toBe(false);
    expect(await storage.stat(KEY)).toBeNull();
  });

  it("stores a stream, not only a buffer", async () => {
    const parts = [Buffer.alloc(70_000, 1), Buffer.alloc(70_000, 2)];
    expect(await storage.put(KEY, Readable.from(parts))).toEqual({ size: 140_000 });
    expect((await readAll((await storage.get(KEY)).stream)).equals(Buffer.concat(parts))).toBe(true);
  });

  it("reads an inclusive byte range and reports the whole size", async () => {
    await storage.put(KEY, Buffer.from("0123456789"));
    const { stream, size } = await storage.get(KEY, { start: 2, end: 5 });
    expect(size).toBe(10);
    expect((await readAll(stream)).toString()).toBe("2345");
  });

  it("deleting something already gone succeeds, so a retried cleanup converges", async () => {
    await expect(storage.delete(KEY)).resolves.toBeUndefined();
  });

  it("a missing object is MediaObjectNotFoundError, not a crash", async () => {
    await expect(storage.get(KEY)).rejects.toBeInstanceOf(MediaObjectNotFoundError);
  });

  it("a write over the limit fails and leaves no file — not even a partial one", async () => {
    await expect(storage.put(KEY, Readable.from([Buffer.alloc(600), Buffer.alloc(600)]), { maxBytes: 1000 })).rejects.toBeInstanceOf(
      MediaTooLargeError,
    );
    expect(await storage.exists(KEY)).toBe(false);
    expect(await filesUnder(root)).toEqual([]);
  });

  it("a stream that fails midway leaves no file, and an existing file is untouched", async () => {
    await storage.put(KEY, Buffer.from("original"));
    const broken = new Readable({
      read() {
        this.push(Buffer.from("partial"));
        this.destroy(new Error("connection reset"));
      },
    });
    await expect(storage.put(KEY, broken)).rejects.toThrow("connection reset");
    expect((await readAll((await storage.get(KEY)).stream)).toString()).toBe("original");
    expect((await filesUnder(root)).length).toBe(1);
  });

  it("refuses keys that could leave the storage root", async () => {
    for (const bad of ["../etc/passwd", "a/../../b", "/abs/path", "a//b", "a\\b", "", "a/./b", "a/b/..", "C:/x", "a b"]) {
      await expect(storage.put(bad, Buffer.from("x"))).rejects.toBeInstanceOf(InvalidStorageKeyError);
      await expect(storage.get(bad)).rejects.toBeInstanceOf(InvalidStorageKeyError);
      await expect(storage.delete(bad)).rejects.toBeInstanceOf(InvalidStorageKeyError);
    }
    expect(await filesUnder(root)).toEqual([]);
  });

  it("reports free space where files go", async () => {
    const free = await storage.freeBytes();
    expect(free === null || free > 0).toBe(true);
  });
});

describe("buildMediaStorageKey", () => {
  it("is made of ids and the month only", () => {
    const key = buildMediaStorageKey({
      projectId: "proj_isp_digital",
      accountId: "cmacc1",
      groupId: null,
      mediaId: "cmmedia1",
      createdAt: new Date("2026-01-31T23:00:00Z"),
    });
    expect(key).toBe("whatsapp/proj_isp_digital/cmacc1/direct/2026/01/cmmedia1");
    expect(buildMediaStorageKey({ projectId: "p", accountId: "a", groupId: "g", mediaId: "m", createdAt: new Date("2026-10-05T00:00:00Z"), variant: "thumbnail" })).toBe(
      "whatsapp/p/a/g/2026/10/m.thumb",
    );
  });

  it("refuses an id that is not a plain id", () => {
    expect(() =>
      buildMediaStorageKey({ projectId: "p", accountId: "../a", groupId: null, mediaId: "m", createdAt: new Date() }),
    ).toThrow(InvalidStorageKeyError);
    expect(() => assertValidStorageKey("whatsapp/8801712345678@c.us/x")).toThrow(InvalidStorageKeyError);
  });
});

describe("createMediaStorageFromEnv", () => {
  it("is null without a directory, local with one, and refuses an unknown driver", () => {
    expect(createMediaStorageFromEnv({})).toBeNull();
    expect(createMediaStorageFromEnv({ MEDIA_STORAGE_DIR: root })?.driver).toBe("local");
    expect(() => createMediaStorageFromEnv({ MEDIA_STORAGE_DRIVER: "s3", MEDIA_STORAGE_DIR: root })).toThrow(/not supported/);
  });
});

describe("parseRangeHeader", () => {
  it("reads the ranges a browser sends", () => {
    expect(parseRangeHeader("bytes=0-", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRangeHeader("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(parseRangeHeader("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRangeHeader("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRangeHeader("bytes=-500", 100)).toEqual({ start: 0, end: 99 });
  });
  it("serves the whole file for no range or one it cannot read, and 416 past the end", () => {
    expect(parseRangeHeader(null, 100)).toBeNull();
    expect(parseRangeHeader("bytes=0-1,5-6", 100)).toBeNull();
    expect(parseRangeHeader("items=0-5", 100)).toBeNull();
    expect(parseRangeHeader("bytes=20-10", 100)).toBeNull();
    expect(parseRangeHeader("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseRangeHeader("bytes=-0", 100)).toBe("unsatisfiable");
  });
});
