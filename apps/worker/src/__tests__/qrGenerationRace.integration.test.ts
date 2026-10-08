import "./helpers/requireTestDatabase.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "./helpers/projectFixtures.js";

/**
 * A stale QR render must never overwrite a newer attempt's code.
 *
 * `publishRenderedQr` renders the QR image with `await renderQrDataUrl(...)`, which is not
 * instant. Nothing previously re-checked whether the attempt it was rendering FOR was still the
 * current one by the time that render finished — so a slow render from an ABANDONED attempt could
 * finish after a newer attempt had already published its own, correct code, and silently overwrite
 * it. Observed for real: a phone-link code panel rendering the raw `data:image/png;base64,…`
 * string one character per box, because the database column held whatever the stale write left
 * there.
 *
 * The fix is a generation counter bumped once per real attempt (`attemptGeneration`), captured at
 * the moment an event fires and rechecked at the moment a write would happen. This test reproduces
 * the exact race by holding the QR renderer's promise open across a real attempt switch.
 */

const qrEventHandlers = new Map<string, (payload: string, sessionId: string) => void>();
let renderQrDataUrl: ReturnType<typeof vi.fn>;

vi.mock("@open-wa/wa-automate", () => ({
  create: vi.fn(() => new Promise(() => {})), // every attempt hangs until abandoned — same shape connectAbandon.integration.test.ts uses
  ev: {
    on: vi.fn((event: string, handler: (payload: string, sessionId: string) => void) => {
      qrEventHandlers.set(event, handler);
    }),
  },
  STATE: {},
  MessageTypes: {},
}));

vi.mock("qrcode", () => ({
  toDataURL: vi.fn(),
}));

const { create } = await import("@open-wa/wa-automate");
const qrcode = await import("qrcode");
renderQrDataUrl = vi.mocked(qrcode.toDataURL);

let accountId: string;
let sessionDir: string;
const originalCwd = process.cwd();

/** Fires a handler captured under a `ev.on` call whose event name CONTAINS this substring — the
 *  real library registers on `"qrData.**"`/`"qr.**"`, and the mock stores by that exact string. */
function fire(eventNameContains: string, payload: string, sessionId: string) {
  for (const [name, handler] of qrEventHandlers) {
    if (name.includes(eventNameContains)) handler(payload, sessionId);
  }
}

/**
 * `setState` chains its database write onto a private, serialised promise and the QR paths do not
 * await it at the call site, so a read taken straight after an event fires can legitimately still
 * see the previous value. Awaiting that chain is what makes this test deterministic — and it is not
 * a nicety: with a couple of `setImmediate`s in its place the final assertion passed even against
 * deliberately unguarded code, because it simply ran before the stale write landed. That is exactly
 * how a test ends up guarding nothing.
 */
async function flushStateWrites(provider: unknown): Promise<void> {
  // A macrotask first: the render continuation is a microtask, and it is what ENQUEUES the write.
  await new Promise((r) => setImmediate(r));
  await (provider as { pendingStateWrite: Promise<void> }).pendingStateWrite;
}

beforeAll(async () => {
  const account = await prisma.whatsAppAccount.create({
    data: { label: `QR Race Test ${randomUUID()}`, status: "DISCONNECTED" },
  });
  accountId = account.id;
  sessionDir = await mkdtemp(join(tmpdir(), "openwa-qr-race-"));
});

afterEach(() => {
  process.chdir(originalCwd);
  vi.mocked(create).mockClear();
  qrEventHandlers.clear();
});

afterAll(async () => {
  process.chdir(originalCwd);
  await prisma.whatsAppAccount.delete({ where: { id: accountId } }).catch(() => undefined);
  await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("a stale QR-mode render racing a newer phone-code attempt", () => {
  it("does not overwrite the newer attempt's code once the old render finally finishes", async () => {
    const { OpenWAProvider } = await import("../provider/openwa/OpenWAProvider.js");
    const sessionId = `qr-race-${randomUUID().slice(0, 8)}`;
    const provider = new OpenWAProvider(accountId, sessionId, sessionDir);

    await prisma.whatsAppAccount.update({
      where: { id: accountId },
      data: { pairingMethod: "QR_CODE" },
    });

    // Attempt 1: QR mode. Held open by the render's own deferred promise below.
    let resolveRender!: (dataUrl: string) => void;
    renderQrDataUrl.mockImplementationOnce(
      () => new Promise<string>((resolve) => (resolveRender = resolve)),
    );

    // `.catch` rather than `void`: abandoning attempt 1 rejects this promise with ABANDONED, and an
    // unhandled rejection would fail the run even though the assertion below is the real subject.
    provider.connect().catch(() => undefined);
    await vi.waitFor(() => expect(vi.mocked(create)).toHaveBeenCalledTimes(1));

    // The library hands the raw payload to qrData.<session> for a QR attempt. This starts the
    // async render and does NOT await it — exactly the gap the bug lived in.
    fire("qrData", "raw-qr-payload-attempt-1", sessionId);
    // Give publishRenderedQr's microtask a turn to actually call the (mocked) renderer.
    await new Promise((r) => setImmediate(r));
    expect(renderQrDataUrl).toHaveBeenCalledTimes(1);

    // The operator switches to phone-number linking while attempt 1's render is still pending.
    await prisma.whatsAppAccount.update({
      where: { id: accountId },
      data: { pairingMethod: "PHONE_CODE", pairingPhoneNumber: "+8801700000000" },
    });

    // Abandoning attempt 1 is what a real method switch does (setPairingMethod → RECONNECT).
    // openSession()'s Promise.race rejects with ABANDONED; the provider settles to DISCONNECTED.
    await provider.disconnect();

    // Attempt 2: phone-code mode, a genuinely new attempt (attemptGeneration now 2).
    provider.connect().catch(() => undefined);
    await vi.waitFor(() => expect(vi.mocked(create)).toHaveBeenCalledTimes(2));

    const realCode = "ABCD-1234";
    fire("qr.", realCode, sessionId);
    await flushStateWrites(provider);

    const afterRealCode = await prisma.whatsAppAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(afterRealCode.qrCode).toBe(realCode);

    // NOW the stale attempt-1 render finally completes — the exact moment the bug fired.
    resolveRender("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAk");
    await flushStateWrites(provider);

    const afterStaleRenderResolved = await prisma.whatsAppAccount.findUniqueOrThrow({
      where: { id: accountId },
    });
    // The whole point: a render belonging to a dead attempt must never reach the database.
    expect(afterStaleRenderResolved.qrCode).toBe(realCode);
    expect(afterStaleRenderResolved.qrCode).not.toContain("data:image");
  });
});
