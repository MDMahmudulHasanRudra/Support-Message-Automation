import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { failedReplyState, PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Messages → Failed Replies (FAILED_REPLIES.md), the dashboard side: what is listed (customer replies only,
 * this project only), the derived state in SQL agrees with the pure rule, and every action — retry, resolve,
 * close, reopen — refuses what it must and writes its history row. The worker's half (uncertain sends never
 * retried by themselves, crash recovery) is in apps/worker failedReplySends.integration.test.ts.
 */

let current: Session | null;
vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => {
    if (!current) throw new Error("NEXT_REDIRECT /login");
    return current;
  },
  getSession: async () => current,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => `/p/isp-digital${p}`, inWorkspace: async () => false }));

const { runWithProject } = await import("@/server/projectContext");
const reads = await import("@/server/failedReplies");
const actions = await import("@/server/actions/failedReplies");

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const ISP = { id: ORIGINAL_PROJECT_ID, slug: "isp-digital", name: "ISP Digital", status: "ACTIVE" as const };
let BIZ = { id: "", slug: `fr-biz-${tag}`, name: `FR Biz ${tag}`, status: "ACTIVE" as const };
const inIsp = <T,>(fn: () => Promise<T>) => runWithProject(ISP, fn);
const inBiz = <T,>(fn: () => Promise<T>) => runWithProject(BIZ, fn);
const ids = { users: [] as string[], roles: [] as string[], accounts: [] as string[] };
const sessions = {} as Record<"replier" | "viewer" | "bizReplier", Session>;
const fx = {} as { account: string; downAccount: string; group: string; chatId: string; bizAccount: string; connection: string; conversation: string };

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
  const u = await rawPrisma.user.create({ data: { username: `${name}_${tag}`, email: `${name}_${tag}@example.test`, name, passwordHash: "x", permissionModuleId: roleId } });
  for (const projectId of projects) await rawPrisma.projectAccess.create({ data: { projectId, userId: u.id } });
  ids.users.push(u.id);
  return { userId: u.id, username: u.username, email: u.email!, name } as Session;
}

type Status = "PENDING" | "PROCESSING" | "SENT" | "FAILED" | "CANCELLED" | "RATE_LIMITED" | "SKIPPED";
async function outbound(extra: Partial<{ projectId: string; accountId: string; status: Status; actionType: "AUTO_REPLY" | "MANUAL_REPLY" | "GROUP_BROADCAST"; deliveryUncertain: boolean; manualRetryCount: number; replyResolution: "RESOLVED" | "CLOSED" | null; idempotencyKey: string; body: string; sendStartedAt: Date; failureReason: string }> = {}) {
  const { projectId = ORIGINAL_PROJECT_ID, accountId = fx.account, ...rest } = extra;
  return rawPrisma.outboundMessage.create({
    data: {
      projectId,
      accountId,
      chatId: fx.chatId,
      groupId: projectId === ORIGINAL_PROJECT_ID && accountId === fx.account ? fx.group : null,
      toPhone: "8801711000999",
      body: `Reply ${randomUUID().slice(0, 6)}`,
      actionType: "AUTO_REPLY",
      idempotencyKey: `fr-${randomUUID()}`,
      status: "FAILED",
      attemptCount: 3,
      failureReason: "Unknown provider error",
      ...rest,
    },
  });
}
const row = (id: string) => rawPrisma.outboundMessage.findUniqueOrThrow({ where: { id } });
const history = (id: string) => rawPrisma.failedReplyAction.findMany({ where: { outboundMessageId: id }, orderBy: { createdAt: "asc" } });
const W = (id: string) => ({ source: "WHATSAPP" as const, id });

beforeAll(async () => {
  const pid = { projectId: ORIGINAL_PROJECT_ID };
  fx.account = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `FR Primary ${tag}`, status: "CONNECTED" } })).id;
  fx.downAccount = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `FR Down ${tag}`, status: "DISCONNECTED" } })).id;
  ids.accounts.push(fx.account, fx.downAccount);
  fx.chatId = `fr-${tag}@g.us`;
  fx.group = (await rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId: fx.account, whatsappGroupId: fx.chatId, name: `FR Customer ${tag}`, isActive: true } })).id;

  const creator = await rawPrisma.user.create({ data: { username: `frc_${tag}`, email: `frc_${tag}@example.test`, name: "Creator", passwordHash: "x" } });
  ids.users.push(creator.id);
  const biz = await createProjectWithDefaults({ name: BIZ.name, slug: BIZ.slug, status: "ACTIVE", creatorUserId: creator.id }, rawPrisma);
  BIZ = { ...BIZ, id: biz.id };
  await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId: biz.id, key: "OMNICHANNEL" } }, create: { projectId: biz.id, key: "OMNICHANNEL", enabled: true }, update: { enabled: true } });
  fx.bizAccount = (await rawPrisma.whatsAppAccount.create({ data: { projectId: biz.id, label: `FR Biz ${tag}`, status: "CONNECTED" } })).id;
  ids.accounts.push(fx.bizAccount);
  fx.connection = (await rawPrisma.channelConnection.create({ data: { projectId: biz.id, type: "TELEGRAM", name: "@frbot", status: "CONNECTED", webhookKey: `fr-${tag}` } })).id;
  fx.conversation = (await rawPrisma.channelConversation.create({ data: { projectId: biz.id, connectionId: fx.connection, type: "TELEGRAM", externalThreadId: `t-${tag}`, customerName: "Nusrat" } })).id;

  const replier = await role("FR replier", ["messages.view", "messages.reply", "conversations.reply"]);
  const viewer = await role("FR viewer", ["messages.view"]);
  sessions.replier = await user("fr_replier", replier, [ORIGINAL_PROJECT_ID]);
  sessions.viewer = await user("fr_viewer", viewer, [ORIGINAL_PROJECT_ID]);
  sessions.bizReplier = await user("fr_biz", replier, [biz.id]);
});

afterAll(async () => {
  await rawPrisma.outboundMessage.deleteMany({ where: { accountId: { in: ids.accounts } } });
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: { in: ids.accounts } } });
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((r) => r.table_name);
  for (let pass = 0; pass < 4; pass++) {
    for (const t of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "projectId" = $1`, BIZ.id).catch(() => undefined);
  }
  await rawPrisma.project.deleteMany({ where: { id: BIZ.id } });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: ids.users } } });
  await rawPrisma.systemLog.deleteMany({ where: { actorUserId: { in: ids.users } } });
  await rawPrisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: { in: ids.roles } } });
  await rawPrisma.$disconnect();
});

const all = (extra: Record<string, string> = {}) => reads.parseFailedReplyFilters({ state: "all", accountId: fx.account, ...extra });

describe("what is listed", () => {
  it("lists failed customer replies of this project only — never a broadcast, a template test, or a reply that simply went out", async () => {
    const auto = await outbound();
    const manual = await outbound({ actionType: "MANUAL_REPLY", status: "SKIPPED", failureReason: "This account is no longer a member of the group, so the message was not sent." });
    const broadcast = await outbound({ actionType: "GROUP_BROADCAST" });
    const templateTest = await outbound({ actionType: "MANUAL_REPLY", idempotencyKey: `template-test:x:${randomUUID()}` });
    const sent = await outbound({ status: "SENT" });
    const otherProject = await outbound({ projectId: BIZ.id, accountId: fx.bizAccount });
    const { rows } = await inIsp(() => reads.listFailedReplies(reads.parseFailedReplyFilters({ state: "all" }), 1, 100, false));
    const listed = new Set(rows.map((r) => r.id));
    expect(listed.has(auto.id)).toBe(true);
    expect(listed.has(manual.id)).toBe(true);
    for (const id of [broadcast.id, templateTest.id, sent.id, otherProject.id]) expect(listed.has(id)).toBe(false);
    expect(rows.find((r) => r.id === manual.id)?.category).toBe("NOT_IN_CHAT");
  });

  it("the state computed in SQL is the pure rule's, for every status, retry and resolution combination", async () => {
    const statuses: Status[] = ["PENDING", "PROCESSING", "SENT", "FAILED", "CANCELLED", "RATE_LIMITED", "SKIPPED"];
    const made: Array<{ id: string; status: Status; manualRetryCount: number; replyResolution: "RESOLVED" | "CLOSED" | null }> = [];
    for (const status of statuses)
      for (const manualRetryCount of [0, 1])
        for (const replyResolution of [null, "RESOLVED", "CLOSED"] as const) {
          const r = await outbound({ status, manualRetryCount, replyResolution });
          made.push({ id: r.id, status, manualRetryCount, replyResolution });
        }
    const { rows } = await inIsp(() => reads.listFailedReplies(all(), 1, 100, false));
    const byId = new Map(rows.map((r) => [r.id, r.state]));
    for (const m of made) {
      const expected = failedReplyState({ source: "WHATSAPP", status: m.status, resolution: m.replyResolution, manualRetryCount: m.manualRetryCount });
      // A row the rule leaves off the list must not be listed, and a listed row must carry the rule's state.
      expect(byId.get(m.id) ?? null).toBe(expected);
    }
  });

  it("filters by uncertainty and customer, and counts each state", async () => {
    const uncertain = await outbound({ deliveryUncertain: true });
    const { rows, counts } = await inIsp(() => reads.listFailedReplies(all({ uncertain: "1" }), 1, 100, false));
    expect(rows.map((r) => r.id)).toContain(uncertain.id);
    expect(rows.every((r) => r.deliveryUncertain)).toBe(true);
    expect(counts.FAILED).toBeGreaterThan(0);
    const none = await inIsp(() => reads.listFailedReplies(all({ q: "no-such-customer-anywhere" }), 1, 100, false));
    expect(none.total).toBe(0);
  });
});

describe("retry", () => {
  it("re-queues the SAME row with the SAME key, resets its budget, and records who did it", async () => {
    current = sessions.replier;
    const r = await outbound({ failureReason: "Unknown provider error" });
    const before = await row(r.id);
    expect(await inIsp(() => actions.retryFailedReply({ ...W(r.id), note: "Customer asked again" }))).toEqual({ done: 1, skipped: 0 });
    const after = await row(r.id);
    expect(after).toMatchObject({ status: "PENDING", attemptCount: 0, manualRetryCount: 1, idempotencyKey: before.idempotencyKey, sendStartedAt: null, body: before.body });
    expect(await rawPrisma.outboundMessage.count({ where: { idempotencyKey: before.idempotencyKey } })).toBe(1);
    const [h] = await history(r.id);
    expect(h).toMatchObject({ action: "RETRY", fromStatus: "FAILED", failureReason: "Unknown provider error", actorUserId: sessions.replier.userId, actorUsername: sessions.replier.username, note: "Customer asked again" });
    // Now RETRYING: a second press does nothing.
    expect((await inIsp(() => actions.retryFailedReply(W(r.id)))).error).toMatch(/already queued/);
  });

  it("an uncertain reply needs the person's confirmation, and is refused outright when the chat shows it arrived", async () => {
    current = sessions.replier;
    const r = await outbound({ deliveryUncertain: true, sendStartedAt: new Date(Date.now() - 5 * 60_000) });
    const first = await inIsp(() => actions.retryFailedReply(W(r.id)));
    expect(first.needsConfirmation).toBe(true);
    expect((await row(r.id)).status).toBe("FAILED");
    expect(await inIsp(() => actions.retryFailedReply({ ...W(r.id), confirmedUncertain: true }))).toEqual({ done: 1, skipped: 0 });
    expect((await history(r.id))[0]?.confirmedUncertain).toBe(true);

    const echoed = await outbound({ deliveryUncertain: true, sendStartedAt: new Date(Date.now() - 5 * 60_000), body: `Echoed ${tag}` });
    await rawPrisma.message.create({
      data: { projectId: ORIGINAL_PROJECT_ID, accountId: fx.account, groupId: fx.group, whatsappMessageId: `true_${randomUUID()}`, chatId: fx.chatId, senderPhone: "8801700000001", direction: "OUTGOING", body: `Echoed ${tag}`, normalizedBody: `echoed ${tag}`, timestampWa: new Date(Date.now() - 4 * 60_000), processingStatus: "PROCESSED" },
    });
    const refused = await inIsp(() => actions.retryFailedReply({ ...W(echoed.id), confirmedUncertain: true }));
    expect(refused.error).toMatch(/most likely received it/);
    expect((await row(echoed.id)).status).toBe("FAILED");
  });

  it("refuses when the account is not connected, and an automatic reply while automation is paused (a typed one still goes)", async () => {
    current = sessions.replier;
    const down = await outbound({ accountId: fx.downAccount });
    expect((await inIsp(() => actions.retryFailedReply(W(down.id)))).error).toMatch(/not connected/);

    // A freshly migrated database has no settings row (CI runs the web suite first), so create it if needed
    // and put things back exactly as they were.
    const existing = await rawPrisma.automationSettings.findUnique({ where: { projectId: ORIGINAL_PROJECT_ID }, select: { automationEnabled: true } });
    await rawPrisma.automationSettings.upsert({ where: { projectId: ORIGINAL_PROJECT_ID }, create: { projectId: ORIGINAL_PROJECT_ID, automationEnabled: false }, update: { automationEnabled: false } });
    try {
      const auto = await outbound();
      const manual = await outbound({ actionType: "MANUAL_REPLY" });
      expect((await inIsp(() => actions.retryFailedReply(W(auto.id)))).error).toMatch(/Automation is paused/);
      expect((await inIsp(() => actions.retryFailedReply(W(manual.id)))).done).toBe(1);
    } finally {
      if (existing) await rawPrisma.automationSettings.update({ where: { projectId: ORIGINAL_PROJECT_ID }, data: { automationEnabled: existing.automationEnabled } });
      else await rawPrisma.automationSettings.delete({ where: { projectId: ORIGINAL_PROJECT_ID } });
    }
  });

  it("bulk retry sends the certain failures and skips every uncertain one", async () => {
    current = sessions.replier;
    const a = await outbound();
    const b = await outbound();
    const u = await outbound({ deliveryUncertain: true });
    expect(await inIsp(() => actions.retryFailedReplies({ items: [W(a.id), W(b.id), W(u.id), W(a.id)] }))).toEqual({ done: 2, skipped: 1 });
    expect((await row(u.id)).status).toBe("FAILED");
  });

  it("stops after the manual retry limit", async () => {
    current = sessions.replier;
    const r = await outbound({ manualRetryCount: 5 });
    expect((await inIsp(() => actions.retryFailedReply(W(r.id)))).error).toMatch(/retried 5 times/);
  });
});

describe("resolve, close, reopen", () => {
  it("close needs a reason; closed and resolved can be reopened; each step is in the history", async () => {
    current = sessions.replier;
    const r = await outbound();
    expect((await inIsp(() => actions.closeFailedReplies({ items: [W(r.id)] }))).error).toMatch(/why/);
    expect(await inIsp(() => actions.closeFailedReplies({ items: [W(r.id)], note: "Customer cancelled" }))).toEqual({ done: 1, skipped: 0 });
    expect(await row(r.id)).toMatchObject({ replyResolution: "CLOSED", replyResolvedById: sessions.replier.userId, replyResolutionNote: "Customer cancelled", status: "FAILED" });
    expect((await inIsp(() => actions.retryFailedReply(W(r.id)))).error).toMatch(/Reopen it first/);
    expect((await inIsp(() => actions.reopenFailedReply(W(r.id)))).done).toBe(1);
    expect((await inIsp(() => actions.resolveFailedReplies({ items: [W(r.id)], note: "Answered by phone" }))).done).toBe(1);
    expect((await history(r.id)).map((h) => h.action)).toEqual(["CLOSE", "REOPEN", "RESOLVE"]);
  });

  it("a reply that was retried and sent has nothing to reopen", async () => {
    current = sessions.replier;
    const r = await outbound({ status: "SENT", manualRetryCount: 1 });
    expect(await inIsp(() => actions.reopenFailedReply(W(r.id)))).toEqual({ done: 0, skipped: 1 });
  });

  it("the history is append-only", async () => {
    current = sessions.replier;
    const r = await outbound();
    await inIsp(() => actions.resolveFailedReplies({ items: [W(r.id)] }));
    const [h] = await history(r.id);
    await expect(rawPrisma.failedReplyAction.update({ where: { id: h!.id }, data: { note: "rewritten" } })).rejects.toThrow(/append-only/);
  });
});

describe("isolation and permissions", () => {
  it("another project's reply is not found from here, and its own project's people act on it there", async () => {
    current = sessions.replier;
    // A typed reply: a new project starts with automation off, which rightly refuses an automatic one.
    const foreign = await outbound({ projectId: BIZ.id, accountId: fx.bizAccount, actionType: "MANUAL_REPLY" });
    expect((await inIsp(() => actions.retryFailedReply(W(foreign.id)))).error).toMatch(/not found/);
    expect(await inIsp(() => actions.closeFailedReplies({ items: [W(foreign.id)], note: "x" }))).toEqual({ done: 0, skipped: 1 });
    expect((await row(foreign.id)).replyResolution).toBeNull();
    current = sessions.bizReplier;
    expect(await inBiz(() => actions.retryFailedReply(W(foreign.id)))).toEqual({ done: 1, skipped: 0 });
  });

  it("a viewer without messages.reply can list but not act", async () => {
    current = sessions.viewer;
    const r = await outbound();
    expect((await inIsp(() => actions.retryFailedReply(W(r.id)))).error).toBeTruthy();
    expect((await inIsp(() => actions.resolveFailedReplies({ items: [W(r.id)] }))).error).toBeTruthy();
    expect((await row(r.id)).status).toBe("FAILED");
  });
});

describe("channel replies", () => {
  async function channelReply(deliveryStatus: "FAILED" | "UNKNOWN") {
    return rawPrisma.channelMessage.create({
      data: { projectId: BIZ.id, conversationId: fx.conversation, connectionId: fx.connection, type: "TELEGRAM", direction: "OUTBOUND", senderType: "AGENT", text: "We are on it", occurredAt: new Date(), deliveryStatus, lastError: "Too Many Requests", idempotencyKey: `fr-${randomUUID()}` },
    });
  }

  it("are listed with OMNICHANNEL on; an UNKNOWN one needs confirmation; a retry goes through the channel queue and is recorded", async () => {
    current = sessions.bizReplier;
    const unknown = await channelReply("UNKNOWN");
    const failed = await channelReply("FAILED");
    const { rows } = await inBiz(() => reads.listFailedReplies(reads.parseFailedReplyFilters({ source: "CHANNEL" }), 1, 50, true));
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining([unknown.id, failed.id]));
    expect(rows.find((r) => r.id === unknown.id)?.category).toBe("DELIVERY_UNCERTAIN");

    const C = (id: string) => ({ source: "CHANNEL" as const, id });
    expect((await inBiz(() => actions.retryFailedReply(C(unknown.id)))).needsConfirmation).toBe(true);
    expect((await inBiz(() => actions.retryFailedReply(C(failed.id)))).done).toBe(1);
    expect(await rawPrisma.channelMessage.findUniqueOrThrow({ where: { id: failed.id } })).toMatchObject({ deliveryStatus: "QUEUED", manualRetryCount: 1 });
    expect(await rawPrisma.failedReplyAction.findMany({ where: { channelMessageId: failed.id } })).toEqual([expect.objectContaining({ action: "RETRY", fromStatus: "FAILED", actorUserId: sessions.bizReplier.userId })]);
  });
});
