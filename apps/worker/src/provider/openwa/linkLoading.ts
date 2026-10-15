import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * How long a newly linked number may take to receive its chats, and how that is decided
 * (GROUP_SYNC.md §10).
 *
 * WHY THIS EXISTS. After a scan, WhatsApp copies the number's chats from the phone to the new
 * device ("Loading your chats", the percentage on the phone). OpenWA's `create()` resolves only when
 * that finishes and the chat screen appears, and the session file is written only then. For a
 * number in a couple of thousand groups that takes minutes, sometimes much longer.
 *
 * The original worker (11 Aug 2026) put no limit on it, and a new number filled in overnight. From
 * 23 Sep the attempt got a fixed 240 s after the scan; past it the browser was killed, the copy
 * stopped wherever it was (30%, 50%, 80%), and the next attempt — with no QR to show, because the
 * browser already held the login — got the library's 120 s before being killed again. Two such
 * attempts and the profile was deleted, so the next scan started from 0%. A large account could
 * never finish.
 *
 * WHAT REPLACES THE FIXED LIMIT: progress, measured from outside the page. While WhatsApp is
 * copying chats it writes them into the profile's IndexedDB, so the directory's size and newest
 * modification time keep changing. The attempt waits as long as they do, and gives up only when
 * nothing has been written for `stallMs` (the phone went offline, WhatsApp stopped) or after
 * `maxMs` in total. Reading file metadata touches neither the page nor WhatsApp.
 */
export const LINK_LOADING_SETTINGS = {
  /** How often the profile is looked at while loading. */
  pollMs: Number(process.env.WHATSAPP_LINK_LOADING_POLL_MS) || 30_000,
  /**
   * Nothing new written for this long = stalled. Ten minutes because a phone that pauses (screen
   * locked, a network switch) resumes within that, and because the attempt it ends was waiting on
   * nothing — longer only delays the retry.
   */
  stallMs: Number(process.env.WHATSAPP_LINK_LOADING_STALL_MS) || 10 * 60_000,
  /**
   * The absolute bound on one attempt's loading, progress or not. It is also how long a stuck
   * attempt can hold the serial command queue and the registry loop, which is why it is not
   * unlimited the way the original was.
   */
  maxMs: Number(process.env.WHATSAPP_LINK_LOADING_MAX_MS) || 45 * 60_000,
  /**
   * A phone-code pairing raises no "accepted" event (the library only learns of it when loading
   * has FINISHED), so when its linking window runs out the profile is asked instead: this much
   * IndexedDB growth since the attempt began means chats are arriving, and the window becomes a
   * loading watch. A QR screen alone writes a few kilobytes. A starting value, logged with the
   * measured growth on every expiry so it can be set from real numbers.
   */
  loadingDetectBytes: Number(process.env.WHATSAPP_LINK_LOADING_DETECT_BYTES) || 2 * 1024 * 1024,
  /** A half-finished link older than this is no longer resumed; the account links from scratch. */
  resumeMaxAgeMs: Number(process.env.WHATSAPP_LINK_RESUME_MAX_AGE_MS) || 6 * 60 * 60_000,
};

/** What the profile's IndexedDB looks like at one moment. */
export interface ProfileActivity {
  files: number;
  bytes: number;
  newestMtimeMs: number;
}

/** Where WhatsApp Web keeps its chats inside a Chromium profile. */
export function indexedDbDir(profileDir: string): string {
  return join(profileDir, "Default", "IndexedDB");
}

/**
 * Sizes and the newest modification time under the profile's IndexedDB. Bounded (`maxEntries`) so
 * a profile holding thousands of blobs costs one cheap walk, never a long one. Null when the
 * directory does not exist yet or cannot be read — "unknown", which is not progress.
 */
export async function readProfileActivity(profileDir: string, maxEntries = 5_000): Promise<ProfileActivity | null> {
  const root = indexedDbDir(profileDir);
  const activity: ProfileActivity = { files: 0, bytes: 0, newestMtimeMs: 0 };
  const pending = [root];
  let seen = 0;
  try {
    while (pending.length > 0 && seen < maxEntries) {
      const dir = pending.pop()!;
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (++seen > maxEntries) break;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          pending.push(full);
          continue;
        }
        const info = await stat(full).catch(() => null); // a LevelDB file can vanish mid-walk (compaction)
        if (!info) continue;
        activity.files += 1;
        activity.bytes += info.size;
        if (info.mtimeMs > activity.newestMtimeMs) activity.newestMtimeMs = info.mtimeMs;
      }
    }
  } catch {
    return null;
  }
  return activity;
}

/** Whether anything was written between two samples. */
export function hasProgressed(previous: ProfileActivity | null, current: ProfileActivity | null): boolean {
  if (!previous || !current) return false;
  return current.bytes !== previous.bytes || current.files !== previous.files || current.newestMtimeMs > previous.newestMtimeMs;
}

/**
 * Growth since a baseline, for the phone-code case. A missing baseline is an empty profile (a
 * first link creates the directory during the attempt); an unreadable current sample is no growth.
 */
export function growthBytes(baseline: ProfileActivity | null, current: ProfileActivity | null): number {
  if (!current) return 0;
  return Math.max(0, current.bytes - (baseline?.bytes ?? 0));
}

export type LoadingVerdict = { kind: "WAIT" } | { kind: "STALLED"; quietMs: number } | { kind: "TOO_LONG"; elapsedMs: number };

/** The whole decision, pure: keep waiting, or give up and why. */
export function judgeLoading(
  input: { startedAt: number; lastProgressAt: number; now: number },
  settings: Pick<typeof LINK_LOADING_SETTINGS, "stallMs" | "maxMs"> = LINK_LOADING_SETTINGS,
): LoadingVerdict {
  const elapsedMs = input.now - input.startedAt;
  if (elapsedMs >= settings.maxMs) return { kind: "TOO_LONG", elapsedMs };
  const quietMs = input.now - input.lastProgressAt;
  if (quietMs >= settings.stallMs) return { kind: "STALLED", quietMs };
  return { kind: "WAIT" };
}

/**
 * The record that a scan was accepted for this profile and its chats have not finished loading.
 *
 * WhatsApp writes the session file only once loading is complete, so without this an interrupted
 * first load is indistinguishable from a profile that never produced a code — and that is exactly
 * what the profile reset deletes. While this exists (and is younger than `resumeMaxAgeMs`) the next
 * attempt RESUMES the load instead: it waits on progress rather than on the library's 120 s, and the
 * profile is never reset under it.
 */
export function linkMarkerPath(sessionDataPath: string, sessionId: string): string {
  return join(sessionDataPath, `${sessionId}.link-pending.json`);
}

export async function writeLinkMarker(path: string, scannedAt: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ scannedAt }), "utf8");
}

export async function readLinkMarker(path: string): Promise<{ scannedAt: number } | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { scannedAt?: unknown };
    return typeof parsed.scannedAt === "number" && Number.isFinite(parsed.scannedAt) ? { scannedAt: parsed.scannedAt } : null;
  } catch {
    return null;
  }
}

export async function clearLinkMarker(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined);
}

/**
 * Whether the next attempt should resume an interrupted first load: a marker, young enough, and no
 * session file (a session file means the load did finish, and this is an ordinary restore).
 */
export function isResumableLink(
  marker: { scannedAt: number } | null,
  hasSessionData: boolean,
  now: number,
  settings: Pick<typeof LINK_LOADING_SETTINGS, "resumeMaxAgeMs"> = LINK_LOADING_SETTINGS,
): boolean {
  if (!marker || hasSessionData) return false;
  const age = now - marker.scannedAt;
  return age >= 0 && age < settings.resumeMaxAgeMs;
}
