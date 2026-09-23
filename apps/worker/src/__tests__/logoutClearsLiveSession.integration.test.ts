import "./helpers/requireTestDatabase.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@support-automation/db";

/**
 * Logging out a LIVE session has to remove the Chromium profile too.
 *
 * `logoutClearsSession.integration.test.ts` beside this file covers the OTHER branch — logout with
 * no client — and it passed throughout the incident this file exists for, because the two branches
 * did different things and only one of them was ever tested. That is the same shape CLAUDE.md warns
 * about for the collection watchdog: a suite that sets one of two things production always sets
 * together ends up guarding nothing.
 *
 * WHAT IT MISSED. With a client we called `client.logout(false)` and stopped, trusting the
 * library's own invalidation. It deletes `<sessionId>.data.json`, then tries to clear the profile
 * and fails — the browser it is closing still holds files open:
 *
 *     ENOTEMPTY: directory not empty, rmdir
 *       '.../Default/IndexedDB/https_web.whatsapp.com_0.indexeddb.leveldb'
 *
 * — as an unhandled rejection, caught only by `installProcessGuards` and otherwise invisible. The
 * half-authenticated profile that survives makes the NEXT connect's `isAuthenticated()` race
 * neither succeed nor fail: it burns the whole `authTimeout`, kills the browser, and produces no
 * code at all. Every retry reuses the same directory. Observed live on 23 Sep 2026: Logout followed
 * by Connect could not produce a QR again until the directory was deleted by hand.
 *
 * `create()` here RESOLVES, unlike the sibling file, which is the whole point — that is what leaves
 * a client behind and selects the branch that broke.
 */

/**
 * Every property is an async no-op, except the ones this test cares about.
 *
 * A Proxy rather than a hand-written stub because the post-connect path calls several library
 * methods (`onStateChanged`, account metadata, the message listener) that have nothing to do with
 * what is being asserted, and enumerating them would mean this test breaking whenever an unrelated
 * call is added — the kind of brittleness that gets a test deleted rather than fixed.
 */
function makeStubClient(onLogout: () => void) {
  return new Proxy(
    {},
    {
      get(_target, property) {
        // `then` MUST stay undefined. `create()` resolves with this object, and a promise resolving
        // to a thenable calls its `then` — an async no-op there never calls resolve or reject, so
        // `await create(...)` hangs forever. Cost 30s per test to find; leave it alone.
        if (property === "then") return undefined;
        if (property === "logout") {
          return async () => {
            onLogout();
          };
        }
        return async () => undefined;
      },
    },
  );
}

let logoutCalls = 0;

vi.mock("@open-wa/wa-automate", () => ({
  create: vi.fn(async () => makeStubClient(() => { logoutCalls += 1; })),
  ev: { on: vi.fn() },
  STATE: {},
  MessageTypes: {},
}));

let accountId: string;
let sessionDir: string;
const originalCwd = process.cwd();

beforeAll(async () => {
  const account = await prisma.whatsAppAccount.create({
    data: { label: `Live Logout Test ${randomUUID()}`, status: "DISCONNECTED" },
  });
  accountId = account.id;
  sessionDir = await mkdtemp(join(tmpdir(), "openwa-live-logout-"));
});

afterEach(() => {
  // `openSession()` chdirs into the session directory; leaving it there would break every later
  // suite in this worker, which shares one process.
  process.chdir(originalCwd);
});

afterAll(async () => {
  process.chdir(originalCwd);
  await prisma.whatsAppAccount.delete({ where: { id: accountId } }).catch(() => undefined);
  await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("logout with a live client", () => {
  it("unlinks remotely AND removes the profile the browser was using", async () => {
    const { OpenWAProvider } = await import("../provider/openwa/OpenWAProvider.js");
    const sessionId = `live-logout-${randomUUID().slice(0, 8)}`;
    const provider = new OpenWAProvider(accountId, sessionId, sessionDir);

    logoutCalls = 0;
    await provider.connect();

    // Stand in for what a real Chromium leaves behind, including the nesting that produced the
    // ENOTEMPTY — a single `rm` pass over a deep tree is what the library's own attempt failed at.
    const profileDir = join(sessionDir, `_IGNORE_${sessionId}`);
    const indexedDb = join(profileDir, "Default", "IndexedDB", "https_web.whatsapp.com_0.indexeddb.leveldb");
    await mkdir(indexedDb, { recursive: true });
    await writeFile(join(indexedDb, "000003.log"), "half-authenticated-state");
    await writeFile(join(profileDir, "Cookies"), "stale-session-data");
    // The library writes this one and deletes it itself; it is here so the assertion below is about
    // this code rather than about what the mock happened not to do.
    await writeFile(join(sessionDir, `${sessionId}.data.json`), "{}");
    expect(existsSync(profileDir)).toBe(true);

    await provider.logout();

    // Both halves. The remote unlink alone is what shipped, and it is not enough.
    expect(logoutCalls).toBe(1);
    expect(existsSync(profileDir)).toBe(false);
    expect(existsSync(join(sessionDir, `${sessionId}.data.json`))).toBe(false);
  });

  it("lands on DISCONNECTED even though a client existed", async () => {
    const { OpenWAProvider } = await import("../provider/openwa/OpenWAProvider.js");
    const sessionId = `live-logout-${randomUUID().slice(0, 8)}`;
    const provider = new OpenWAProvider(accountId, sessionId, sessionDir);

    await provider.connect();
    await provider.logout();

    const account = await prisma.whatsAppAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.status).toBe("DISCONNECTED");
  });

  it("removes the profile even when the remote unlink call fails", async () => {
    // The failure mode this guards is the worst one to get wrong: a logout whose remote half threw
    // is EXACTLY when the local session must not be left behind, because the operator is now
    // relying on a fresh scan to recover. `logout()` swallows the error by design; the cleanup
    // after it must not be skipped as a side effect of that.
    const { OpenWAProvider } = await import("../provider/openwa/OpenWAProvider.js");
    const sessionId = `live-logout-${randomUUID().slice(0, 8)}`;
    const provider = new OpenWAProvider(accountId, sessionId, sessionDir);

    await provider.connect();
    // Replace the resolved client's logout with one that rejects.
    (provider as unknown as { client: { logout: () => Promise<void> } }).client = {
      logout: async () => {
        throw new Error("simulated remote unlink failure");
      },
    };

    const profileDir = join(sessionDir, `_IGNORE_${sessionId}`);
    await mkdir(profileDir, { recursive: true });
    await writeFile(join(profileDir, "Cookies"), "stale-session-data");

    await expect(provider.logout()).resolves.toBeUndefined();
    expect(existsSync(profileDir)).toBe(false);
  });
});
