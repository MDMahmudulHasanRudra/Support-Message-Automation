import { readdir, readFile } from "node:fs/promises";

/**
 * Killing the Chromium an unfinished connect attempt left behind.
 *
 * OpenWA hands back a client only when `create()` RESOLVES. An attempt that ends any other way —
 * the linking window running out with a code unscanned, an operator switching to a phone code, the
 * no-code deadline — leaves `create()` still running, parked on a QR that rotates every twenty
 * seconds forever (`qrTimeout` is 0). Its browser is out of reach from here: the library keeps it
 * in a module-level variable that the NEXT launch overwrites, and exports nothing to read it back.
 *
 * Observed on 24 Sep 2026, and the failure is not a leak, it is a broken account. The first
 * unscanned five-minute window orphaned its Chromium; the retry launched a second one against the
 * SAME profile directory (`clearStaleChromiumLock()` had removed the orphan's Singleton files,
 * which is exactly what let it start); the two fought over one profile, the new attempt's page
 * never authenticated and died after its own 120s + 60s timers as "App Offline" — and the orphan
 * went on emitting codes on the same session id, landing in the database as if they were current,
 * including after every retry had given up. A person scanning one of those links a browser that
 * nothing is listening to.
 *
 * The process table is the handle the library does not give us. Every process belonging to one
 * account's browser — the main process and each renderer/utility child — carries
 * `--user-data-dir=<that account's profile>`, and no two accounts share a profile, so matching that
 * exact argument selects this account's browser and nothing else.
 *
 * Linux only, which is where the worker runs (Docker). Without `/proc` this finds nothing and
 * changes nothing — the same behaviour as before it existed.
 */

/** Whether one process's argv belongs to a browser running against `profileDir`. Exact match only. */
export function argvUsesProfile(argv: readonly string[], profileDir: string): boolean {
  // Exact, not a prefix: `/sessions/_IGNORE_a` must not match `/sessions/_IGNORE_ab`, which is
  // another account's browser.
  return argv.includes(`--user-data-dir=${profileDir}`);
}

/** SIGKILLs every process running against `profileDir` except this one. Never throws. */
export async function killBrowsersUsingProfile(profileDir: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return 0;
  }

  let killed = 0;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    let argv: string[];
    try {
      argv = (await readFile(`/proc/${entry}/cmdline`, "utf8")).split("\0").filter(Boolean);
    } catch {
      continue; // exited between the listing and the read
    }
    if (!argvUsesProfile(argv, profileDir)) continue;
    try {
      process.kill(pid, "SIGKILL");
      killed += 1;
    } catch {
      // Already gone — a child that died with its parent a moment ago.
    }
  }
  return killed;
}
