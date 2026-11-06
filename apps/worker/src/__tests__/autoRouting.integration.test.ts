import "./helpers/requireTestDatabase.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, loadRoutingPool, routeConversation, type RoutingPoolMember } from "@support-automation/db";
import { PERMISSIONS, toDhakaDateOnly, type RoutingMethod } from "@support-automation/shared";
import { inIsp, ISP_DIGITAL, prisma, rawPrisma } from "./helpers/projectFixtures.js";
import { resetProjectFeatureCacheForTests } from "../project/features.js";
import { resetProjectCachesForTests, withProject } from "../project/context.js";
import { routeChannelConversationOnMessage, routeWhatsAppConversationOnMessage, runRoutingSweep } from "../routing/autoRouting.js";

/**
 * Automatic routing (AUTO_ROUTING.md): who gets a new conversation, and that nobody gets it twice. Covers the
 * round-robin order, least-open, capacity, leave / off-duty / no-permission exclusion, the routing lock under
 * concurrent callers, conversations that already have somebody, WhatsApp groups, the feature switches, project
 * isolation and a held project.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const NOW = new Date();
const ids = { users: [] as string[], roles: [] as string[] };
let BIZ = "";
let ispConnection = "";
let bizConnection = "";
let ispAccount = "";
let agents: string[] = []; // ISP agents, sorted by id (the round-robin ring)
let noReply = "";
let bizAgent = "";
let both = ""; // an agent with access to both projects

async function role(name: string, keys: string[]) {
  const permissions = await Promise.all(
    keys.map((key) => {
      const def = PERMISSIONS.find((p) => p.key === key)!;
      return rawPrisma.permission.upsert({ where: { key }, create: { key, label: def.label, category: def.category }, update: {}, select: { id: true } });
    }),
  );
  const r = await rawPrisma.permissionModule.create({ data: { name: `${name} ${tag}`, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } } });
  ids.roles.push(r.id);
  return r.id;
}
async function user(name: string, roleId: string, projects: string[]) {
  const u = await rawPrisma.user.create({ data: { username: `${name}_${tag}`, name, passwordHash: "x", permissionModuleId: roleId } });
  for (const projectId of projects) await rawPrisma.projectAccess.create({ data: { projectId, userId: u.id } });
  ids.users.push(u.id);
  return u.id;
}
async function feature(projectId: string, key: string, enabled: boolean) {
  await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId, key } }, create: { projectId, key, enabled }, update: { enabled } });
  resetProjectFeatureCacheForTests();
}
async function settings(projectId: string, data: Record<string, unknown>) {
  const base = { enabled: true, enabledAt: new Date(NOW.getTime() - 3_600_000), channels: ["TELEGRAM", "WHATSAPP_PERSONAL"], method: "ROUND_ROBIN", maxOpenPerAgent: 15, poolTeamIds: [], poolUserIds: agents, onlyOnDuty: false, requireRecentlySeen: false, lastPickedUserId: null, includeWhatsAppGroups: false };
  await rawPrisma.routingSettings.upsert({ where: { projectId }, create: { projectId, ...base, ...data }, update: { ...base, ...data } });
}
let n = 0;
async function conversation(projectId = ISP_DIGITAL, over: Record<string, unknown> = {}) {
  return (
    await rawPrisma.channelConversation.create({
      data: { projectId, connectionId: projectId === ISP_DIGITAL ? ispConnection : bizConnection, type: "TELEGRAM", externalThreadId: `t-${tag}-${n++}`, status: "OPEN", lastInboundAt: NOW, ...over },
    })
  ).id;
}
const assigneeOf = async (id: string) => (await rawPrisma.channelConversation.findUniqueOrThrow({ where: { id } })).assignedUserId;
const eventsOf = (id: string) => rawPrisma.conversationEvent.findMany({ where: { channelConversationId: id } });
const pool = (projectId = ISP_DIGITAL) => withProject(projectId, async () => loadRoutingPool(prisma, projectId, (await rawPrisma.routingSettings.findUniqueOrThrow({ where: { projectId } })), NOW));
const route = (id: string, poolMembers: RoutingPoolMember[], extra: { method?: RoutingMethod; maxOpenPerAgent?: number; afterReadForTests?: () => Promise<unknown> } = {}) =>
  inIsp(() =>
    routeConversation(prisma, {
      projectId: ISP_DIGITAL,
      target: { kind: "channel", conversationId: id },
      kind: "TELEGRAM",
      settings: { onlyOnDuty: false, requireRecentlySeen: false, recentlySeenMinutes: 15, maxOpenPerAgent: extra.maxOpenPerAgent ?? 15 },
      method: extra.method ?? "ROUND_ROBIN",
      pool: poolMembers,
      via: "AUTOMATIC",
      actorId: null,
      now: NOW,
      afterReadForTests: extra.afterReadForTests,
    }),
  );
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  const creator = await rawPrisma.user.create({ data: { username: `rc_${tag}`, name: "Creator", passwordHash: "x" } });
  ids.users.push(creator.id);
  BIZ = (await createProjectWithDefaults({ name: `Route Biz ${tag}`, slug: `route-biz-${tag}`, status: "ACTIVE", creatorUserId: creator.id }, rawPrisma)).id;
  resetProjectCachesForTests();
  ispConnection = (await rawPrisma.channelConnection.create({ data: { projectId: ISP_DIGITAL, type: "TELEGRAM", name: "@r", status: "CONNECTED", webhookKey: `ri-${tag}` } })).id;
  bizConnection = (await rawPrisma.channelConnection.create({ data: { projectId: BIZ, type: "TELEGRAM", name: "@rb", status: "CONNECTED", webhookKey: `rb-${tag}` } })).id;
  ispAccount = (await rawPrisma.whatsAppAccount.create({ data: { projectId: ISP_DIGITAL, label: `Route ${tag}`, status: "CONNECTED" } })).id;

  const agent = await role("Route agent", ["messages.view", "messages.reply", "conversations.reply"]);
  const viewer = await role("Route viewer", ["messages.view"]);
  agents = [await user("ra1", agent, [ISP_DIGITAL]), await user("ra2", agent, [ISP_DIGITAL]), await user("ra3", agent, [ISP_DIGITAL])].sort();
  noReply = await user("rview", viewer, [ISP_DIGITAL]);
  bizAgent = await user("rbiz", agent, [BIZ]);
  both = await user("rboth", agent, [ISP_DIGITAL, BIZ]);
});

beforeEach(async () => {
  for (const p of [ISP_DIGITAL, BIZ]) {
    await feature(p, "AUTO_ROUTING", true);
    await feature(p, "UNIFIED_INBOX_V3", true);
    await feature(p, "OMNICHANNEL", true);
  }
  await rawPrisma.project.update({ where: { id: BIZ }, data: { status: "ACTIVE", billingHoldAt: null } });
  resetProjectCachesForTests();
  // Each test starts with nobody holding anything, so open counts and the pointer start from zero.
  await rawPrisma.conversationEvent.deleteMany({ where: { OR: [{ channelConversation: { connectionId: { in: [ispConnection, bizConnection] } } }, { accountId: ispAccount }] } });
  await rawPrisma.channelConversation.deleteMany({ where: { connectionId: { in: [ispConnection, bizConnection] } } });
  await rawPrisma.whatsAppConversationState.deleteMany({ where: { accountId: ispAccount } });
  await rawPrisma.message.deleteMany({ where: { accountId: ispAccount } });
  await rawPrisma.whatsAppGroup.deleteMany({ where: { accountId: ispAccount } });
  await settings(ISP_DIGITAL, {});
  await settings(BIZ, { poolUserIds: [bizAgent, both] });
});

afterAll(async () => {
  await rawPrisma.conversationEvent.deleteMany({ where: { OR: [{ channelConversation: { connectionId: { in: [ispConnection, bizConnection] } } }, { accountId: ispAccount }] } });
  await rawPrisma.channelConversation.deleteMany({ where: { connectionId: { in: [ispConnection, bizConnection] } } });
  await rawPrisma.channelConnection.deleteMany({ where: { id: { in: [ispConnection, bizConnection] } } });
  await rawPrisma.whatsAppConversationState.deleteMany({ where: { accountId: ispAccount } });
  await rawPrisma.message.deleteMany({ where: { accountId: ispAccount } });
  await rawPrisma.whatsAppGroup.deleteMany({ where: { accountId: ispAccount } });
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: ispAccount } });
  await rawPrisma.routingSettings.deleteMany({ where: { projectId: { in: [ISP_DIGITAL, BIZ] } } });
  await rawPrisma.leaveRequest.deleteMany({ where: { teamMember: { userId: { in: ids.users } } } });
  await rawPrisma.dutyAssignment.deleteMany({ where: { teamMember: { userId: { in: ids.users } } } });
  await rawPrisma.internalTeamMember.deleteMany({ where: { userId: { in: ids.users } } });
  await rawPrisma.leaveType.deleteMany({ where: { name: `Annual ${tag}` } });
  await rawPrisma.projectFeature.deleteMany({ where: { projectId: ISP_DIGITAL, key: { in: ["AUTO_ROUTING", "UNIFIED_INBOX_V3", "OMNICHANNEL"] } } });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: ids.users } } });
  resetProjectFeatureCacheForTests();
  await rawPrisma.$disconnect();
});

describe("who gets it", () => {
  it("round robin takes turns in a fixed ring and records each assignment as an Auto ASSIGNEE event", async () => {
    const convs = [];
    for (let i = 0; i < 6; i++) convs.push(await conversation());
    for (const c of convs) await inIsp(() => routeChannelConversationOnMessage(c, NOW, NOW));
    const got = await Promise.all(convs.map(assigneeOf));
    expect(got).toEqual([...agents, ...agents]);
    const events = await eventsOf(convs[0]!);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "ASSIGNEE", fromValue: null, toValue: agents[0], actorId: null, context: { reason: "AUTO_ROUTING", method: "ROUND_ROBIN", via: "AUTOMATIC" } });
  });

  it("least open gives it to whoever holds the fewest open or pending conversations", async () => {
    await settings(ISP_DIGITAL, { method: "LEAST_OPEN" });
    await conversation(ISP_DIGITAL, { assignedUserId: agents[0] });
    await conversation(ISP_DIGITAL, { assignedUserId: agents[1], status: "PENDING" });
    await conversation(ISP_DIGITAL, { assignedUserId: agents[1], status: "CLOSED" }); // resolved: not counted
    const c = await conversation();
    await inIsp(() => routeChannelConversationOnMessage(c, NOW, NOW));
    expect(await assigneeOf(c)).toBe(agents[2]);
  });

  it("capacity: nobody past the limit; nobody eligible leaves it unassigned and records why, by counts only", async () => {
    await settings(ISP_DIGITAL, { poolUserIds: agents.slice(0, 2), maxOpenPerAgent: 1 });
    const [a, b, c] = [await conversation(), await conversation(), await conversation()];
    for (const id of [a, b, c]) await inIsp(() => routeChannelConversationOnMessage(id, NOW, NOW));
    expect(new Set([await assigneeOf(a), await assigneeOf(b)])).toEqual(new Set(agents.slice(0, 2)));
    expect(await assigneeOf(c)).toBeNull();
    expect(await eventsOf(c)).toHaveLength(0);
    const s = await rawPrisma.routingSettings.findUniqueOrThrow({ where: { projectId: ISP_DIGITAL } });
    expect(s.lastUnroutedReasons).toEqual({ AT_CAPACITY: 2 });
  });

  it("leave always excludes; off duty and off the roster exclude when 'only on duty' is on", async () => {
    const [onDuty, onLeave, offShift] = agents;
    const member = async (userId: string) =>
      (await rawPrisma.internalTeamMember.create({ data: { projectId: ISP_DIGITAL, name: `m ${userId}`, phoneNumber: `8801${Math.floor(Math.random() * 1e9)}`, role: "Agent", userId } })).id;
    const today = toDhakaDateOnly(NOW);
    const dutyMember = await member(onDuty!);
    const leaveMember = await member(onLeave!);
    const offMember = await member(offShift!);
    await rawPrisma.dutyAssignment.create({ data: { projectId: ISP_DIGITAL, teamMemberId: dutyMember, dutyDate: today, status: "DUTY" } });
    await rawPrisma.dutyAssignment.create({ data: { projectId: ISP_DIGITAL, teamMemberId: leaveMember, dutyDate: today, status: "DUTY" } });
    await rawPrisma.dutyAssignment.create({ data: { projectId: ISP_DIGITAL, teamMemberId: offMember, dutyDate: today, status: "OFF" } });
    const leaveType = await rawPrisma.leaveType.create({ data: { projectId: ISP_DIGITAL, name: `Annual ${tag}` } });
    await rawPrisma.leaveRequest.create({ data: { projectId: ISP_DIGITAL, teamMemberId: leaveMember, leaveTypeId: leaveType.id, startDate: today, endDate: today, dayCount: 1, status: "APPROVED" } });
    try {
      // Leave excludes even without "only on duty".
      const loose = await Promise.all([await conversation(), await conversation(), await conversation()].map(async (id) => (await inIsp(() => routeChannelConversationOnMessage(id, NOW, NOW)), assigneeOf(id))));
      expect(loose).not.toContain(onLeave);

      await settings(ISP_DIGITAL, { onlyOnDuty: true, poolUserIds: [...agents, noReply] });
      const strict = [];
      for (let i = 0; i < 3; i++) {
        const id = await conversation();
        await inIsp(() => routeChannelConversationOnMessage(id, NOW, NOW));
        strict.push(await assigneeOf(id));
      }
      expect(strict).toEqual([onDuty, onDuty, onDuty]);
      const facts = await pool();
      const reasons = Object.fromEntries(facts.map((f) => [f.userId, f.duty]));
      expect(reasons[onLeave!]).toBe("ON_LEAVE");
      expect(reasons[offShift!]).toBe("OFF");
      expect(reasons[noReply]).toBeNull();
    } finally {
      await rawPrisma.leaveRequest.deleteMany({ where: { teamMemberId: leaveMember } });
      await rawPrisma.dutyAssignment.deleteMany({ where: { teamMemberId: { in: [dutyMember, leaveMember, offMember] } } });
      await rawPrisma.internalTeamMember.deleteMany({ where: { id: { in: [dutyMember, leaveMember, offMember] } } });
      await rawPrisma.leaveType.deleteMany({ where: { id: leaveType.id } });
    }
  });

  it("never someone whose role cannot reply, nor someone whose project access level is Read", async () => {
    await settings(ISP_DIGITAL, { poolUserIds: [noReply, agents[0]] });
    await rawPrisma.projectAccess.updateMany({ where: { projectId: ISP_DIGITAL, userId: agents[0] }, data: { level: "READ" } });
    try {
      const c = await conversation();
      await inIsp(() => routeChannelConversationOnMessage(c, NOW, NOW));
      expect(await assigneeOf(c)).toBeNull();
      expect((await rawPrisma.routingSettings.findUniqueOrThrow({ where: { projectId: ISP_DIGITAL } })).lastUnroutedReasons).toEqual({ NO_PERMISSION: 2 });
    } finally {
      await rawPrisma.projectAccess.updateMany({ where: { projectId: ISP_DIGITAL, userId: agents[0] }, data: { level: null } });
    }
  });
});

describe("never twice, never over", () => {
  it("two parallel routings of the same conversation give one assignment and one event", async () => {
    const c = await conversation();
    const members = await pool();
    const results = await Promise.all([route(c, members, { afterReadForTests: () => sleep(150) }), route(c, members, { afterReadForTests: () => sleep(150) })]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["ALREADY_ASSIGNED", "ASSIGNED"]);
    expect(await eventsOf(c)).toHaveLength(1);
  });

  it("two callers routing ten conversations at once split them evenly — the lock keeps both from picking the same next person", async () => {
    await settings(ISP_DIGITAL, { poolUserIds: agents.slice(0, 2) });
    const members = await pool();
    const convs = [];
    for (let i = 0; i < 10; i++) convs.push(await conversation());
    const caller = async (mine: string[]) => {
      for (const id of mine) await route(id, members, { afterReadForTests: () => sleep(40) });
    };
    await Promise.all([caller(convs.slice(0, 5)), caller(convs.slice(5))]);
    const got = await Promise.all(convs.map(assigneeOf));
    expect(got.filter((u) => u === agents[0])).toHaveLength(5);
    expect(got.filter((u) => u === agents[1])).toHaveLength(5);
  });

  it("capacity holds under concurrent callers", async () => {
    await settings(ISP_DIGITAL, { poolUserIds: agents.slice(0, 2) });
    const members = await pool();
    const [a, b] = [await conversation(), await conversation()];
    await Promise.all([a, b].map((id) => route(id, members, { method: "LEAST_OPEN", maxOpenPerAgent: 1, afterReadForTests: () => sleep(100) })));
    expect(new Set([await assigneeOf(a), await assigneeOf(b)])).toEqual(new Set(agents.slice(0, 2)));
  });

  it("a conversation somebody already has is never touched, nor a resolved one", async () => {
    const mine = await conversation(ISP_DIGITAL, { assignedUserId: noReply });
    const closed = await conversation(ISP_DIGITAL, { status: "CLOSED" });
    await inIsp(() => routeChannelConversationOnMessage(mine, NOW, NOW));
    expect(await route(mine, await pool())).toEqual({ outcome: "ALREADY_ASSIGNED" });
    expect(await route(closed, await pool())).toEqual({ outcome: "NOT_OPEN" });
    expect(await assigneeOf(mine)).toBe(noReply);
    expect(await eventsOf(mine)).toHaveLength(0);
  });
});

describe("WhatsApp", () => {
  const customerMessage = (chatId: string, groupId: string | null = null) =>
    rawPrisma.message.create({
      data: { projectId: ISP_DIGITAL, accountId: ispAccount, groupId, whatsappMessageId: randomUUID(), chatId, senderPhone: "8801700000000", direction: "INCOMING", body: "hello", normalizedBody: "hello", timestampWa: NOW },
    });
  const stateOf = (chatId: string) => rawPrisma.whatsAppConversationState.findFirst({ where: { accountId: ispAccount, chatId } });

  it("a personal chat is routed by its hook and by the sweep, creating its state row", async () => {
    const hooked = `8801${tag.replace(/\D/g, "1").slice(0, 8)}1@c.us`;
    await inIsp(() => routeWhatsAppConversationOnMessage({ accountId: ispAccount, chatId: hooked, at: NOW, fromCustomer: true }, NOW));
    expect((await stateOf(hooked))?.assignedUserId).toBe(agents[0]);
    // A team member's message never routes.
    const quiet = `8801${tag.replace(/\D/g, "2").slice(0, 8)}2@c.us`;
    await inIsp(() => routeWhatsAppConversationOnMessage({ accountId: ispAccount, chatId: quiet, at: NOW, fromCustomer: false }, NOW));
    expect(await stateOf(quiet)).toBeNull();

    const swept = `8801${tag.replace(/\D/g, "3").slice(0, 8)}3@c.us`;
    await customerMessage(swept);
    expect(await inIsp(() => runRoutingSweep(NOW))).toBe(1);
    expect((await stateOf(swept))?.assignedUserId).toBe(agents[1]);
    const events = await rawPrisma.conversationEvent.findMany({ where: { accountId: ispAccount, chatId: swept } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "ASSIGNEE", toValue: agents[1], context: { reason: "AUTO_ROUTING" } });
  });

  it("groups are untouched unless switched on separately, and a group with an owner is never routed", async () => {
    const chat = `120363${tag}@g.us`;
    const owned = `120364${tag}@g.us`;
    const group = await rawPrisma.whatsAppGroup.create({ data: { projectId: ISP_DIGITAL, accountId: ispAccount, whatsappGroupId: chat, name: "g", isActive: true } });
    const ownerMember = await rawPrisma.internalTeamMember.create({ data: { projectId: ISP_DIGITAL, name: `owner ${tag}`, phoneNumber: `8801${tag.replace(/\D/g, "4").slice(0, 8)}9`, role: "Agent" } });
    const ownedGroup = await rawPrisma.whatsAppGroup.create({ data: { projectId: ISP_DIGITAL, accountId: ispAccount, whatsappGroupId: owned, name: "o", isActive: true, assignedTeamMemberId: ownerMember.id } });
    try {
      await customerMessage(chat, group.id);
      await customerMessage(owned, ownedGroup.id);
      await inIsp(() => routeWhatsAppConversationOnMessage({ accountId: ispAccount, chatId: chat, at: NOW, fromCustomer: true }, NOW));
      expect(await inIsp(() => runRoutingSweep(NOW))).toBe(0);
      expect(await stateOf(chat)).toBeNull();

      await settings(ISP_DIGITAL, { includeWhatsAppGroups: true });
      await inIsp(() => routeWhatsAppConversationOnMessage({ accountId: ispAccount, chatId: owned, at: NOW, fromCustomer: true }, NOW));
      expect(await inIsp(() => runRoutingSweep(NOW))).toBe(1);
      expect((await stateOf(chat))?.assignedUserId).toBe(agents[0]);
      expect(await stateOf(owned)).toBeNull();
    } finally {
      await rawPrisma.whatsAppGroup.deleteMany({ where: { id: ownedGroup.id } });
      await rawPrisma.internalTeamMember.deleteMany({ where: { id: ownerMember.id } });
    }
  });

  it("a group two of our numbers are in is one conversation: once one copy has a person, the other is not routed", async () => {
    const chat = `120365${tag}@g.us`;
    const second = (await rawPrisma.whatsAppAccount.create({ data: { projectId: ISP_DIGITAL, label: `Route 2 ${tag}`, status: "CONNECTED" } })).id;
    try {
      await settings(ISP_DIGITAL, { includeWhatsAppGroups: true });
      await inIsp(() => routeWhatsAppConversationOnMessage({ accountId: ispAccount, chatId: chat, at: NOW, fromCustomer: true }, NOW));
      await inIsp(() => routeWhatsAppConversationOnMessage({ accountId: second, chatId: chat, at: NOW, fromCustomer: true }, NOW));
      expect((await stateOf(chat))?.assignedUserId).toBeTruthy();
      expect(await rawPrisma.whatsAppConversationState.count({ where: { accountId: second, chatId: chat } })).toBe(0);
    } finally {
      await rawPrisma.conversationEvent.deleteMany({ where: { accountId: second } });
      await rawPrisma.whatsAppConversationState.deleteMany({ where: { accountId: second } });
      await rawPrisma.whatsAppAccount.delete({ where: { id: second } });
    }
  });
});

describe("switches and boundaries", () => {
  it("does nothing with AUTO_ROUTING off, with Inbox V3 off, or with routing switched off", async () => {
    const c = await conversation();
    await feature(ISP_DIGITAL, "AUTO_ROUTING", false);
    await inIsp(() => routeChannelConversationOnMessage(c, NOW, NOW));
    expect(await inIsp(() => runRoutingSweep(NOW))).toBe(0);
    await feature(ISP_DIGITAL, "AUTO_ROUTING", true);
    await feature(ISP_DIGITAL, "UNIFIED_INBOX_V3", false);
    await inIsp(() => routeChannelConversationOnMessage(c, NOW, NOW));
    expect(await inIsp(() => runRoutingSweep(NOW))).toBe(0);
    await feature(ISP_DIGITAL, "UNIFIED_INBOX_V3", true);
    await settings(ISP_DIGITAL, { enabled: false });
    expect(await inIsp(() => runRoutingSweep(NOW))).toBe(0);
    expect(await assigneeOf(c)).toBeNull();
    await settings(ISP_DIGITAL, {});
    expect(await inIsp(() => runRoutingSweep(NOW))).toBe(1);
  });

  it("the sweep never routes a conversation the customer last wrote in before routing was switched on", async () => {
    const old = await conversation(ISP_DIGITAL, { lastInboundAt: new Date(NOW.getTime() - 2 * 3_600_000) });
    expect(await inIsp(() => runRoutingSweep(NOW))).toBe(0);
    expect(await assigneeOf(old)).toBeNull();
  });

  it("each project routes to its own people and counts its own conversations", async () => {
    // A pool naming another project's person: they have no access here, so nobody is given it.
    await settings(BIZ, { poolUserIds: [agents[0]!] });
    const biz = await conversation(BIZ);
    await withProject(BIZ, () => routeChannelConversationOnMessage(biz, NOW, NOW));
    expect(await assigneeOf(biz)).toBeNull();
    expect((await rawPrisma.routingSettings.findUniqueOrThrow({ where: { projectId: BIZ } })).lastUnroutedReasons).toEqual({ NO_PROJECT_ACCESS: 1 });

    // `both` is full in Biz (capacity 1) and still free in ISP Digital: counts never cross projects, for a
    // channel conversation or a WhatsApp chat.
    await settings(BIZ, { poolUserIds: [both], maxOpenPerAgent: 1 });
    await conversation(BIZ, { assignedUserId: both });
    const bizAccount = (await rawPrisma.whatsAppAccount.create({ data: { projectId: BIZ, label: `Route Biz ${tag}`, status: "CONNECTED" } })).id;
    await rawPrisma.whatsAppConversationState.create({ data: { projectId: BIZ, accountId: bizAccount, chatId: `88017${tag.replace(/\D/g, "4").slice(0, 8)}@c.us`, conversationType: "PERSONAL", assignedUserId: both } });
    await settings(ISP_DIGITAL, { poolUserIds: [both], maxOpenPerAgent: 1 });
    const isp = await conversation();
    await inIsp(() => routeChannelConversationOnMessage(isp, NOW, NOW));
    expect(await assigneeOf(isp)).toBe(both);
    const biz2 = await conversation(BIZ);
    await withProject(BIZ, () => routeChannelConversationOnMessage(biz2, NOW, NOW));
    expect(await assigneeOf(biz2)).toBeNull();
  });

  it("a held project is skipped: no hook, no sweep", async () => {
    const c = await conversation(BIZ);
    await rawPrisma.project.update({ where: { id: BIZ }, data: { status: "SUSPENDED" } });
    resetProjectCachesForTests();
    await withProject(BIZ, () => routeChannelConversationOnMessage(c, NOW, NOW));
    expect(await withProject(BIZ, () => runRoutingSweep(NOW))).toBe(0);
    await rawPrisma.project.update({ where: { id: BIZ }, data: { status: "ACTIVE", billingHoldAt: NOW } });
    resetProjectCachesForTests();
    expect(await withProject(BIZ, () => runRoutingSweep(NOW))).toBe(0);
    expect(await assigneeOf(c)).toBeNull();
    await rawPrisma.project.update({ where: { id: BIZ }, data: { billingHoldAt: null } });
    resetProjectCachesForTests();
    expect(await withProject(BIZ, () => runRoutingSweep(NOW))).toBe(1);
  });
});
