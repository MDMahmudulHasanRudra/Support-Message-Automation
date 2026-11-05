import "./helpers/requireTestDatabase.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults } from "@support-automation/db";
import { ISP_DIGITAL, rawPrisma } from "./helpers/projectFixtures.js";
import { claimNextOutboundMessage } from "../queue/outboundQueueProcessor.js";
import { claimNextNotification } from "../notifications/dispatcher.js";

/**
 * Queue claims with FOR UPDATE SKIP LOCKED (P1-13): a row another claimer is holding is skipped, never
 * waited on or claimed twice, so two claimers take two different rows. With one claimer nothing changes.
 *
 * The decisive case holds a row lock in a separate transaction for 2 s and claims meanwhile. The previous
 * claim (find, then conditional update) blocked on that lock and, once released, claimed the SAME row; this
 * one takes the next row at once. Rows are dated in the year 2000 so they are the oldest due in the shared
 * test database, whatever other suites left behind.
 */

const tag = randomUUID().slice(0, 8);
let accountId: string;
let heldProjectId: string;
let heldAccountId: string;
let creatorId: string;
const outboundIds: string[] = [];
const notificationIds: string[] = [];

const at = (iso: string) => new Date(iso);

async function outbound(scheduledAt: Date, projectId = ISP_DIGITAL, account = accountId): Promise<string> {
  const row = await rawPrisma.outboundMessage.create({
    data: { projectId, accountId: account, chatId: `claim-${tag}@g.us`, toPhone: "8801711000555", body: "x", actionType: "AUTO_REPLY", idempotencyKey: `claim-${randomUUID()}`, scheduledAt },
    select: { id: true },
  });
  outboundIds.push(row.id);
  return row.id;
}

async function notification(createdAt: Date): Promise<string> {
  const row = await rawPrisma.notification.create({
    data: { projectId: ISP_DIGITAL, type: "TEAMS", destination: `claim-${tag}`, payload: {}, createdAt },
    select: { id: true },
  });
  notificationIds.push(row.id);
  return row.id;
}

/** Locks one row in its own transaction, resolves `locked` once held, and releases after `holdMs`. */
function holdRowLock(table: "OutboundMessage" | "Notification", id: string, holdMs: number): { locked: Promise<void>; done: Promise<unknown> } {
  let signal!: () => void;
  const locked = new Promise<void>((resolve) => (signal = resolve));
  const done = rawPrisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SELECT id FROM "${table}" WHERE id = $1 FOR UPDATE`, id);
      signal();
      await new Promise((r) => setTimeout(r, holdMs));
    },
    { timeout: holdMs + 10_000 },
  );
  return { locked, done };
}

beforeAll(async () => {
  accountId = (await rawPrisma.whatsAppAccount.create({ data: { projectId: ISP_DIGITAL, label: `claims ${tag}` }, select: { id: true } })).id;
  creatorId = (await rawPrisma.user.create({ data: { username: `claims_${tag}`, email: `claims_${tag}@example.test`, name: "Claims", passwordHash: "x" }, select: { id: true } })).id;
  heldProjectId = (await createProjectWithDefaults({ name: `Held ${tag}`, slug: `held-${tag}`, status: "ACTIVE", creatorUserId: creatorId }, rawPrisma)).id;
  await rawPrisma.project.update({ where: { id: heldProjectId }, data: { billingHoldAt: new Date() } });
  heldAccountId = (await rawPrisma.whatsAppAccount.create({ data: { projectId: heldProjectId, label: `held ${tag}` }, select: { id: true } })).id;
});

afterEach(async () => {
  await rawPrisma.outboundMessage.deleteMany({ where: { id: { in: outboundIds.splice(0) } } });
  await rawPrisma.notification.deleteMany({ where: { id: { in: notificationIds.splice(0) } } });
});

afterAll(async () => {
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: { in: [accountId, heldAccountId] } } });
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((row) => row.table_name);
  for (let pass = 0; pass < 4; pass++) {
    for (const table of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "projectId" = $1`, heldProjectId).catch(() => undefined);
  }
  await rawPrisma.project.deleteMany({ where: { id: heldProjectId } });
  await rawPrisma.user.deleteMany({ where: { id: creatorId } });
  await rawPrisma.$disconnect();
});

describe("send queue claim", () => {
  it("skips a row another claimer holds and takes the next one at once", async () => {
    const first = await outbound(at("2000-01-01T00:00:00Z"));
    const second = await outbound(at("2000-01-01T00:00:01Z"));
    const lock = holdRowLock("OutboundMessage", first, 2000);
    await lock.locked;
    const started = Date.now();
    const claimed = await claimNextOutboundMessage();
    const tookMs = Date.now() - started;
    await lock.done;
    expect(claimed?.id).toBe(second);
    expect(tookMs).toBeLessThan(1500);
    expect((await rawPrisma.outboundMessage.findUniqueOrThrow({ where: { id: first } })).status).toBe("PENDING");
  });

  it("two claimers at once take two different rows, never the same one", async () => {
    const a = await outbound(at("2000-01-01T00:00:00Z"));
    const b = await outbound(at("2000-01-01T00:00:01Z"));
    const [x, y] = await Promise.all([claimNextOutboundMessage(), claimNextOutboundMessage()]);
    expect(new Set([x?.id, y?.id])).toEqual(new Set([a, b]));
  });

  it("with one claimer, takes the oldest due row, leaves a later one, and skips a held project's rows", async () => {
    await outbound(at("1999-01-01T00:00:00Z"), heldProjectId, heldAccountId); // oldest, but its project is held
    const oldest = await outbound(at("2000-01-01T00:00:00Z"));
    const notDue = await outbound(new Date(Date.now() + 60 * 60_000));
    expect((await claimNextOutboundMessage())?.id).toBe(oldest);
    expect((await rawPrisma.outboundMessage.findUniqueOrThrow({ where: { id: notDue } })).status).toBe("PENDING");
  });
});

describe("alert claim", () => {
  it("skips a row another claimer holds and takes the next one", async () => {
    const first = await notification(at("2000-01-01T00:00:00Z"));
    const second = await notification(at("2000-01-01T00:00:01Z"));
    const lock = holdRowLock("Notification", first, 2000);
    await lock.locked;
    const claimed = await claimNextNotification();
    await lock.done;
    expect(claimed?.id).toBe(second);
    expect(claimed?.status).toBe("RETRYING");
    expect(claimed?.attemptCount).toBe(1);
  });
});
