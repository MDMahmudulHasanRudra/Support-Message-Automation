import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { DEFAULT_MOOD_POLICIES, PERMISSIONS, TRIGGERABLE_MOODS } from "@support-automation/shared";
import type { MoodDetectionSettings } from "@prisma/client";
import type { Session } from "@/server/auth";
import { policyField } from "@/lib/moodDetectionForm";

/**
 * Settings → Mood Detection, called as the browser calls it: the server-side permission, the
 * validation that refuses a switch that could do nothing, the audit of every change, and project
 * isolation of both the settings and the readings shown in WhatsApp Chat.
 */

let current: Session;
const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const ids = { editor: "", viewer: "", roles: [] as string[], account: "", biz: "", bizAccount: "" };
const sessions = {} as Record<"editor" | "viewer", Session>;
let saved: MoodDetectionSettings | null = null;

vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => current,
  getSession: async () => current,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => `/p/isp-digital${p}`, inWorkspace: async () => false }));

const { runWithProject } = await import("@/server/projectContext");
const action = await import("@/server/actions/moodDetection");
const reports = await import("@/server/moodDetectionReports");
const templateStatus = await import("@/server/notificationTemplateStatus");

const isp = { id: ORIGINAL_PROJECT_ID, slug: "isp-digital", name: "ISP Digital", status: "ACTIVE" as const };
const inIsp = <T,>(fn: () => Promise<T>) => runWithProject(isp, fn);

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
async function user(name: string, roleId: string) {
  const u = await rawPrisma.user.create({ data: { username: `${name}_${tag}`, email: `${name}_${tag}@example.test`, name, passwordHash: "x", permissionModuleId: roleId } });
  await rawPrisma.projectAccess.create({ data: { projectId: ORIGINAL_PROJECT_ID, userId: u.id } });
  return { id: u.id, session: { userId: u.id, username: u.username, email: u.email!, name } as Session };
}

/** The form as the page submits it, with overrides. */
function form(overrides: Record<string, string | string[] | null> = {}): FormData {
  const fields: Record<string, string | string[] | null> = {
    enabled: "on",
    analyzeText: "on",
    analyzeEmoji: "on",
    analyzeStickers: "on",
    sensitivity: "BALANCED",
    cooldown: "30",
    requireHumanHours: "24",
    unassignedMention: "OPTED_IN",
    internalGroupIds: [`mood-int-${tag}@g.us`],
  };
  for (const mood of TRIGGERABLE_MOODS) {
    const p = DEFAULT_MOOD_POLICIES[mood];
    for (const f of ["trigger", "notifyTeam", "internalAlert", "mentionMember", "customerMessage", "needsAttention"] as const) {
      fields[policyField(mood, f)] = p[f] ? "on" : null;
    }
    fields[policyField(mood, "conversation")] = p.conversation;
    fields[policyField(mood, "priority")] = p.priority;
  }
  Object.assign(fields, overrides);
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === null) continue;
    for (const one of Array.isArray(v) ? v : [v]) fd.append(k, one);
  }
  return fd;
}

beforeAll(async () => {
  saved = await rawPrisma.moodDetectionSettings.findUnique({ where: { projectId: ORIGINAL_PROJECT_ID } });
  await rawPrisma.moodDetectionSettings.deleteMany({ where: { projectId: ORIGINAL_PROJECT_ID } });
  const e = await user("mood_ed", await role("Mood edit", ["settings.view", "settings.edit"]));
  const v = await user("mood_view", await role("Mood view", ["settings.view"]));
  ids.editor = e.id;
  ids.viewer = v.id;
  sessions.editor = e.session;
  sessions.viewer = v.session;
  ids.account = (await rawPrisma.whatsAppAccount.create({ data: { projectId: ORIGINAL_PROJECT_ID, label: `Mood ${tag}`, status: "CONNECTED" } })).id;
  await rawPrisma.whatsAppGroup.create({ data: { projectId: ORIGINAL_PROJECT_ID, accountId: ids.account, whatsappGroupId: `mood-int-${tag}@g.us`, name: "Escalations", isActive: true } });

  const biz = await createProjectWithDefaults({ name: `Mood Biz ${tag}`, slug: `mood-biz-${tag}`, status: "ACTIVE", creatorUserId: e.id }, rawPrisma);
  ids.biz = biz.id;
  ids.bizAccount = (await rawPrisma.whatsAppAccount.create({ data: { projectId: biz.id, label: `Mood Biz ${tag}`, status: "CONNECTED" } })).id;
  await rawPrisma.whatsAppGroup.create({ data: { projectId: biz.id, accountId: ids.bizAccount, whatsappGroupId: `mood-biz-${tag}@g.us`, name: "Biz escalations", isActive: true } });
});

afterAll(async () => {
  await rawPrisma.customerMoodEvent.deleteMany({ where: { accountId: { in: [ids.account, ids.bizAccount] } } });
  await rawPrisma.message.deleteMany({ where: { accountId: { in: [ids.account, ids.bizAccount] } } });
  await rawPrisma.whatsAppGroup.deleteMany({ where: { accountId: { in: [ids.account, ids.bizAccount] } } });
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: { in: [ids.account, ids.bizAccount] } } });
  await rawPrisma.moodDetectionSettings.deleteMany({ where: { projectId: ORIGINAL_PROJECT_ID } });
  if (saved) await rawPrisma.moodDetectionSettings.create({ data: { ...saved, policies: saved.policies ?? undefined } });
  await rawPrisma.systemLog.deleteMany({ where: { actorUserId: { in: [ids.editor, ids.viewer] } } });
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((r) => r.table_name);
  for (let pass = 0; pass < 4; pass++) {
    for (const t of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "projectId" = $1`, ids.biz).catch(() => undefined);
  }
  await rawPrisma.project.deleteMany({ where: { id: ids.biz } });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: [ids.editor, ids.viewer] } } });
  await rawPrisma.user.deleteMany({ where: { id: { in: [ids.editor, ids.viewer] } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: { in: ids.roles } } });
  await rawPrisma.$disconnect();
});

describe("saving Mood Detection settings", () => {
  it("refuses a role without settings.edit, on the server, and writes nothing", async () => {
    current = sessions.viewer;
    const result = await inIsp(() => action.saveMoodDetectionSettings({}, form()));
    expect(result.error).toBeTruthy();
    expect(await rawPrisma.moodDetectionSettings.findUnique({ where: { projectId: ORIGINAL_PROJECT_ID } })).toBeNull();
  });

  it("saves for an editor and audits what changed, from what, to what", async () => {
    current = sessions.editor;
    const result = await inIsp(() => action.saveMoodDetectionSettings({}, form({ cooldown: "15" })));
    expect(result).toMatchObject({ saved: true });
    const row = await rawPrisma.moodDetectionSettings.findUniqueOrThrow({ where: { projectId: ORIGINAL_PROJECT_ID } });
    expect(row).toMatchObject({ enabled: true, cooldownMinutes: 15, internalGroupIds: [`mood-int-${tag}@g.us`], updatedById: ids.editor });
    const log = await rawPrisma.systemLog.findFirstOrThrow({ where: { actorUserId: ids.editor, scope: "mood-detection" }, orderBy: { createdAt: "desc" } });
    expect(log.projectId).toBe(ORIGINAL_PROJECT_ID);
    expect(log.message).toBe("Mood Detection switched on");
    expect((log.metadata as { changes: Record<string, unknown> }).changes).toMatchObject({ enabled: { from: false, to: true }, cooldownMinutes: { from: 30, to: 15 } });

    // A policy change is audited per mood and field.
    await inIsp(() => action.saveMoodDetectionSettings({}, form({ cooldown: "15", [policyField("ANGRY", "priority")]: "CRITICAL" })));
    const second = await rawPrisma.systemLog.findFirstOrThrow({ where: { actorUserId: ids.editor, scope: "mood-detection" }, orderBy: { createdAt: "desc" } });
    expect((second.metadata as { changes: Record<string, unknown> }).changes).toEqual({ "ANGRY.priority": { from: "HIGH", to: "CRITICAL" } });
  });

  it("refuses a setting that could do nothing", async () => {
    current = sessions.editor;
    const noGroup = await inIsp(() => action.saveMoodDetectionSettings({}, form({ internalGroupIds: [] })));
    expect(noGroup.error).toMatch(/internal escalation group/);
    const noSource = await inIsp(() => action.saveMoodDetectionSettings({}, form({ analyzeText: null, analyzeEmoji: null, analyzeStickers: null })));
    expect(noSource.error).toMatch(/reads nothing/);
    const badThreshold = await inIsp(() => action.saveMoodDetectionSettings({}, form({ sensitivity: "CUSTOM", minConfidence: "20" })));
    expect(badThreshold.error).toMatch(/50 to 99/);
  });

  it("drops an escalation group from another project, and never touches another project's settings", async () => {
    current = sessions.editor;
    await inIsp(() =>
      action.saveMoodDetectionSettings({}, form({ internalGroupIds: [`mood-int-${tag}@g.us`, `mood-biz-${tag}@g.us`] })),
    );
    const row = await rawPrisma.moodDetectionSettings.findUniqueOrThrow({ where: { projectId: ORIGINAL_PROJECT_ID } });
    expect(row.internalGroupIds).toEqual([`mood-int-${tag}@g.us`]);
    const biz = await rawPrisma.moodDetectionSettings.findUniqueOrThrow({ where: { projectId: ids.biz } });
    expect(biz.enabled).toBe(false);
  });
});

describe("what the rest of the app reads", () => {
  it("the Mood alert template says whether it can send", async () => {
    current = sessions.editor;
    await rawPrisma.moodDetectionSettings.update({ where: { projectId: ORIGINAL_PROJECT_ID }, data: { enabled: false } });
    let status = await inIsp(() => templateStatus.getTemplateLiveness());
    expect(status.MOOD_ALERT).toMatchObject({ live: false, reason: "Mood Detection is off." });
    expect(status.MOOD_CUSTOMER_ANGRY?.live).toBe(false);
    await rawPrisma.moodDetectionSettings.update({ where: { projectId: ORIGINAL_PROJECT_ID }, data: { enabled: true } });
    status = await inIsp(() => templateStatus.getTemplateLiveness());
    expect(status.MOOD_CUSTOMER_ANGRY).toMatchObject({ live: false, reason: expect.stringMatching(/off by default/) });
  });

  it("chat moods are per WhatsApp group, aggregated per customer, and confined to the project", async () => {
    const jid = `mood-chat-${tag}@g.us`;
    const group = await rawPrisma.whatsAppGroup.create({ data: { projectId: ORIGINAL_PROJECT_ID, accountId: ids.account, whatsappGroupId: jid, name: "Chat", isActive: true, isMonitored: true } });
    const now = new Date();
    const reading = async (projectId: string, accountId: string, groupId: string, customerKey: string, mood: string, at = now) => {
      const m = await rawPrisma.message.create({
        data: { projectId, accountId, groupId, whatsappMessageId: randomUUID(), chatId: jid, senderPhone: customerKey, direction: "INCOMING", body: "x", normalizedBody: "x", timestampWa: at, processingStatus: "PROCESSED" },
      });
      await rawPrisma.customerMoodEvent.create({
        data: { projectId, messageId: m.id, accountId, groupId, whatsappGroupId: jid, customerKey, messageAt: at, mood, confidence: 0.9, signals: ["ANGRY_EMOJI"], status: "ANALYZED", scheduledAt: now },
      });
      return m;
    };
    const angry = await reading(ORIGINAL_PROJECT_ID, ids.account, group.id, "880111", "ANGRY");
    // This customer WAS very angry half an hour ago and has since calmed down: only their latest counts.
    await reading(ORIGINAL_PROJECT_ID, ids.account, group.id, "880222", "VERY_ANGRY", new Date(now.getTime() - 30 * 60_000));
    await reading(ORIGINAL_PROJECT_ID, ids.account, group.id, "880222", "NEUTRAL");

    // A sticker afterwards (confidence 0) says nothing about mood and must not reset theirs.
    await reading(ORIGINAL_PROJECT_ID, ids.account, group.id, "880111", "NEUTRAL", new Date(now.getTime() + 1000));
    await rawPrisma.customerMoodEvent.updateMany({ where: { customerKey: "880111", mood: "NEUTRAL" }, data: { confidence: 0, signals: ["UNKNOWN_STICKER_SIGNAL"] } });
    const moods = await inIsp(() => reports.getGroupMoods([jid]));
    expect(moods.get(jid)).toBe("ANGRY");
    const perMessage = await inIsp(() => reports.getMessageMoods(jid, [angry.whatsappMessageId]));
    expect(perMessage.get(angry.whatsappMessageId)).toMatchObject({ mood: "ANGRY", signals: ["ANGRY_EMOJI"] });

    // Another project's reading on a WhatsApp group with the same id is invisible here.
    const bizGroup = await rawPrisma.whatsAppGroup.create({ data: { projectId: ids.biz, accountId: ids.bizAccount, whatsappGroupId: `mood-biz-chat-${tag}@g.us`, name: "Biz chat", isActive: true } });
    await reading(ids.biz, ids.bizAccount, bizGroup.id, "880333", "VERY_ANGRY");
    expect((await inIsp(() => reports.getGroupMoods([jid]))).get(jid)).toBe("ANGRY");
  });
});
