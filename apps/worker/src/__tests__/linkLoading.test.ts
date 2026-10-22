import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearLinkMarker,
  growthBytes,
  hasProgressed,
  indexedDbDir,
  isResumableLink,
  judgeLoading,
  readLinkMarker,
  readProfileActivity,
  writeLinkMarker,
} from "../provider/openwa/linkLoading.js";

/**
 * The decisions behind "wait for as long as WhatsApp keeps copying chats" (GROUP_SYNC.md §10),
 * without a browser: the verdict, the progress test, the marker, and the profile walk over a real
 * directory.
 */

const MIN = 60_000;
const settings = { stallMs: 10 * MIN, maxMs: 45 * MIN, resumeMaxAgeMs: 6 * 60 * MIN };

describe("the verdict", () => {
  it("waits while chats keep arriving, however long that has been", () => {
    expect(judgeLoading({ startedAt: 0, lastProgressAt: 39 * MIN, now: 40 * MIN }, settings)).toEqual({ kind: "WAIT" });
  });

  it("gives up after the stall limit with nothing new", () => {
    expect(judgeLoading({ startedAt: 0, lastProgressAt: 5 * MIN, now: 15 * MIN }, settings)).toEqual({ kind: "STALLED", quietMs: 10 * MIN });
  });

  it("is bounded in total even while progress continues", () => {
    expect(judgeLoading({ startedAt: 0, lastProgressAt: 45 * MIN, now: 45 * MIN }, settings)).toEqual({ kind: "TOO_LONG", elapsedMs: 45 * MIN });
  });

  it("would have let the 23 Sep load finish: four minutes of progress is nowhere near a verdict", () => {
    expect(judgeLoading({ startedAt: 0, lastProgressAt: 4 * MIN, now: 4 * MIN + 1 }, settings).kind).toBe("WAIT");
  });
});

describe("progress", () => {
  const a = { files: 3, bytes: 1_000, newestMtimeMs: 100 };

  it("is anything written: size, file count or a newer modification", () => {
    expect(hasProgressed(a, { ...a, bytes: 1_001 })).toBe(true);
    expect(hasProgressed(a, { ...a, files: 4 })).toBe(true);
    expect(hasProgressed(a, { ...a, newestMtimeMs: 101 })).toBe(true);
    // LevelDB compaction can shrink the total; that is still writing.
    expect(hasProgressed(a, { ...a, bytes: 900 })).toBe(true);
  });

  it("is nothing when nothing changed, or when either sample is unknown", () => {
    expect(hasProgressed(a, { ...a })).toBe(false);
    expect(hasProgressed(null, a)).toBe(false);
    expect(hasProgressed(a, null)).toBe(false);
  });

  it("growth for the phone-code case counts a missing baseline as an empty profile, and never goes negative", () => {
    expect(growthBytes(null, a)).toBe(1_000);
    expect(growthBytes(a, null)).toBe(0);
    expect(growthBytes(a, { ...a, bytes: 400 })).toBe(0);
    expect(growthBytes(a, { ...a, bytes: 4_000 })).toBe(3_000);
  });
});

describe("the record of an accepted scan", () => {
  it("is resumed only while young, and only while the load has not finished", () => {
    const now = 10 * 60 * MIN;
    expect(isResumableLink(null, false, now, settings)).toBe(false);
    expect(isResumableLink({ scannedAt: now - 30 * MIN }, false, now, settings)).toBe(true);
    expect(isResumableLink({ scannedAt: now - 30 * MIN }, true, now, settings)).toBe(false); // finished: an ordinary restore
    expect(isResumableLink({ scannedAt: now - 7 * 60 * MIN }, false, now, settings)).toBe(false); // too old to honour
    expect(isResumableLink({ scannedAt: now + MIN }, false, now, settings)).toBe(false); // a clock that went backwards
  });
});

describe("on disk", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "link-loading-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("the marker round-trips, and anything unreadable is no marker", async () => {
    const path = join(dir, "s.link-pending.json");
    expect(await readLinkMarker(path)).toBeNull();
    await writeLinkMarker(path, 1234);
    expect(await readLinkMarker(path)).toEqual({ scannedAt: 1234 });
    await writeFile(path, "{not json");
    expect(await readLinkMarker(path)).toBeNull();
    await clearLinkMarker(path);
    await clearLinkMarker(path); // twice is fine
    expect(await readLinkMarker(path)).toBeNull();
  });

  it("the profile walk sums WhatsApp's IndexedDB, nested, and is unknown before it exists", async () => {
    const profile = join(dir, "profile");
    expect(await readProfileActivity(profile)).toBeNull();
    const leveldb = join(indexedDbDir(profile), "https_web.whatsapp.com_0.indexeddb.leveldb");
    await mkdir(join(indexedDbDir(profile), "https_web.whatsapp.com_0.indexeddb.blob", "1"), { recursive: true });
    await mkdir(leveldb, { recursive: true });
    await writeFile(join(leveldb, "000003.log"), "x".repeat(300));
    await writeFile(join(indexedDbDir(profile), "https_web.whatsapp.com_0.indexeddb.blob", "1", "a"), "y".repeat(200));
    const activity = await readProfileActivity(profile);
    expect(activity).toMatchObject({ files: 2, bytes: 500 });
    expect(activity!.newestMtimeMs).toBeGreaterThan(0);
  });

  it("the walk is bounded, so a profile holding thousands of blobs stays cheap", async () => {
    const profile = join(dir, "big");
    const blobs = join(indexedDbDir(profile), "blobs");
    await mkdir(blobs, { recursive: true });
    await Promise.all(Array.from({ length: 30 }, (_, i) => writeFile(join(blobs, `b${i}`), "z")));
    const bounded = await readProfileActivity(profile, 10);
    expect(bounded!.files).toBeLessThanOrEqual(10);
  });
});
