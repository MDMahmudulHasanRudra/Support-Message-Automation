import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createProjectWithDefaults, ensureDefaultRoles, prisma as rawPrisma } from "@support-automation/db";
import { LocalMediaStorage } from "@support-automation/media-storage";

/**
 * Deleting one workspace permanently (PROJECT_DELETION.md): only an archived one, never a customer's last one,
 * every row of the workspace and its files gone in one go — and the customer's logins and its other workspace
 * not touched by a single row or file.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);

const { setMediaStorageForTests } = await import("@/server/mediaStorage");
const { deleteProjectData } = await import("@/server/projectDeletion");

let mediaRoot = "";
const customerIds: string[] = [];

/** A workspace with the data a real one has: WhatsApp, messages, a member, a reply, a client with a payment, a log entry. */
async function workspace(customerId: string, label: string, userId: string) {
  const project = await createProjectWithDefaults({ name: `${label} ${tag}`, slug: `${label.toLowerCase()}-${tag}`, status: "ACTIVE", creatorUserId: null, customerId }, rawPrisma);
  const pid = { projectId: project.id };
  await rawPrisma.projectAccess.create({ data: { ...pid, userId } });
  const account = await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `${label} account`, status: "CONNECTED" } });
  const group = await rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId: account.id, whatsappGroupId: `${tag}-${label}@g.us`, name: `${label} group`, isMonitored: true, isActive: true } });
  const member = await rawPrisma.internalTeamMember.create({ data: { ...pid, name: `${label} member`, phoneNumber: `8801${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`, role: "Support", status: "ACTIVE", userId } });
  const message = (over: Record<string, unknown>) =>
    rawPrisma.message.create({
      data: { ...pid, accountId: account.id, groupId: group.id, chatId: group.whatsappGroupId, whatsappMessageId: `wamid-${randomUUID()}`, senderPhone: "8801700000000", direction: "INCOMING", body: "question", normalizedBody: "question", processingStatus: "PROCESSED", timestampWa: new Date(), ...over } as never,
    });
  const question = await message({});
  const reply = await message({ senderPhone: member.phoneNumber, isFromTeamMember: true, quotedMessageId: question.id });
  await rawPrisma.supportActivity.create({ data: { ...pid, accountId: account.id, groupId: group.id, teamMemberId: member.id, messageId: reply.id, occurredAt: new Date() } });
  await rawPrisma.outboundMessage.create({
    data: { ...pid, accountId: account.id, chatId: group.whatsappGroupId, toPhone: group.whatsappGroupId, body: "answer", actionType: "MANUAL_REPLY", idempotencyKey: randomUUID(), status: "SENT", relatedMessageId: question.id, createdById: userId },
  });
  const client = await rawPrisma.client.create({ data: { ...pid, code: `C-${label}`, name: `${label} client`, createdById: userId } as never });
  const term = await rawPrisma.clientSubscription.create({ data: { ...pid, clientId: client.id, service: "Internet", startDate: new Date("2026-10-01"), endDate: new Date("2026-11-01") } });
  await rawPrisma.client.update({ where: { id: client.id }, data: { currentSubscriptionId: term.id } });
  const due = await rawPrisma.clientDue.create({ data: { ...pid, clientId: client.id, dueDate: new Date("2026-10-20"), currency: "BDT", amount: "100.00" } as never });
  const payment = await rawPrisma.clientPayment.create({
    data: { ...pid, receiptNumber: `RCPT-${label}`, clientId: client.id, currency: "BDT", amount: "40.00", method: "CASH", receivedDate: new Date("2026-10-21"), idempotencyKey: randomUUID(), recordedById: userId },
  });
  await rawPrisma.clientPaymentAllocation.create({ data: { ...pid, paymentId: payment.id, dueId: due.id, amount: "40.00" } as never });
  await rawPrisma.systemLog.create({ data: { ...pid, level: "INFO", scope: "test", message: `${label} project log` } });
  return project.id;
}

async function customer(label: string) {
  const row = await rawPrisma.customer.create({ data: { name: `${label} ${tag}` } });
  customerIds.push(row.id);
  const roles = await ensureDefaultRoles(rawPrisma, row.id);
  const user = await rawPrisma.user.create({
    data: { username: `${label}_${tag}`.toLowerCase(), name: label, passwordHash: "x", permissionModuleId: roles.administratorId, customerId: row.id },
  });
  return { customerId: row.id, userId: user.id };
}

/** How many rows of every project-owned table belong to one workspace. */
async function projectRowCounts(projectId: string): Promise<Record<string, number>> {
  const tables = await rawPrisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT "table_name" FROM information_schema.columns WHERE "table_schema" = current_schema() AND "column_name" = 'projectId' ORDER BY 1`;
  const counts: Record<string, number> = {};
  for (const { table_name } of tables) {
    const [{ n }] = await rawPrisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "${table_name}" WHERE "projectId" = $1`, projectId);
    if (Number(n) > 0) counts[table_name] = Number(n);
  }
  return counts;
}

let owner: { customerId: string; userId: string };
let targetId = "";
let siblingId = "";

beforeAll(async () => {
  mediaRoot = await mkdtemp(path.join(os.tmpdir(), "project-deletion-"));
  setMediaStorageForTests(new LocalMediaStorage(mediaRoot));
  owner = await customer("Owner");
  targetId = await workspace(owner.customerId, "Target", owner.userId);
  siblingId = await workspace(owner.customerId, "Sibling", owner.userId);
});

afterAll(async () => {
  setMediaStorageForTests(undefined);
  await rm(mediaRoot, { recursive: true, force: true });
  const { purgeCustomerData } = await import("@/server/platform/customerRemoval");
  for (const id of customerIds) await purgeCustomerData(id, "cleanup");
  await rawPrisma.customer.deleteMany({ where: { id: { in: customerIds } } });
});

describe("deleting one workspace", () => {
  it("refuses a workspace that is not archived, and deletes nothing", async () => {
    const before = await projectRowCounts(targetId);
    expect(await deleteProjectData(targetId)).toEqual({ error: expect.stringMatching(/Archive the project first/) });
    expect(await projectRowCounts(targetId)).toEqual(before);
  });

  it("erases every row and file of an archived workspace, and nothing of the customer's other one or its logins", async () => {
    await rawPrisma.project.update({ where: { id: targetId }, data: { status: "ARCHIVED" } });
    for (const area of ["whatsapp", "social"]) {
      await mkdir(path.join(mediaRoot, area, targetId), { recursive: true });
      await writeFile(path.join(mediaRoot, area, targetId, "file"), "x");
    }
    const siblingFile = path.join(mediaRoot, "whatsapp", siblingId, "file");
    await mkdir(path.dirname(siblingFile), { recursive: true });
    await writeFile(siblingFile, "x");
    const siblingBefore = await projectRowCounts(siblingId);
    expect(Object.keys(await projectRowCounts(targetId)).length).toBeGreaterThan(10);

    // Tables with a rule of their own about deletes and rewrites: an answered survey (its answer can never change),
    // a follow-up's append-only history, and routing and survey settings. All of it goes with the workspace.
    const chatId = "8801700000001@c.us";
    const account = await rawPrisma.whatsAppAccount.create({ data: { projectId: targetId, label: `Delete ${tag}`, status: "CONNECTED" } });
    await rawPrisma.whatsAppConversationState.create({ data: { projectId: targetId, accountId: account.id, chatId, conversationType: "PERSONAL" } });
    const resolved = await rawPrisma.conversationEvent.create({ data: { projectId: targetId, accountId: account.id, chatId, kind: "RESOLVE", toValue: "RESOLVED" } });
    const now = new Date();
    await rawPrisma.csatSurvey.create({
      data: { projectId: targetId, channel: "WHATSAPP_PERSONAL", accountId: account.id, chatId, resolutionEventId: resolved.id, customerKey: `wa:${chatId}`, resolvedAt: now, status: "SENT", sentAt: now, answeredAt: now, answerClosedAt: now, rating: 5, answerSource: "MESSAGE" },
    });
    await rawPrisma.csatSettings.create({ data: { projectId: targetId } });
    await rawPrisma.routingSettings.create({ data: { projectId: targetId } });
    const followUp = await rawPrisma.followUp.create({ data: { projectId: targetId, title: "Call back", dueAt: now, accountId: account.id, chatId } });
    await rawPrisma.followUpEvent.create({ data: { projectId: targetId, followUpId: followUp.id, kind: "CREATED" } });
    expect(await projectRowCounts(targetId)).toMatchObject({ CsatSurvey: 1, CsatSettings: 1, RoutingSettings: 1, FollowUp: 1, FollowUpEvent: 1 });

    const result = await deleteProjectData(targetId);
    expect(result).toMatchObject({ name: `Target ${tag}`, customerId: owner.customerId, mediaRemoved: true });

    expect(await projectRowCounts(targetId)).toEqual({});
    expect(await rawPrisma.project.count({ where: { id: targetId } })).toBe(0);
    for (const area of ["whatsapp", "social"]) await expect(stat(path.join(mediaRoot, area, targetId))).rejects.toThrow();

    expect(await projectRowCounts(siblingId)).toEqual(siblingBefore);
    await expect(stat(siblingFile)).resolves.toBeTruthy();
    expect(await rawPrisma.user.count({ where: { id: owner.userId, isActive: true } })).toBe(1);
    expect(await rawPrisma.customer.count({ where: { id: owner.customerId, removedAt: null, purgedAt: null } })).toBe(1);

    expect(await deleteProjectData(targetId)).toEqual({ error: expect.stringMatching(/no longer exists/) });
  });

  it("refuses a customer's last workspace, even archived", async () => {
    await rawPrisma.project.update({ where: { id: siblingId }, data: { status: "ARCHIVED" } });
    const before = await projectRowCounts(siblingId);
    expect(await deleteProjectData(siblingId)).toEqual({ error: expect.stringMatching(/only project/) });
    expect(await projectRowCounts(siblingId)).toEqual(before);
  });
});
