import "./helpers/requireTestDatabase.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "./helpers/projectFixtures.js";

/**
 * Abandoning a connection attempt that is waiting for a human.
 *
 * `connect()` joins an attempt already in flight, which is right for two callers wanting the same
 * thing and wrong the moment somebody wants a DIFFERENT one. Switching an account from a QR to a
 * phone code is exactly that, and it is how this surfaced: the running attempt sits inside
 * `create()` waiting for a scan that never comes (`qrTimeout: 0`), `disconnect()` could not release
 * it because it only tore down `this.client` — still null until `create()` resolves — so the
 * replacement attempt joined the old one, never read the new config, and no link code was ever
 * requested.
 *
 * `create()` here never settles, which is precisely the state being tested.
 */
vi.mock("@open-wa/wa-automate", () => ({
  create: vi.fn(() => new Promise(() => {})),
  ev: { on: vi.fn() },
  STATE: {},
  MessageTypes: {},
}));

const { create } = await import("@open-wa/wa-automate");
const { OpenWAProvider } = await import("../provider/openwa/OpenWAProvider.js");

let accountId: string;
let sessionDir: string;
// `openSession()` calls `process.chdir()`, which is process-global. Without restoring it, every
// test file that runs after this one in the same worker inherits a temp directory as its cwd.
const originalCwd = process.cwd();

beforeAll(async () => {
  const account = await prisma.whatsAppAccount.create({
    data: { label: `Abandon Test ${randomUUID()}`, status: "DISCONNECTED" },
  });
  accountId = account.id;
  sessionDir = await mkdtemp(join(tmpdir(), "openwa-abandon-"));
});

afterEach(() => {
  process.chdir(originalCwd);
  vi.mocked(create).mockClear();
});

afterAll(async () => {
  process.chdir(originalCwd);
  await prisma.whatsAppAccount.delete({ where: { id: accountId } }).catch(() => undefined);
  await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("abandoning a waiting connection attempt", () => {
  it("lets disconnect() release an attempt that is still waiting, so the next connect really starts over", async () => {
    const provider = new OpenWAProvider(accountId, `abandon-${randomUUID().slice(0, 8)}`, sessionDir);

    // Not awaited: this is the attempt parked on an unscanned QR.
    const first = provider.connect();
    first.catch(() => undefined);
    // Let openSession get as far as calling create().
    await vi.waitFor(() => expect(vi.mocked(create)).toHaveBeenCalledTimes(1));

    await provider.disconnect();

    // Not awaited, for the same reason as the first: a fresh attempt also parks on an unscanned
    // code and never settles. What is being asserted is that it STARTED — without the abandon,
    // this returned the same in-flight promise and `create()` was never called a second time, so
    // a newly chosen pairing method could not take effect.
    const second = provider.connect();
    second.catch(() => undefined);
    await vi.waitFor(() => expect(vi.mocked(create)).toHaveBeenCalledTimes(2));
  });

  it("reports an abandoned attempt as disconnected rather than as an error", async () => {
    // A red ERROR badge and a SystemLog entry would describe a problem nobody has: the operator
    // chose a different way to link, and the attempt replacing this one is already on its way.
    const provider = new OpenWAProvider(accountId, `abandon-${randomUUID().slice(0, 8)}`, sessionDir);

    const attempt = provider.connect();
    attempt.catch(() => undefined);
    await vi.waitFor(() => expect(vi.mocked(create)).toHaveBeenCalledTimes(1));

    await provider.disconnect();

    const account = await prisma.whatsAppAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.status).toBe("DISCONNECTED");
  });
});
