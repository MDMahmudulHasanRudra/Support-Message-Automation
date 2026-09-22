import "./helpers/requireTestDatabase.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@support-automation/db";

/**
 * An attempt that never produces a code must fail fast, not hold the queue.
 *
 * The connect watchdog is ten minutes because it bounds a HUMAN: a code is on screen and somebody
 * has to walk to a phone and scan it. It was also the only bound on a completely different case —
 * an attempt that reaches no linking screen at all, because the browser failed to start, WhatsApp
 * Web never loaded, or a network call before the QR hung. Nothing is on screen then, so nobody is
 * scanning, and ten minutes is ten minutes of an operator watching a spinner.
 *
 * It compounds: the command processor is strictly serial, so the stalled attempt holds it and
 * every later Connect the operator presses queues behind one that is never going to finish — the
 * "N commands waiting for the worker" banner beside a dialog that never fills in.
 *
 * `create()` here never settles and emits no QR, which is exactly that state.
 */
vi.mock("@open-wa/wa-automate", () => ({
  create: vi.fn(() => new Promise(() => {})),
  ev: { on: vi.fn() },
  STATE: {},
  MessageTypes: {},
}));

const { create } = await import("@open-wa/wa-automate");

let accountId: string;
let sessionDir: string;
// `openSession()` calls `process.chdir()`, which is process-global.
const originalCwd = process.cwd();
const originalTimeout = process.env.WHATSAPP_FIRST_CODE_TIMEOUT_MS;

beforeAll(async () => {
  // Short enough to assert in a test; the production default is minutes, because it is also
  // racing a session restore that legitimately emits no code at all.
  process.env.WHATSAPP_FIRST_CODE_TIMEOUT_MS = "400";
  const account = await prisma.whatsAppAccount.create({
    data: { label: `First Code Timeout Test ${randomUUID()}`, status: "DISCONNECTED" },
  });
  accountId = account.id;
  sessionDir = await mkdtemp(join(tmpdir(), "openwa-firstcode-"));
});

afterEach(() => {
  process.chdir(originalCwd);
  vi.mocked(create).mockClear();
});

afterAll(async () => {
  process.chdir(originalCwd);
  if (originalTimeout === undefined) delete process.env.WHATSAPP_FIRST_CODE_TIMEOUT_MS;
  else process.env.WHATSAPP_FIRST_CODE_TIMEOUT_MS = originalTimeout;
  await prisma.whatsAppAccount.delete({ where: { id: accountId } }).catch(() => undefined);
  await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("an attempt that never produces a code", () => {
  it("rejects rather than waiting out the human-scan watchdog", async () => {
    const { OpenWAProvider } = await import("../provider/openwa/OpenWAProvider.js");
    const provider = new OpenWAProvider(accountId, `firstcode-${randomUUID().slice(0, 8)}`, sessionDir);

    // Without the deadline this promise simply never settles, and the assertion times out.
    await expect(provider.connect()).rejects.toThrow(/never reached WhatsApp's linking screen/i);
  });

  it("leaves the attempt released, so the next connect genuinely starts over", async () => {
    const { OpenWAProvider } = await import("../provider/openwa/OpenWAProvider.js");
    const provider = new OpenWAProvider(accountId, `firstcode-${randomUUID().slice(0, 8)}`, sessionDir);

    await provider.connect().catch(() => undefined);
    const callsAfterFirst = vi.mocked(create).mock.calls.length;

    // The real point: a stalled attempt must not become the answer every later caller joins.
    // `connect()` is re-entrant and returns an in-flight attempt — if the failed one were still
    // held, create() would never be called again and the operator's next press would do nothing.
    await provider.connect().catch(() => undefined);
    expect(vi.mocked(create).mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it("records the failure on the account rather than leaving it looking busy", async () => {
    const { OpenWAProvider } = await import("../provider/openwa/OpenWAProvider.js");
    const provider = new OpenWAProvider(accountId, `firstcode-${randomUUID().slice(0, 8)}`, sessionDir);

    await provider.connect().catch(() => undefined);

    // An account left in WAITING_FOR_QR/RECONNECTING is the state the dashboard prints as "the
    // worker is bringing this session back up" — reassuring, and wrong, when nothing is.
    const account = await prisma.whatsAppAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.status).toBe("ERROR");
  });
});
