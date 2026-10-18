import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Whether `<sessionId>.data.json` holds something a restore could actually use.
 *
 * Its own module, like `orphanBrowsers` and `connectWithRetry`, so the rule can be tested against
 * real files rather than through a provider that would drag in `@open-wa/wa-automate` and a
 * browser.
 *
 * THE FILE'S EXISTENCE MEANS NOTHING. The library creates it and, on a multi-device session, has
 * nothing to put in it: MD keeps the credentials in the Chromium profile's IndexedDB, not here. A
 * live production account sat for a day on a four-byte `{}` while the only caller asked merely
 * whether the file was present, concluded a restore was possible, and therefore never cleared the
 * dead profile that was failing every attempt — so no QR was ever produced and nobody could link
 * the account back. The guard meant to make the profile reset safe was what prevented it.
 *
 * Deliberately generous about what counts as a session: any non-empty object. The answer decides
 * only whether a profile may be deleted after repeated codeless failures, so a shape this does not
 * recognise is treated as a session and left alone — the retries simply go on as before.
 *
 * Missing, unreadable, empty and unparseable all answer false. A file that cannot be made sense of
 * is not evidence of a session, and treating it as one is what kept an account down.
 */
export async function hasRestorableSessionData(sessionDataPath: string, sessionId: string): Promise<boolean> {
  try {
    const raw = (await readFile(join(sessionDataPath, `${sessionId}.data.json`), "utf8")).trim();
    if (!raw) return false;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    return Object.keys(parsed as Record<string, unknown>).length > 0;
  } catch {
    return false;
  }
}
