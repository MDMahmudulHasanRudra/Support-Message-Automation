import "./helpers/requireTestDatabase.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "./helpers/projectFixtures.js";

/**
 * Logout has to clear the session even when no browser client was ever built.
 *
 * `client.logout()` is what invalidated the stored session, so with `this.client` still null this
 * method set a status and nothing else — the session on disk survived untouched. That is exactly
 * the state an operator reaches after a QR is shown and never scanned: `create()` never resolves,
 * so no client exists, while the profile it half-wrote stays behind and wedges every following
 * attempt. Logout was the one control that should have cleared it and the one control that could
 * not, which left the account with no route back to a fresh QR from the dashboard at all.
 *
 * The session is not a small credentials file beside the profile — it IS the profile, the whole
 * Chromium directory at `${sessionDataPath}/_IGNORE_${sessionId}`.
 *
 * `create()` here never settles, so no client is ever assigned: precisely that state.
 */
vi.mock("@open-wa/wa-automate", () => ({
  create: vi.fn(() => new Promise(() => {})),
  ev: { on: vi.fn() },
  STATE: {},
  MessageTypes: {},
}));

let accountId: string;
let sessionDir: string;
const originalCwd = process.cwd();

beforeAll(async () => {
  const account = await prisma.whatsAppAccount.create({
    data: { label: `Logout Session Test ${randomUUID()}`, status: "AUTHENTICATION_REQUIRED" },
  });
  accountId = account.id;
  sessionDir = await mkdtemp(join(tmpdir(), "openwa-logout-"));
});

afterEach(() => {
  process.chdir(originalCwd);
});

afterAll(async () => {
  process.chdir(originalCwd);
  await prisma.whatsAppAccount.delete({ where: { id: accountId } }).catch(() => undefined);
  await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("logout with no live client", () => {
  it("removes the session profile so the next connect starts fresh", async () => {
    const { OpenWAProvider } = await import("../provider/openwa/OpenWAProvider.js");
    const sessionId = `logout-${randomUUID().slice(0, 8)}`;
    const provider = new OpenWAProvider(accountId, sessionId, sessionDir);

    // Stand in for the half-written profile an unscanned QR leaves behind.
    const profileDir = join(sessionDir, `_IGNORE_${sessionId}`);
    await mkdir(profileDir, { recursive: true });
    await writeFile(join(profileDir, "Cookies"), "stale-session-data");
    expect(existsSync(profileDir)).toBe(true);

    // No connect() has run, so there is no client — the exact case that did nothing before.
    await provider.logout();

    expect(existsSync(profileDir)).toBe(false);
  });

  it("still lands on DISCONNECTED", async () => {
    const { OpenWAProvider } = await import("../provider/openwa/OpenWAProvider.js");
    const sessionId = `logout-${randomUUID().slice(0, 8)}`;
    const provider = new OpenWAProvider(accountId, sessionId, sessionDir);

    await provider.logout();

    const account = await prisma.whatsAppAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.status).toBe("DISCONNECTED");
  });

  it("does not fail when there is no profile to remove", async () => {
    // Logging out an account that never got as far as writing one must not throw — the operator
    // pressing the button is trying to reach a clean state, not report on one.
    const { OpenWAProvider } = await import("../provider/openwa/OpenWAProvider.js");
    const provider = new OpenWAProvider(accountId, `logout-${randomUUID().slice(0, 8)}`, sessionDir);

    await expect(provider.logout()).resolves.toBeUndefined();
  });
});
