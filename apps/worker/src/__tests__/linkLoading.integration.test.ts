import "./helpers/requireTestDatabase.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { access, appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "./helpers/projectFixtures.js";

/**
 * A newly linked number gets as long as WhatsApp needs to copy its chats (GROUP_SYNC.md §10).
 *
 * The regression this pins: since 23 Sep 2026 an attempt had 240 s after the scan, then the browser
 * was killed — and WhatsApp's own "Loading your chats" froze at 30%, 50%, 80% for any number large
 * enough to need longer. The next attempt (no QR: the browser held the login) got the library's
 * 120 s and was killed again; two of those and the profile was deleted, back to 0%.
 *
 * The library is a stand-in: `create()` resolves only when the test says the chats have loaded, and
 * the test plays WhatsApp by appending to the profile's IndexedDB, which is the only thing the
 * worker watches. Every duration is shortened through the same environment variables an operator
 * would use, so the decisions are the production ones at a smaller scale.
 */

process.env.WHATSAPP_LINK_LOADING_POLL_MS = "40";
process.env.WHATSAPP_LINK_LOADING_STALL_MS = "400";
process.env.WHATSAPP_LINK_LOADING_MAX_MS = "6000";
process.env.WHATSAPP_LINK_LOADING_DETECT_BYTES = "1000";
process.env.WHATSAPP_CONNECT_WATCHDOG_MS = "500";
process.env.WHATSAPP_FIRST_CODE_TIMEOUT_MS = "350";

const handlers = new Map<string, (...args: unknown[]) => void>();
let createImpl: (config: Record<string, unknown>) => Promise<unknown> = () => new Promise(() => {});

/** A client whose every method is an async no-op; `then` stays undefined (see logoutClearsLiveSession). */
function stubClient() {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "then") return undefined;
        return async () => undefined;
      },
    },
  );
}

vi.mock("@open-wa/wa-automate", () => ({
  create: vi.fn((config: Record<string, unknown>) => createImpl(config)),
  ev: {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
    }),
  },
  STATE: {},
  MessageTypes: {},
}));

const { create } = await import("@open-wa/wa-automate");
const { OpenWAProvider } = await import("../provider/openwa/OpenWAProvider.js");

let accountId: string;
let sessionDir: string;
const originalCwd = process.cwd();
const pumps: NodeJS.Timeout[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const exists = (path: string) => access(path).then(() => true, () => false);
const markerOf = (sessionId: string) => join(sessionDir, `${sessionId}.link-pending.json`);
const leveldbOf = (sessionId: string) =>
  join(sessionDir, `_IGNORE_${sessionId}`, "Default", "IndexedDB", "https_web.whatsapp.com_0.indexeddb.leveldb");

/** Plays WhatsApp copying chats: appends to the profile's IndexedDB every `everyMs`. */
async function startCopying(sessionId: string, everyMs = 60, bytes = 2_000): Promise<() => void> {
  const dir = leveldbOf(sessionId);
  await mkdir(dir, { recursive: true });
  const timer = setInterval(() => void appendFile(join(dir, "000003.log"), "x".repeat(bytes)).catch(() => undefined), everyMs);
  pumps.push(timer);
  return () => clearInterval(timer);
}

/** A `create()` that resolves only when the test says the chats have finished loading. */
function deferredCreate() {
  let finish!: () => void;
  createImpl = () =>
    new Promise((resolve) => {
      finish = () => resolve(stubClient());
    });
  return { finish: () => finish() };
}

function emitStartup(message: string, sessionId: string) {
  handlers.get("STARTUP.**")?.(message, sessionId);
}
/** A QR attempt's raw payload (the worker renders it itself). */
function emitCode(payload: string, sessionId: string) {
  handlers.get("qrData.**")?.(payload, sessionId);
}
/** A phone-code attempt's code, which arrives on the `qr.**` event as plain text. */
function emitLinkCode(code: string, sessionId: string) {
  handlers.get("qr.**")?.(code, sessionId);
}
const createdOnce = () => vi.waitFor(() => expect(vi.mocked(create)).toHaveBeenCalled(), { timeout: 3_000 });
const status = async () => (await prisma.whatsAppAccount.findUniqueOrThrow({ where: { id: accountId } })).status;

beforeAll(async () => {
  const account = await prisma.whatsAppAccount.create({
    data: { label: `Link Loading Test ${randomUUID()}`, status: "DISCONNECTED", pairingMethod: "QR_CODE" },
  });
  accountId = account.id;
  sessionDir = await mkdtemp(join(tmpdir(), "openwa-link-loading-"));
});

beforeEach(async () => {
  vi.mocked(create).mockClear();
  createImpl = () => new Promise(() => {});
  await prisma.whatsAppAccount.update({ where: { id: accountId }, data: { pairingMethod: "QR_CODE", pairingPhoneNumber: null } });
});

afterEach(() => {
  for (const timer of pumps.splice(0)) clearInterval(timer);
  process.chdir(originalCwd);
});

afterAll(async () => {
  process.chdir(originalCwd);
  await prisma.whatsAppAccount.delete({ where: { id: accountId } }).catch(() => undefined);
  await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("after a scan, the attempt waits for as long as WhatsApp keeps copying chats", () => {
  it("survives a load many times longer than the stall limit, and connects when it finishes", async () => {
    const sessionId = `load-${randomUUID().slice(0, 8)}`;
    const provider = new OpenWAProvider(accountId, sessionId, sessionDir);
    const { finish } = deferredCreate();

    const connecting = provider.connect();
    await createdOnce();
    emitStartup("QR code scanned. Loading session...", sessionId);
    const stopCopying = await startCopying(sessionId);

    // Six stall periods of steady progress. A fixed post-scan limit of any length shorter than the
    // load (240 s in production until now) would have killed it here.
    await sleep(2_400);
    expect(vi.mocked(create)).toHaveBeenCalledTimes(1); // still the same, uninterrupted attempt
    expect(await exists(markerOf(sessionId))).toBe(true); // the accepted scan is on record meanwhile

    stopCopying();
    finish();
    await connecting;
    expect(provider.getConnectionStatus()).toBe("CONNECTED");
    // Loaded: nothing left to resume.
    expect(await exists(markerOf(sessionId))).toBe(false);
  });

  it("gives up when WhatsApp stops sending — and keeps the record so the next attempt resumes", async () => {
    const sessionId = `stall-${randomUUID().slice(0, 8)}`;
    const provider = new OpenWAProvider(accountId, sessionId, sessionDir);
    deferredCreate();

    const connecting = provider.connect();
    await createdOnce();
    emitStartup("QR code scanned. Loading session...", sessionId);
    const stopCopying = await startCopying(sessionId);
    await sleep(300);
    stopCopying(); // the phone went offline mid-copy

    await expect(connecting).rejects.toThrow(/stopped sending this number's chats/i);
    expect(await status()).toBe("ERROR");
    expect(await exists(markerOf(sessionId))).toBe(true);
  });

  it("is bounded in total even while progress continues", async () => {
    const sessionId = `cap-${randomUUID().slice(0, 8)}`;
    const provider = new OpenWAProvider(accountId, sessionId, sessionDir);
    deferredCreate();
    const connecting = provider.connect();
    await createdOnce();
    emitStartup("QR code scanned. Loading session...", sessionId);
    await startCopying(sessionId);
    await expect(connecting).rejects.toThrow(/still copying this number's chats/i);
  }, 15_000);
});

describe("an interrupted load is resumed, never restarted from 0%", () => {
  async function interruptedLink(sessionId: string) {
    await writeFile(markerOf(sessionId), JSON.stringify({ scannedAt: Date.now() - 60_000 }));
    // The browser holds the login, so WhatsApp resumes its "Loading your chats" without a code.
    await mkdir(leveldbOf(sessionId), { recursive: true });
  }

  it("waits on progress past the library's own 120 s race (authTimeout 0) and past the no-code deadline", async () => {
    const sessionId = `resume-${randomUUID().slice(0, 8)}`;
    await interruptedLink(sessionId);
    const provider = new OpenWAProvider(accountId, sessionId, sessionDir);
    const { finish } = deferredCreate();

    const connecting = provider.connect();
    await createdOnce();
    // The library's race is what killed every resume: it must be switched off for this attempt.
    expect(vi.mocked(create).mock.calls[0]![0]).toMatchObject({ authTimeout: 0 });
    const stopCopying = await startCopying(sessionId);

    await sleep(1_200); // well past the 350 ms no-code deadline: no code will ever appear here
    expect(vi.mocked(create)).toHaveBeenCalledTimes(1);
    const row = await prisma.whatsAppAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(row.connectionStage).toBe("AUTHENTICATED"); // the dashboard says chats are being copied

    stopCopying();
    finish();
    await connecting;
    expect(provider.getConnectionStatus()).toBe("CONNECTED");
    expect(await exists(markerOf(sessionId))).toBe(false);
  });

  it("an ordinary attempt keeps the library's own race", async () => {
    const sessionId = `plain-${randomUUID().slice(0, 8)}`;
    const provider = new OpenWAProvider(accountId, sessionId, sessionDir);
    const connecting = provider.connect().catch(() => undefined);
    await createdOnce();
    expect(vi.mocked(create).mock.calls[0]![0]).toMatchObject({ authTimeout: 120 });
    await connecting;
  });

  it("never deletes the profile of an accepted scan, however many attempts failed before", async () => {
    const sessionId = `keep-${randomUUID().slice(0, 8)}`;
    await interruptedLink(sessionId);
    await writeFile(join(leveldbOf(sessionId), "CURRENT"), "the half-copied chats");
    const provider = new OpenWAProvider(accountId, sessionId, sessionDir);
    // Two failures in a row with no code — exactly what used to trigger the reset.
    (provider as unknown as { codelessFailures: number }).codelessFailures = 2;
    createImpl = async () => {
      throw new Error("browser closed");
    };

    await provider.connect().catch(() => undefined);
    expect(await exists(join(leveldbOf(sessionId), "CURRENT"))).toBe(true);
    expect(await exists(markerOf(sessionId))).toBe(true);
  });

  it("when WhatsApp asks for a new code instead, the half-finished link is forgotten and a normal window starts", async () => {
    const sessionId = `gone-${randomUUID().slice(0, 8)}`;
    await interruptedLink(sessionId);
    const provider = new OpenWAProvider(accountId, sessionId, sessionDir);
    deferredCreate();

    const connecting = provider.connect();
    await createdOnce();
    emitCode("2@a-fresh-qr-payload", sessionId); // the phone removed the device: a QR appears
    await vi.waitFor(async () => expect(await exists(markerOf(sessionId))).toBe(false), { timeout: 2_000 });
    // Nobody scans: the ordinary linking window applies again, not the load watch.
    await expect(connecting).rejects.toThrow(/linking window/i);
  });

  it("a marker older than the resume limit is not honoured", async () => {
    const sessionId = `old-${randomUUID().slice(0, 8)}`;
    await writeFile(markerOf(sessionId), JSON.stringify({ scannedAt: Date.now() - 7 * 60 * 60_000 }));
    const provider = new OpenWAProvider(accountId, sessionId, sessionDir);
    const connecting = provider.connect().catch(() => undefined);
    await createdOnce();
    expect(vi.mocked(create).mock.calls[0]![0]).toMatchObject({ authTimeout: 120 });
    expect(await exists(markerOf(sessionId))).toBe(false);
    await connecting;
  });
});

describe("a phone-code pairing, which announces nothing when the code is accepted", () => {
  beforeEach(async () => {
    await prisma.whatsAppAccount.update({
      where: { id: accountId },
      data: { pairingMethod: "PHONE_CODE", pairingPhoneNumber: "8801700000001" },
    });
  });

  it("is recognised by the chats arriving when its window ends, and allowed to finish", async () => {
    const sessionId = `phone-${randomUUID().slice(0, 8)}`;
    const provider = new OpenWAProvider(accountId, sessionId, sessionDir);
    const { finish } = deferredCreate();

    const connecting = provider.connect();
    await createdOnce();
    emitLinkCode("ABCD-EFGH", sessionId); // the link code on screen
    const stopCopying = await startCopying(sessionId); // the person typed it; chats start arriving

    await sleep(1_200); // past the 500 ms linking window
    expect(vi.mocked(create)).toHaveBeenCalledTimes(1);
    expect(await exists(markerOf(sessionId))).toBe(true);

    stopCopying();
    finish();
    await connecting;
    expect(provider.getConnectionStatus()).toBe("CONNECTED");
  });

  it("an unused code still expires like before", async () => {
    const sessionId = `phone-idle-${randomUUID().slice(0, 8)}`;
    const provider = new OpenWAProvider(accountId, sessionId, sessionDir);
    deferredCreate();
    const connecting = provider.connect();
    await createdOnce();
    emitLinkCode("WXYZ-1234", sessionId);
    await expect(connecting).rejects.toThrow(/linking window/i);
    expect(await exists(markerOf(sessionId))).toBe(false);
  });
});

describe("a QR attempt is never extended by guesswork", () => {
  it("expires with chats-sized growth if no scan was ever accepted", async () => {
    const sessionId = `qr-idle-${randomUUID().slice(0, 8)}`;
    const provider = new OpenWAProvider(accountId, sessionId, sessionDir);
    deferredCreate();
    const connecting = provider.connect();
    await createdOnce();
    emitCode("2@an-unscanned-qr", sessionId);
    await startCopying(sessionId);
    await expect(connecting).rejects.toThrow(/linking window/i);
    expect(await exists(markerOf(sessionId))).toBe(false);
  });
});
