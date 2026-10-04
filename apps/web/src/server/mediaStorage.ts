import { createMediaStorageFromEnv, type MediaStorage } from "@support-automation/media-storage";

/**
 * The dashboard's handle on media storage (MEDIA_STORAGE.md) — the same directory the worker writes
 * to, named by `MEDIA_STORAGE_DIR` in both containers. Null when it is not configured, which every
 * caller reports as such rather than as a missing file.
 */
let cached: MediaStorage | null | undefined;

export function getMediaStorage(): MediaStorage | null {
  if (cached === undefined) {
    try {
      cached = createMediaStorageFromEnv();
    } catch (err) {
      console.error("[media] media storage is misconfigured", err);
      cached = null;
    }
  }
  return cached;
}

/** Test seam: the integration tests point the dashboard at a temporary directory. */
export function setMediaStorageForTests(storage: MediaStorage | null | undefined): void {
  cached = storage;
}
