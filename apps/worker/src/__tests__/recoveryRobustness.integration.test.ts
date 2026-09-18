import "./helpers/requireTestDatabase.js";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@support-automation/db";
import { recoverStuckCommands } from "../commands/commandProcessor.js";
import { withTimeout } from "../util/withTimeout.js";

/**
 * The failures that turn a recoverable blip into a permanent outage.
 *
 * Both of these were introduced by a change that was correct on its own terms and stopped being
 * correct when something else moved — which is exactly the kind of regression a test catches and a
 * careful reading does not.
 */

const createdCommandIds: string[] = [];

async function command(status: "PROCESSING" | "PENDING", startedAt: Date | null) {
  const row = await prisma.workerCommand.create({
    data: { type: "RESYNC_GROUPS", status, startedAt },
  });
  createdCommandIds.push(row.id);
  return row;
}

beforeEach(() => {
  createdCommandIds.length = 0;
});

afterEach(async () => {
  await prisma.workerCommand.deleteMany({ where: { id: { in: createdCommandIds } } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("stuck-command recovery", () => {
  it("leaves a command that is genuinely still running alone", async () => {
    // The bug this is here for. `recoverStuckCommands` had no age cutoff at all, justified by a
    // comment saying "this runs once at boot" — which was true until it was also wired into the
    // five-minute recovery sweep. From then on it marked live commands FAILED: a RECONNECT waiting
    // up to ten minutes for somebody to scan a QR, or an eight-minute RESYNC_GROUPS, told the
    // operator "the worker restarted while this was running, run it again". So they ran a second
    // one on top of the first.
    const live = await command("PROCESSING", new Date(Date.now() - 60_000));

    const recovered = await recoverStuckCommands();

    expect(recovered).toBe(0);
    expect((await prisma.workerCommand.findUniqueOrThrow({ where: { id: live.id } })).status).toBe("PROCESSING");
  });

  it("releases one that has been running far past any legitimate duration", async () => {
    const wedged = await command("PROCESSING", new Date(Date.now() - 60 * 60_000));

    expect(await recoverStuckCommands()).toBe(1);

    const after = await prisma.workerCommand.findUniqueOrThrow({ where: { id: wedged.id } });
    expect(after.status).toBe("FAILED");
    // FAILED rather than back to PENDING: a re-run SEND_LIVE_TEST would put a second real message
    // into a customer's chat, and a re-run LOGOUT would tear down a session that may have come up
    // healthy since. The operator gets a reason and one click, not a silent repeat.
    expect(JSON.stringify(after.result)).toMatch(/ran for far longer/i);
  });

  it("releases everything at boot, whatever its age", async () => {
    // At boot the old no-cutoff behaviour is CORRECT and must be preserved: this process has just
    // started and the command processor does not exist yet, so nothing can be running. Making the
    // boot pass wait out a twenty-minute timer would leave a dashboard button spinning for no
    // reason after every deploy.
    const justClaimed = await command("PROCESSING", new Date());

    expect(await recoverStuckCommands({ atBoot: true })).toBe(1);
    expect((await prisma.workerCommand.findUniqueOrThrow({ where: { id: justClaimed.id } })).status).toBe("FAILED");
  });

  it("releases a row claimed before startedAt existed, but only at boot", async () => {
    // A null startedAt means the row was claimed by a process that predates the column, so it
    // cannot be aged. The periodic sweep must not guess; the boot pass knows nothing is running.
    const legacy = await command("PROCESSING", null);

    expect(await recoverStuckCommands()).toBe(0);
    expect(await recoverStuckCommands({ atBoot: true })).toBe(1);
    expect((await prisma.workerCommand.findUniqueOrThrow({ where: { id: legacy.id } })).status).toBe("FAILED");
  });

  it("never touches a command that has not been claimed", async () => {
    const pending = await command("PENDING", null);

    await recoverStuckCommands({ atBoot: true });

    expect((await prisma.workerCommand.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("PENDING");
  });
});

describe("bounded awaits", () => {
  it("gives up on a call that never settles, rather than holding its loop forever", async () => {
    // `disconnect()` awaited `client.kill()` with no timeout, against a Chromium that may itself be
    // the thing that has gone wrong. Everything upstream is an overlap-guarded loop holding a
    // boolean across the call, so one unanswering kill() silenced the registry sync or the command
    // processor for the lifetime of the process — with a green heartbeat and no log line.
    const neverSettles = new Promise<void>(() => {});

    await expect(withTimeout(neverSettles, 50, "kill")).rejects.toThrow(/kill timed out after 50ms/);
  });

  it("passes a value straight through when the call does settle", async () => {
    await expect(withTimeout(Promise.resolve("done"), 5_000)).resolves.toBe("done");
  });

  it("propagates a real failure rather than converting it into a timeout", async () => {
    // A timeout and a rejection need different responses, so the wrapper must not blur them.
    await expect(withTimeout(Promise.reject(new Error("Target closed")), 5_000)).rejects.toThrow("Target closed");
  });
});
