import "./helpers/requireTestDatabase.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults } from "@support-automation/db";
import { ISP_DIGITAL, rawPrisma } from "./helpers/projectFixtures.js";
import { claimNextOutboundMessage, recoverStuckOutboundMessages } from "../queue/outboundQueueProcessor.js";
import { claimNextNotification } from "../notifications/dispatcher.js";
import { claimNextChannelMessage } from "../channels/outboundProcessor.js";
import { claimNextEmail } from "../email/outboxProcessor.js";
import { withProject } from "../project/context.js";

/**
 * Queue claims with FOR UPDATE SKIP LOCKED (P1-13): a row another claimer is holding is skipped, never
 * waited on or claimed twice, so two claimers take two different rows. With one claimer nothing changes.
 *
 * The decisive case holds a row lock in a separate transaction for 2 s and claims meanwhile. The previous
 * claim (find, then conditional update) blocked on that lock and, once released, claimed the SAME row; this
 * one takes the next row at once. The two shared queues (send, alerts) are drained in one global order, so
 * their rows are dated in the year 2000 to be the oldest due in the shared test database, whatever other
 * suites left behind. The channel and email queues are claimed per project, in projects of their own.
 *
 * Email also proves its limits hold under concurrent claimers: the counts run inside the claim under a
 * per-project advisory lock, so N claimers racing at "one below the limit" claim exactly one row.
 */

const tag = randomUUID().slice(0, 8);
let accountId: string;
let heldProjectId: string;
let heldAccountId: string;
let projectA: string;
let projectB: string;
let creatorId: string;
const outboundIds: string[] = [];
const notificationIds: string[] = [];
const conn: Record<string, { connectionId: string; conversationId: string }> = {};

const at = (iso: string) => new Date(iso);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function outbound(scheduledAt: Date, projectId = ISP_DIGITAL, account = accountId, status: "PENDING" | "PROCESSING" | "SENT" | "FAILED" | "CANCELLED" | "SKIPPED" = "PENDING"): Promise<string> {
  const row = await rawPrisma.outboundMessage.create({
    data: { projectId, accountId: account, chatId: `claim-${tag}@g.us`, toPhone: "8801711000555", body: "x", actionType: "AUTO_REPLY", idempotencyKey: `claim-${randomUUID()}`, scheduledAt, status },
    select: { id: true },
  });
  outboundIds.push(row.id);
  return row.id;
}

async function notification(createdAt: Date, status: "PENDING" | "SENT" | "FAILED" | "RETRYING" = "PENDING"): Promise<string> {
  const row = await rawPrisma.notification.create({
    data: { projectId: ISP_DIGITAL, type: "TEAMS", destination: `claim-${tag}`, payload: {}, createdAt, status },
    select: { id: true },
  });
  notificationIds.push(row.id);
  return row.id;
}

type ChannelStatus = "QUEUED" | "SENDING" | "SENT" | "FAILED" | "UNKNOWN";
async function channelMessage(projectId: string, createdAt: Date, extra: { deliveryStatus?: ChannelStatus; nextAttemptAt?: Date | null } = {}): Promise<string> {
  const { connectionId, conversationId } = conn[projectId]!;
  const row = await rawPrisma.channelMessage.create({
    data: { projectId, conversationId, connectionId, type: "TELEGRAM", direction: "OUTBOUND", senderType: "AGENT", text: "x", occurredAt: createdAt, createdAt, deliveryStatus: "QUEUED", idempotencyKey: `claim-${randomUUID()}`, ...extra },
    select: { id: true },
  });
  return row.id;
}

type EmailStatus = "QUEUED" | "SENDING" | "ACCEPTED" | "FAILED" | "UNKNOWN";
async function email(projectId: string, createdAt: Date, extra: { status?: EmailStatus; nextAttemptAt?: Date | null; sendingStartedAt?: Date | null } = {}): Promise<string> {
  const row = await rawPrisma.emailOutbox.create({
    data: { projectId, purpose: "TEST", toAddress: `claims-${tag}@example.test`, subject: "s", bodyText: "b", idempotencyKey: `claim-${randomUUID()}`, settingsVersion: 1, createdAt, ...extra },
    select: { id: true },
  });
  return row.id;
}

type Table = "OutboundMessage" | "Notification" | "ChannelMessage" | "EmailOutbox";
/** Locks one row in its own transaction, resolves `locked` once held, and releases after `holdMs`. */
function holdRowLock(table: Table, id: string, holdMs: number): { locked: Promise<void>; done: Promise<unknown> } {
  return holdInTransaction(holdMs, (tx) => tx.$executeRawUnsafe(`SELECT id FROM "${table}" WHERE id = $1 FOR UPDATE`, id));
}

/** Holds the email rate lock of one project, as a claimer that is counting would. */
function holdEmailRateLock(projectId: string, holdMs: number) {
  return holdInTransaction(holdMs, (tx) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`email-outbox-rate:${projectId}`})::bigint)`);
}

function holdInTransaction(holdMs: number, take: (tx: Parameters<Parameters<typeof rawPrisma.$transaction>[0]>[0]) => Promise<unknown>) {
  let signal!: () => void;
  const locked = new Promise<void>((resolve) => (signal = resolve));
  const done = rawPrisma.$transaction(
    async (tx) => {
      await take(tx);
      signal();
      await sleep(holdMs);
    },
    { timeout: holdMs + 10_000 },
  );
  return { locked, done };
}

const statusOfChannel = async (id: string) => (await rawPrisma.channelMessage.findUniqueOrThrow({ where: { id } })).deliveryStatus;
const statusOfEmail = async (id: string) => (await rawPrisma.emailOutbox.findUniqueOrThrow({ where: { id } })).status;
const claimEmail = (projectId: string, limits: { maxPerMinute: number; maxPerDay: number } | null = null, now = new Date()) => withProject(projectId, () => claimNextEmail(now, limits));
const claimChannel = (projectId: string, now = new Date()) => withProject(projectId, () => claimNextChannelMessage(now));

beforeAll(async () => {
  accountId = (await rawPrisma.whatsAppAccount.create({ data: { projectId: ISP_DIGITAL, label: `claims ${tag}` }, select: { id: true } })).id;
  creatorId = (await rawPrisma.user.create({ data: { username: `claims_${tag}`, email: `claims_${tag}@example.test`, name: "Claims", passwordHash: "x" }, select: { id: true } })).id;
  const project = async (name: string) => (await createProjectWithDefaults({ name: `${name} ${tag}`, slug: `${name.toLowerCase()}-${tag}`, status: "ACTIVE", creatorUserId: creatorId }, rawPrisma)).id;
  heldProjectId = await project("Held");
  await rawPrisma.project.update({ where: { id: heldProjectId }, data: { billingHoldAt: new Date() } });
  heldAccountId = (await rawPrisma.whatsAppAccount.create({ data: { projectId: heldProjectId, label: `held ${tag}` }, select: { id: true } })).id;
  projectA = await project("ClaimA");
  projectB = await project("ClaimB");
  for (const projectId of [projectA, projectB]) {
    const connectionId = (await rawPrisma.channelConnection.create({ data: { projectId, type: "TELEGRAM", name: "@bot", status: "CONNECTED", webhookKey: `claims-${projectId}` }, select: { id: true } })).id;
    const conversationId = (await rawPrisma.channelConversation.create({ data: { projectId, connectionId, type: "TELEGRAM", externalThreadId: `t-${tag}` }, select: { id: true } })).id;
    conn[projectId] = { connectionId, conversationId };
  }
});

afterEach(async () => {
  await rawPrisma.outboundMessage.deleteMany({ where: { id: { in: outboundIds.splice(0) } } });
  await rawPrisma.notification.deleteMany({ where: { id: { in: notificationIds.splice(0) } } });
  await rawPrisma.channelMessage.deleteMany({ where: { projectId: { in: [projectA, projectB] } } });
  await rawPrisma.emailOutbox.deleteMany({ where: { projectId: { in: [projectA, projectB] } } });
});

afterAll(async () => {
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: { in: [accountId, heldAccountId] } } });
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((row) => row.table_name);
  const projects = [heldProjectId, projectA, projectB];
  for (let pass = 0; pass < 4; pass++) {
    for (const table of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "projectId" = ANY($1)`, projects).catch(() => undefined);
  }
  await rawPrisma.project.deleteMany({ where: { id: { in: projects } } });
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

  it("never claims a row that is already being sent, sent, failed, cancelled or skipped", async () => {
    for (const status of ["PROCESSING", "SENT", "FAILED", "CANCELLED", "SKIPPED"] as const) await outbound(at("1998-01-01T00:00:00Z"), ISP_DIGITAL, accountId, status);
    const pending = await outbound(at("2000-01-01T00:00:00Z"));
    const claimed = await claimNextOutboundMessage();
    expect(claimed?.id).toBe(pending);
    expect(claimed?.status).toBe("PROCESSING");
  });

  it("a row stranded by a dead worker is claimable again only after recovery releases it", async () => {
    const stranded = await outbound(at("2000-01-01T00:00:00Z"), ISP_DIGITAL, accountId, "PROCESSING");
    await rawPrisma.$executeRaw`UPDATE "OutboundMessage" SET "updatedAt" = now() - interval '1 hour' WHERE id = ${stranded}`;
    expect((await claimNextOutboundMessage())?.id).not.toBe(stranded);
    expect(await recoverStuckOutboundMessages()).toBeGreaterThanOrEqual(1);
    expect((await claimNextOutboundMessage())?.id).toBe(stranded);
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

  it("two claimers at once take two different alerts", async () => {
    const a = await notification(at("2000-01-01T00:00:00Z"));
    const b = await notification(at("2000-01-01T00:00:01Z"));
    const [x, y] = await Promise.all([claimNextNotification(), claimNextNotification()]);
    expect(new Set([x?.id, y?.id])).toEqual(new Set([a, b]));
  });

  it("never claims an alert already being retried, sent or failed", async () => {
    for (const status of ["RETRYING", "SENT", "FAILED"] as const) await notification(at("1998-01-01T00:00:00Z"), status);
    const pending = await notification(at("2000-01-01T00:00:00Z"));
    expect((await claimNextNotification())?.id).toBe(pending);
  });
});

describe("channel reply claim", () => {
  it("skips a row another claimer holds and takes the next one at once", async () => {
    const first = await channelMessage(projectA, at("2000-01-01T00:00:00Z"));
    const second = await channelMessage(projectA, at("2000-01-01T00:00:01Z"));
    const lock = holdRowLock("ChannelMessage", first, 2000);
    await lock.locked;
    const started = Date.now();
    const claimed = await claimChannel(projectA);
    const tookMs = Date.now() - started;
    await lock.done;
    expect(claimed).toEqual({ id: second, won: true });
    expect(tookMs).toBeLessThan(1500);
    expect(await statusOfChannel(first)).toBe("QUEUED");
    expect(await statusOfChannel(second)).toBe("SENDING");
  });

  it("two claimers at once take two different rows", async () => {
    const a = await channelMessage(projectA, at("2000-01-01T00:00:00Z"));
    const b = await channelMessage(projectA, at("2000-01-01T00:00:01Z"));
    const [x, y] = await Promise.all([claimChannel(projectA), claimChannel(projectA)]);
    expect(new Set([x?.id, y?.id])).toEqual(new Set([a, b]));
  });

  it("claims only the current project's rows, only when due, and never an unknown or failed outcome", async () => {
    await channelMessage(projectB, at("1999-01-01T00:00:00Z")); // older, other project
    await channelMessage(projectA, at("1999-06-01T00:00:00Z"), { deliveryStatus: "UNKNOWN" });
    await channelMessage(projectA, at("1999-06-02T00:00:00Z"), { deliveryStatus: "FAILED" });
    await channelMessage(projectA, at("1999-06-03T00:00:00Z"), { nextAttemptAt: new Date(Date.now() + 60 * 60_000) }); // retry not due yet
    const due = await channelMessage(projectA, at("2000-01-01T00:00:00Z"));
    expect(await claimChannel(projectA)).toEqual({ id: due, won: true });
    expect(await claimChannel(projectA)).toBeNull();
    const attempts = (await rawPrisma.channelMessage.findUniqueOrThrow({ where: { id: due } })).attempts;
    expect(attempts).toBe(1);
  });
});

describe("email claim", () => {
  it("skips a row another claimer holds and takes the next one at once", async () => {
    const first = await email(projectA, at("2000-01-01T00:00:00Z"));
    const second = await email(projectA, at("2000-01-01T00:00:01Z"));
    const lock = holdRowLock("EmailOutbox", first, 2000);
    await lock.locked;
    const started = Date.now();
    const claimed = await claimEmail(projectA);
    const tookMs = Date.now() - started;
    await lock.done;
    expect(claimed).toEqual({ id: second, won: true });
    expect(tookMs).toBeLessThan(1500);
    expect(await statusOfEmail(first)).toBe("QUEUED");
  });

  it("two claimers at once take two different rows", async () => {
    const a = await email(projectA, at("2000-01-01T00:00:00Z"));
    const b = await email(projectA, at("2000-01-01T00:00:01Z"));
    const [x, y] = await Promise.all([claimEmail(projectA), claimEmail(projectA)]);
    expect(new Set([x?.id, y?.id])).toEqual(new Set([a, b]));
  });

  // Deterministic on purpose: racing claims with Promise.all PASSED with the advisory lock deleted (the
  // round trips serialise them), so it proved nothing. Here another claimer is caught mid-claim — it holds the
  // project's rate lock and has moved a row to SENDING, not yet committed. Without the lock this claim counts
  // zero, skips the locked row and claims the next: two sends against a limit of one. With it, it waits, then
  // counts the committed SENDING row and claims nothing.
  it("a claimer at one below the per-minute limit waits for one mid-claim, then claims nothing", async () => {
    const first = await email(projectA, at("2000-01-01T00:00:00Z"));
    await email(projectA, at("2000-01-01T00:00:01Z"));
    const other = holdInTransaction(1500, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`email-outbox-rate:${projectA}`})::bigint)`;
      await tx.emailOutbox.update({ where: { id: first }, data: { status: "SENDING", sendingStartedAt: new Date(), attempts: { increment: 1 } } });
    });
    await other.locked;
    const claimed = await claimEmail(projectA, { maxPerMinute: 1, maxPerDay: 500 });
    await other.done;
    expect(claimed).toBeNull();
    expect(await rawPrisma.emailOutbox.count({ where: { projectId: projectA, status: "SENDING" } })).toBe(1);
    expect(await rawPrisma.emailOutbox.count({ where: { projectId: projectA, status: "QUEUED" } })).toBe(1);
  });

  it("claimers racing below the limit never claim more rows than the limit allows", async () => {
    for (let i = 0; i < 4; i++) await email(projectA, at(`2000-01-01T00:00:0${i}Z`));
    const results = await Promise.all([0, 1, 2, 3].map(() => claimEmail(projectA, { maxPerMinute: 2, maxPerDay: 500 })));
    expect(results.filter((r) => r?.won)).toHaveLength(2);
    expect(await rawPrisma.emailOutbox.count({ where: { projectId: projectA, status: "SENDING" } })).toBe(2);
  });

  it("a limit already reached leaves the queue untouched; another project's sends do not count toward it", async () => {
    const now = new Date();
    await email(projectA, at("1999-01-01T00:00:00Z"), { status: "ACCEPTED", sendingStartedAt: new Date(now.getTime() - 10_000) });
    for (let i = 0; i < 5; i++) await email(projectB, at("1999-01-01T00:00:00Z"), { status: "ACCEPTED", sendingStartedAt: new Date(now.getTime() - 10_000) });
    const queued = await email(projectA, at("2000-01-01T00:00:00Z"));
    expect(await claimEmail(projectA, { maxPerMinute: 1, maxPerDay: 500 }, now)).toBeNull();
    expect(await claimEmail(projectA, { maxPerMinute: 10, maxPerDay: 1 }, now)).toBeNull();
    expect(await statusOfEmail(queued)).toBe("QUEUED");
    // Project B's five sends are B's: A is still one below a limit of two.
    expect(await claimEmail(projectA, { maxPerMinute: 2, maxPerDay: 500 }, now)).toEqual({ id: queued, won: true });
  });

  it("claims only the current project's rows, only when due, and never a failed or unknown outcome", async () => {
    const older = await email(projectB, at("1999-01-01T00:00:00Z"));
    await email(projectA, at("1999-06-01T00:00:00Z"), { status: "UNKNOWN" });
    await email(projectA, at("1999-06-02T00:00:00Z"), { status: "FAILED" });
    await email(projectA, at("1999-06-03T00:00:00Z"), { nextAttemptAt: new Date(Date.now() + 60 * 60_000) });
    const due = await email(projectA, at("2000-01-01T00:00:00Z"));
    expect(await claimEmail(projectA)).toEqual({ id: due, won: true });
    expect(await claimEmail(projectA)).toBeNull();
    expect(await statusOfEmail(older)).toBe("QUEUED");
  });

  it("an idle tick takes no rate lock: it returns at once while another claimer holds it", async () => {
    const lock = holdEmailRateLock(projectA, 2000);
    await lock.locked;
    const started = Date.now();
    const claimed = await claimEmail(projectA, { maxPerMinute: 10, maxPerDay: 500 });
    const tookMs = Date.now() - started;
    await lock.done;
    expect(claimed).toBeNull();
    expect(tookMs).toBeLessThan(1500);
  });
});
