import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";

/**
 * Who a notification reaches (AGENT_APP.md): only somebody the inbox itself would show the conversation to,
 * on a sign-in that is still alive, and never with a customer's words unless that device asked for them.
 */
process.env.VAPID_PUBLIC_KEY = "test-public";
process.env.VAPID_PRIVATE_KEY = "test-private";

const { newPushRun, pushTick } = await import("@/server/pushProcessor");
const { setPushSenderForTests } = await import("@/server/push/send");

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const sent: Array<{ endpoint: string; title: string; body: string; url: string }> = [];
const fx = {} as { viewerRole: string; noRole: string; account: string; group: string; quiet: string; bizAccount: string; bizGroup: string; biz: string };
const people: string[] = [];

async function role(name: string, keys: string[]) {
  const permissions = await Promise.all(
    keys.map((key) => {
      const def = PERMISSIONS.find((p) => p.key === key)!;
      return rawPrisma.permission.upsert({ where: { key }, create: { key, label: def.label, category: def.category }, update: {}, select: { id: true } });
    }),
  );
  return (await rawPrisma.permissionModule.create({ data: { name: `${name} ${tag}`, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } } })).id;
}

/** A person with one browser that said yes to notifications. */
async function person(name: string, roleId: string, projectId: string | null, session: { revokedAt?: Date; expiresAt?: Date } = {}, prefs: Record<string, boolean> = {}) {
  const user = await rawPrisma.user.create({ data: { username: `${name}_${tag}`, email: `${name}_${tag}@example.test`, name, passwordHash: "x", permissionModuleId: roleId } });
  people.push(user.id);
  if (projectId) await rawPrisma.projectAccess.create({ data: { projectId, userId: user.id } });
  const s = await rawPrisma.userSession.create({ data: { userId: user.id, secretHash: randomUUID(), expiresAt: session.expiresAt ?? new Date(Date.now() + 3600_000), revokedAt: session.revokedAt ?? null } });
  await rawPrisma.pushDevice.create({ data: { userId: user.id, sessionId: s.id, endpoint: `https://fcm.googleapis.com/${name}-${tag}`, p256dh: "k", auth: "a", ...prefs } });
  return user.id;
}

async function customerMessage(over: { projectId?: string; accountId?: string; groupId?: string; chatId?: string; isFromTeamMember?: boolean; timestampWa?: Date; body?: string } = {}) {
  const projectId = over.projectId ?? ORIGINAL_PROJECT_ID;
  const accountId = over.accountId ?? fx.account;
  const groupId = over.groupId === undefined ? fx.group : over.groupId;
  const group = groupId ? await rawPrisma.whatsAppGroup.findUniqueOrThrow({ where: { id: groupId } }) : null;
  return rawPrisma.message.create({
    data: {
      projectId,
      accountId,
      groupId: groupId || null,
      whatsappMessageId: randomUUID(),
      chatId: over.chatId ?? group!.whatsappGroupId,
      senderPhone: "8801912340000",
      senderName: "Rahim",
      direction: "INCOMING",
      body: over.body ?? "Internet line down",
      normalizedBody: (over.body ?? "Internet line down").toLowerCase(),
      isFromTeamMember: over.isFromTeamMember ?? false,
      timestampWa: over.timestampWa ?? new Date(),
    },
  });
}

/** One pass over what was stored since the last one. */
const pass = async (run: ReturnType<typeof newPushRun>) => {
  // A pass reads up to a second ago, so what was just stored needs that long to come into view.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await pushTick(run);
};
const reached = () => sent.map((s) => s.endpoint.replace("https://fcm.googleapis.com/", "").replace(`-${tag}`, "")).sort();

beforeAll(async () => {
  setPushSenderForTests(async (target, message) => {
    sent.push({ endpoint: target.endpoint, ...message });
  });
  fx.viewerRole = await role("Inbox viewer", ["messages.view"]);
  fx.noRole = await role("No inbox", ["clients.view"]);
  const pid = { projectId: ORIGINAL_PROJECT_ID };
  fx.account = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `Primary ${tag}`, status: "CONNECTED" } })).id;
  fx.group = (await rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId: fx.account, whatsappGroupId: `g-${tag}@g.us`, name: `Dhaka ${tag}`, isActive: true, isMonitored: true } })).id;
  fx.quiet = (await rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId: fx.account, whatsappGroupId: `q-${tag}@g.us`, name: `Unmonitored ${tag}`, isActive: true, isMonitored: false } })).id;
  const creator = await rawPrisma.user.create({ data: { username: `creator_${tag}`, email: `creator_${tag}@example.test`, name: "Creator", passwordHash: "x" } });
  people.push(creator.id);
  fx.biz = (await createProjectWithDefaults({ name: `Bizify ${tag}`, slug: `bizify-${tag}`, status: "ACTIVE", creatorUserId: creator.id }, rawPrisma)).id;
  fx.bizAccount = (await rawPrisma.whatsAppAccount.create({ data: { projectId: fx.biz, label: `Biz ${tag}`, status: "CONNECTED" } })).id;
  fx.bizGroup = (await rawPrisma.whatsAppGroup.create({ data: { projectId: fx.biz, accountId: fx.bizAccount, whatsappGroupId: `b-${tag}@g.us`, name: `Biz ${tag}`, isActive: true, isMonitored: true } })).id;

  await person("viewer", fx.viewerRole, ORIGINAL_PROJECT_ID);
  await person("otherproject", fx.viewerRole, fx.biz);
  await person("noaccess", fx.viewerRole, null);
  await person("nopermission", fx.noRole, ORIGINAL_PROJECT_ID);
  await person("signedout", fx.viewerRole, ORIGINAL_PROJECT_ID, { revokedAt: new Date() });
  await person("expired", fx.viewerRole, ORIGINAL_PROJECT_ID, { expiresAt: new Date(Date.now() - 60_000) });
  await person("optedout", fx.viewerRole, ORIGINAL_PROJECT_ID, {}, { notifyWaiting: false });
  await person("preview", fx.viewerRole, ORIGINAL_PROJECT_ID, {}, { showPreview: true });
});

beforeEach(() => {
  sent.length = 0;
});

afterAll(async () => {
  setPushSenderForTests(null);
  await rawPrisma.pushDevice.deleteMany({ where: { userId: { in: people } } });
  // Everything this file put in the original project: the next suite on this database scans it project-wide.
  await rawPrisma.conversationEvent.deleteMany({ where: { accountId: fx.account } });
  await rawPrisma.whatsAppConversationState.deleteMany({ where: { accountId: fx.account } });
  await rawPrisma.message.deleteMany({ where: { accountId: fx.account } });
  await rawPrisma.whatsAppGroup.deleteMany({ where: { accountId: fx.account } });
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: fx.account } });
});

describe("a customer writes in a conversation nobody holds", () => {
  it("reaches only people the inbox would show it to, on a live sign-in, who want it", async () => {
    const run = newPushRun(new Date(Date.now() - 1000));
    await customerMessage();
    await pass(run);
    expect(reached()).toEqual(["preview", "viewer"]);
  });

  it("never carries the customer's words unless that device asked", async () => {
    const run = newPushRun(new Date(Date.now() - 1000));
    await customerMessage({ body: "my secret account problem" });
    await pass(run);
    const plain = sent.find((s) => s.endpoint.includes("viewer"))!;
    const shown = sent.find((s) => s.endpoint.includes("preview"))!;
    expect(plain.title).toBe(`Dhaka ${tag}`);
    expect(plain.body).toBe("A customer is waiting");
    expect(JSON.stringify(plain)).not.toContain("secret");
    expect(shown.body).toBe("my secret account problem");
    expect(plain.url).toContain(`/${fx.group}`);
  });

  it("stays inside its project: the other project's message reaches only its own people", async () => {
    const run = newPushRun(new Date(Date.now() - 1000));
    await customerMessage({ projectId: fx.biz, accountId: fx.bizAccount, groupId: fx.bizGroup });
    await pass(run);
    expect(reached()).toEqual(["otherproject"]);
    expect(sent[0]!.url).toContain(`/p/bizify-${tag}/`);
  });

  it("says nothing for a team member, an unmonitored group, or recovered history", async () => {
    const run = newPushRun(new Date(Date.now() - 1000));
    await customerMessage({ isFromTeamMember: true });
    await customerMessage({ groupId: fx.quiet });
    await customerMessage({ timestampWa: new Date(Date.now() - 3600_000) });
    await pass(run);
    expect(sent).toEqual([]);
  });

  it("waits a minute before the next waiting alert", async () => {
    const run = newPushRun(new Date(Date.now() - 1000));
    await customerMessage();
    await pass(run);
    expect(sent.length).toBe(2);
    sent.length = 0;
    await customerMessage();
    await pass(run);
    expect(sent).toEqual([]);
  });
});

describe("a conversation somebody holds", () => {
  it("alerts the holder, not the whole team, and only once in five minutes", async () => {
    const holder = await person("holder", fx.viewerRole, ORIGINAL_PROJECT_ID);
    const chatId = (await rawPrisma.whatsAppGroup.findUniqueOrThrow({ where: { id: fx.group } })).whatsappGroupId;
    await rawPrisma.whatsAppConversationState.create({ data: { projectId: ORIGINAL_PROJECT_ID, accountId: fx.account, chatId, conversationType: "GROUP", assignedUserId: holder } });
    const run = newPushRun(new Date(Date.now() - 1000));
    await customerMessage();
    await pass(run);
    expect(reached()).toEqual(["holder"]);
    expect(sent[0]!.body).toBe("New message in your conversation");
    sent.length = 0;
    await customerMessage();
    await pass(run);
    expect(sent).toEqual([]);
    await rawPrisma.whatsAppConversationState.deleteMany({ where: { accountId: fx.account, chatId } });
  });

  it("tells somebody they were assigned, unless they did it themselves", async () => {
    const holder = await rawPrisma.user.findFirstOrThrow({ where: { username: `viewer_${tag}` }, select: { id: true } });
    const chatId = (await rawPrisma.whatsAppGroup.findUniqueOrThrow({ where: { id: fx.group } })).whatsappGroupId;
    const run = newPushRun(new Date(Date.now() - 1000));
    await rawPrisma.conversationEvent.create({ data: { projectId: ORIGINAL_PROJECT_ID, accountId: fx.account, chatId, kind: "ASSIGNEE", toValue: holder.id, actorId: holder.id } });
    await pass(run);
    expect(sent).toEqual([]);
    await rawPrisma.conversationEvent.create({ data: { projectId: ORIGINAL_PROJECT_ID, accountId: fx.account, chatId, kind: "ASSIGNEE", toValue: holder.id, actorId: null } });
    await pass(run);
    expect(reached()).toEqual(["viewer"]);
    expect(sent[0]!.body).toBe("Assigned to you");
    expect(sent[0]!.title).toBe(`Dhaka ${tag}`);
  });
});
