import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createProjectWithDefaults, ensureDefaultRoles, PLATFORM_LOG_CUSTOMER, prisma as rawPrisma } from "@support-automation/db";
import { LocalMediaStorage } from "@support-automation/media-storage";

/**
 * Removing and deleting a customer from the platform (CUSTOMER_REMOVAL.md), through the real platform
 * actions: the typed name and the operator's password, Remove (everything off, every row kept) and
 * Restore (exactly what was changed comes back), Delete permanently (every workspace row, every login
 * and address gone, the platform's billing kept), and — the point of all of it — another customer's
 * software not touched by a single row.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const PASSWORD = "Test-password-123";
const ADMIN_HOST = `admin-${tag}.remove.test`;

const request = { host: ADMIN_HOST };
const jar = new Map<string, string>();
vi.mock("next/headers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/headers")>()),
  headers: async () => new Headers({ "x-relqivo-host": request.host, "user-agent": "vitest" }),
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string | { name: string }) => void jar.delete(typeof name === "string" ? name : name.name),
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  redirect: (to: string) => {
    throw Object.assign(new Error(`REDIRECT ${to}`), { redirectTo: to });
  },
}));

const auth = await import("@/server/auth");
const { platformLogin } = await import("@/app/platform/login/actions");
const { forgetHostScopes } = await import("@/server/hostScope");
const { forgetFoundingCustomer } = await import("@/server/tenant");
const { setMediaStorageForTests } = await import("@/server/mediaStorage");
const platform = await import("@/server/platform/actions/customers");

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

let mediaRoot = "";
let operatorId = "";
let foundingId: string | null = null;
let foundingCreatedHere = false;

interface Fixture {
  customerId: string;
  name: string;
  projectId: string;
  userIds: string[];
  domainId: string;
}

/** A customer with one workspace full of the data a real one has, two logins, an address and a plan. */
async function customerWithData(label: string): Promise<Fixture> {
  const name = `${label} ${tag}`;
  const customer = await rawPrisma.customer.create({ data: { name } });
  const roles = await ensureDefaultRoles(rawPrisma, customer.id);
  const project = await createProjectWithDefaults({ name, slug: `${label.toLowerCase()}-${tag}`, status: "ACTIVE", creatorUserId: null, customerId: customer.id }, rawPrisma);
  const pid = { projectId: project.id };
  const users = await Promise.all(
    ["owner", "staff"].map((who) =>
      rawPrisma.user.create({
        data: { username: `${label}_${who}_${tag}`.toLowerCase(), name: who, passwordHash: auth.hashPassword(PASSWORD), permissionModuleId: roles.administratorId, customerId: customer.id },
      }),
    ),
  );
  for (const u of users) {
    await rawPrisma.projectAccess.create({ data: { projectId: project.id, userId: u.id } });
    await rawPrisma.userSession.create({ data: { userId: u.id, secretHash: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) } });
  }
  const domain = await rawPrisma.customerDomain.create({ data: { customerId: customer.id, hostname: `${label.toLowerCase()}-${tag}.remove.test`, status: "ACTIVE", verificationToken: randomUUID() } });
  await rawPrisma.userInvitation.create({ data: { customerId: customer.id, projectId: project.id, name: "Invited", tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 86_400_000) } });
  await rawPrisma.subscription.create({
    data: { customerId: customer.id, planName: "Plan", currency: "BDT", priceMinor: BigInt(1000), interval: "MONTHLY", startsAt: new Date(), paidThrough: new Date(Date.now() + 86_400_000) } as never,
  });

  // The workspace: WhatsApp, messages (one quoting another), a team member, support activity, an AI
  // decision, an outbound reply, a client with a subscription that is its current one, a due and a
  // payment recorded by one of the logins (an immutable row pointing at a user), and a System Log entry.
  const account = await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `${label} account`, status: "CONNECTED" } });
  const group = await rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId: account.id, whatsappGroupId: `${tag}-${label}@g.us`, name: `${label} group`, isMonitored: true, isActive: true } });
  const member = await rawPrisma.internalTeamMember.create({ data: { ...pid, name: `${label} member`, phoneNumber: `8801${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`, role: "Support", status: "ACTIVE", userId: users[1].id } });
  const message = (over: Record<string, unknown>) =>
    rawPrisma.message.create({
      data: { ...pid, accountId: account.id, groupId: group.id, chatId: group.whatsappGroupId, whatsappMessageId: `wamid-${randomUUID()}`, senderPhone: "8801700000000", direction: "INCOMING", body: "question", normalizedBody: "question", processingStatus: "PROCESSED", timestampWa: new Date(), ...over } as never,
    });
  const question = await message({});
  const reply = await message({ senderPhone: member.phoneNumber, isFromTeamMember: true, quotedMessageId: question.id });
  await rawPrisma.supportActivity.create({ data: { ...pid, accountId: account.id, groupId: group.id, teamMemberId: member.id, messageId: reply.id, occurredAt: new Date() } });
  await rawPrisma.aiFallbackDecision.create({ data: { ...pid, messageId: question.id, accountId: account.id, groupId: group.id, outcome: "HUMAN_FALLBACK", reason: "NO_KNOWLEDGE" } });
  await rawPrisma.outboundMessage.create({
    data: { ...pid, accountId: account.id, chatId: group.whatsappGroupId, toPhone: group.whatsappGroupId, body: "answer", actionType: "MANUAL_REPLY", idempotencyKey: randomUUID(), status: "SENT", relatedMessageId: question.id, createdById: users[0].id },
  });
  const client = await rawPrisma.client.create({ data: { ...pid, code: `C-${label}`, name: `${label} client`, createdById: users[0].id } as never });
  const term = await rawPrisma.clientSubscription.create({ data: { ...pid, clientId: client.id, service: "Internet", startDate: new Date("2026-10-01"), endDate: new Date("2026-11-01") } });
  await rawPrisma.client.update({ where: { id: client.id }, data: { currentSubscriptionId: term.id } });
  await rawPrisma.clientBillingCurrency.create({ data: { ...pid, code: "BDT" } as never });
  const due = await rawPrisma.clientDue.create({ data: { ...pid, clientId: client.id, dueDate: new Date("2026-10-20"), currency: "BDT", amount: "100.00" } as never });
  const payment = await rawPrisma.clientPayment.create({
    data: { ...pid, receiptNumber: `RCPT-${label}`, clientId: client.id, currency: "BDT", amount: "40.00", method: "CASH", receivedDate: new Date("2026-10-21"), idempotencyKey: randomUUID(), recordedById: users[0].id },
  });
  await rawPrisma.clientPaymentAllocation.create({ data: { ...pid, paymentId: payment.id, dueId: due.id, amount: "40.00" } as never });
  await rawPrisma.systemLog.create({ data: { ...pid, level: "INFO", scope: "test", message: `${label} log`, customerId: customer.id } });
  // A workspace's own log entry names only its project, as logSystemEvent writes it from inside one.
  await rawPrisma.systemLog.create({ data: { ...pid, level: "INFO", scope: "test", message: `${label} project log` } });

  return { customerId: customer.id, name, projectId: project.id, userIds: users.map((u) => u.id), domainId: domain.id };
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

async function signInOperator() {
  jar.clear();
  request.host = ADMIN_HOST;
  try {
    expect((await platformLogin({}, form({ username: `op_${tag}`, password: PASSWORD }))).error).toBeUndefined();
  } catch (err) {
    if ((err as { redirectTo?: string }).redirectTo !== "/platform") throw err;
  }
}

let kept: Fixture; // another customer: must never change
let target: Fixture;

beforeAll(async () => {
  mediaRoot = await mkdtemp(path.join(os.tmpdir(), "customer-removal-"));
  setMediaStorageForTests(new LocalMediaStorage(mediaRoot));
  await rawPrisma.platformDomainSettings.deleteMany({});
  await rawPrisma.platformDomainSettings.create({ data: { id: "default", hostRoutingEnabled: true, rootDomain: "remove.test", adminHostnames: [ADMIN_HOST], publicIps: [] } });
  operatorId = (await rawPrisma.platformOperator.create({ data: { username: `op_${tag}`, name: "Operator", passwordHash: auth.hashPassword(PASSWORD) } })).id;
  const founding = await rawPrisma.customer.findFirst({ where: { isFounding: true } });
  if (founding) foundingId = founding.id;
  else {
    foundingId = (await rawPrisma.customer.create({ data: { name: `Founding ${tag}`, isFounding: true } })).id;
    foundingCreatedHere = true;
  }
  kept = await customerWithData("Kept");
  target = await customerWithData("Target");
});

beforeEach(async () => {
  forgetHostScopes();
  forgetFoundingCustomer();
  await signInOperator();
});

afterAll(async () => {
  setMediaStorageForTests(undefined);
  await rm(mediaRoot, { recursive: true, force: true });
  await rawPrisma.platformDomainSettings.deleteMany({});
  await rawPrisma.platformOperatorSession.deleteMany({ where: { operatorId } });
  await rawPrisma.platformOperator.deleteMany({ where: { id: operatorId } });
  // The kept customer is cleaned up through the very feature under test, then every customer row goes
  // (payments are append-only; the trigger is lifted for cleanup only, as saasTwoLayers does).
  const { purgeCustomerData } = await import("@/server/platform/customerRemoval");
  const mine = await rawPrisma.customer.findMany({ where: { name: { contains: tag } }, select: { id: true, isFounding: true, purgedAt: true } });
  for (const c of mine) if (!c.isFounding && !c.purgedAt) await purgeCustomerData(c.id, "cleanup");
  await rawPrisma.$executeRawUnsafe('ALTER TABLE "SubscriptionPayment" DISABLE TRIGGER "SubscriptionPayment_immutable"');
  try {
    await rawPrisma.customer.deleteMany({ where: { name: { contains: tag }, isFounding: false } });
    if (foundingCreatedHere && foundingId) await rawPrisma.customer.delete({ where: { id: foundingId } });
  } finally {
    await rawPrisma.$executeRawUnsafe('ALTER TABLE "SubscriptionPayment" ENABLE TRIGGER "SubscriptionPayment_immutable"');
  }
});

describe("the confirmation", () => {
  it("needs the exact name and the operator's own password, and refuses the original installation", async () => {
    const wrongName = await platform.removeOrDeleteCustomer(target.customerId, {}, form({ mode: "remove", confirmName: "Target", operatorPassword: PASSWORD }));
    expect(wrongName.fieldErrors?.confirmName).toMatch(/exactly/);
    const wrongPassword = await platform.removeOrDeleteCustomer(target.customerId, {}, form({ mode: "delete", confirmName: target.name, operatorPassword: "nope" }));
    expect(wrongPassword.fieldErrors?.operatorPassword).toMatch(/not correct/);
    const noMode = await platform.removeOrDeleteCustomer(target.customerId, {}, form({ confirmName: target.name, operatorPassword: PASSWORD }));
    expect(noMode.fieldErrors?.mode).toBeTruthy();
    const founding = await rawPrisma.customer.findUniqueOrThrow({ where: { id: foundingId! } });
    const refused = await platform.removeOrDeleteCustomer(founding.id, {}, form({ mode: "delete", confirmName: founding.name, operatorPassword: PASSWORD }));
    expect(refused.error).toMatch(/original installation/);
    // Nothing happened to anybody.
    expect((await rawPrisma.customer.findUniqueOrThrow({ where: { id: target.customerId } })).removedAt).toBeNull();
    expect((await rawPrisma.project.findUniqueOrThrow({ where: { id: target.projectId } })).status).toBe("ACTIVE");
  });

  it("refuses without a platform session, and the database refuses removing the founding customer", async () => {
    jar.clear();
    const result = await platform.removeOrDeleteCustomer(target.customerId, {}, form({ mode: "delete", confirmName: target.name, operatorPassword: PASSWORD }));
    expect(result.error).toMatch(/session has ended/);
    await expect(rawPrisma.customer.update({ where: { id: foundingId! }, data: { removedAt: new Date() } })).rejects.toThrow();
  });
});

describe("Remove keeps the data, and Restore puts back exactly what it changed", () => {
  it("archives, disables, signs out and cancels — and deletes nothing", async () => {
    const before = await projectRowCounts(target.projectId);
    const keptBefore = await projectRowCounts(kept.projectId);
    const result = await platform.removeOrDeleteCustomer(target.customerId, {}, form({ mode: "remove", confirmName: `  ${target.name} `, operatorPassword: PASSWORD }));
    expect(result.done).toMatch(/removed/);

    const customer = await rawPrisma.customer.findUniqueOrThrow({ where: { id: target.customerId } });
    expect(customer.removedAt).not.toBeNull();
    expect(customer.purgedAt).toBeNull();
    expect((await rawPrisma.project.findUniqueOrThrow({ where: { id: target.projectId } })).status).toBe("ARCHIVED");
    expect((await rawPrisma.customerDomain.findUniqueOrThrow({ where: { id: target.domainId } })).status).toBe("DISABLED");
    expect(await rawPrisma.user.count({ where: { id: { in: target.userIds }, isActive: true } })).toBe(0);
    expect(await rawPrisma.userSession.count({ where: { userId: { in: target.userIds }, revokedAt: null } })).toBe(0);
    expect(await rawPrisma.userInvitation.count({ where: { customerId: target.customerId, revokedAt: null } })).toBe(0);
    // Projects' status moved; not one row anywhere was deleted.
    const after = await projectRowCounts(target.projectId);
    expect(after).toEqual(before);
    expect(await projectRowCounts(kept.projectId)).toEqual(keptBefore);
    expect((await rawPrisma.project.findUniqueOrThrow({ where: { id: kept.projectId } })).status).toBe("ACTIVE");

    const again = await platform.removeOrDeleteCustomer(target.customerId, {}, form({ mode: "remove", confirmName: target.name, operatorPassword: PASSWORD }));
    expect(again.error).toMatch(/already removed/);
    expect((await rawPrisma.systemLog.findFirst({ where: { customerId: PLATFORM_LOG_CUSTOMER, message: `Customer "${target.name}" removed (data kept)` } }))?.metadata).toMatchObject({ logins: 2 });
  });

  it("Restore needs the password, then brings back the workspace, the address and the logins", async () => {
    expect((await platform.restoreCustomer(target.customerId, {}, form({ operatorPassword: "nope" }))).fieldErrors?.operatorPassword).toBeTruthy();
    const restored = await platform.restoreCustomer(target.customerId, {}, form({ operatorPassword: PASSWORD }));
    expect(restored.done).toMatch(/1 workspace\(s\), 1 address\(es\) and 2 login\(s\)/);
    const customer = await rawPrisma.customer.findUniqueOrThrow({ where: { id: target.customerId } });
    expect(customer.removedAt).toBeNull();
    expect(customer.removalSnapshot).toBeNull();
    expect((await rawPrisma.project.findUniqueOrThrow({ where: { id: target.projectId } })).status).toBe("ACTIVE");
    expect((await rawPrisma.customerDomain.findUniqueOrThrow({ where: { id: target.domainId } })).status).toBe("ACTIVE");
    expect(await rawPrisma.user.count({ where: { id: { in: target.userIds }, isActive: true } })).toBe(2);
    expect((await platform.restoreCustomer(target.customerId, {}, form({ operatorPassword: PASSWORD }))).error).toMatch(/not removed/);
  });

  it("Restore does not wake what was already switched off before the removal", async () => {
    await rawPrisma.user.update({ where: { id: target.userIds[1] }, data: { isActive: false } });
    expect((await platform.removeOrDeleteCustomer(target.customerId, {}, form({ mode: "remove", confirmName: target.name, operatorPassword: PASSWORD }))).done).toBeTruthy();
    expect((await platform.restoreCustomer(target.customerId, {}, form({ operatorPassword: PASSWORD }))).done).toMatch(/1 login\(s\)/);
    expect((await rawPrisma.user.findUniqueOrThrow({ where: { id: target.userIds[1] } })).isActive).toBe(false);
    await rawPrisma.user.update({ where: { id: target.userIds[1] }, data: { isActive: true } });
  });
});

describe("Delete permanently", () => {
  it("erases every row of the workspace, the logins and the address, keeps the billing, and touches no other customer", async () => {
    const mediaDir = path.join(mediaRoot, "whatsapp", target.projectId, "acc", "direct", "2026", "10");
    await mkdir(mediaDir, { recursive: true });
    await writeFile(path.join(mediaDir, "file"), "x");
    const keptMedia = path.join(mediaRoot, "whatsapp", kept.projectId);
    await mkdir(keptMedia, { recursive: true });
    await writeFile(path.join(keptMedia, "file"), "x");
    const keptBefore = await projectRowCounts(kept.projectId);
    expect(Object.keys(await projectRowCounts(target.projectId)).length).toBeGreaterThan(15);

    // Straight from "in use": the action removes first, then deletes.
    const result = await platform.removeOrDeleteCustomer(target.customerId, {}, form({ mode: "delete", confirmName: target.name, operatorPassword: PASSWORD }));
    expect(result.error).toBeUndefined();
    expect(result.done).toMatch(/deleted permanently\.$/);

    expect(await projectRowCounts(target.projectId)).toEqual({});
    expect(await rawPrisma.project.count({ where: { id: target.projectId } })).toBe(0);
    expect(await rawPrisma.user.count({ where: { id: { in: target.userIds } } })).toBe(0);
    for (const table of ["permissionModule", "customerDomain", "userInvitation", "securitySettings"] as const) {
      expect(await (rawPrisma[table] as unknown as { count: (a: unknown) => Promise<number> }).count({ where: { customerId: target.customerId } })).toBe(0);
    }
    const customer = await rawPrisma.customer.findUniqueOrThrow({ where: { id: target.customerId } });
    expect(customer.purgedAt).not.toBeNull();
    expect(customer.removedAt).not.toBeNull();
    expect(await rawPrisma.subscription.count({ where: { customerId: target.customerId } })).toBe(1);
    await expect(stat(path.join(mediaRoot, "whatsapp", target.projectId))).rejects.toThrow();

    // The other customer: every row and file exactly as it was.
    expect(await projectRowCounts(kept.projectId)).toEqual(keptBefore);
    expect(await rawPrisma.user.count({ where: { id: { in: kept.userIds }, isActive: true } })).toBe(2);
    expect((await rawPrisma.customerDomain.findUniqueOrThrow({ where: { id: kept.domainId } })).status).toBe("ACTIVE");
    await expect(stat(path.join(keptMedia, "file"))).resolves.toBeTruthy();

    const log = await rawPrisma.systemLog.findFirst({ where: { customerId: PLATFORM_LOG_CUSTOMER, message: `Customer "${target.name}" deleted permanently` } });
    expect(log?.metadata).toMatchObject({ workspaces: [target.projectId], mediaRemoved: true });
  });

  it("cannot be restored or deleted twice", async () => {
    expect((await platform.restoreCustomer(target.customerId, {}, form({ operatorPassword: PASSWORD }))).error).toMatch(/deleted permanently/);
    expect((await platform.removeOrDeleteCustomer(target.customerId, {}, form({ mode: "delete", confirmName: target.name, operatorPassword: PASSWORD }))).error).toMatch(/already deleted/);
  });

  it("a removed customer can be deleted from the Removed list too", async () => {
    const other = await customerWithData("Second");
    expect((await platform.removeOrDeleteCustomer(other.customerId, {}, form({ mode: "remove", confirmName: other.name, operatorPassword: PASSWORD }))).done).toBeTruthy();
    expect((await platform.removeOrDeleteCustomer(other.customerId, {}, form({ mode: "delete", confirmName: other.name, operatorPassword: PASSWORD }))).done).toMatch(/deleted permanently/);
    expect(await projectRowCounts(other.projectId)).toEqual({});
  });
});
