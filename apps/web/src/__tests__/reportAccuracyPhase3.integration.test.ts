import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Report accuracy audit (19 Oct 2026), Phase 3:
 *  - a Missed wait stays charged to whoever the group was assigned to when the customer asked, after
 *    the group is reassigned (it used to move to the new assignee, for every past period);
 *  - adding a team member queues the re-attribution of their stored history;
 *  - Team Members → Identity check finds a member on our own number, a member nothing matched, and
 *    an unknown sender active in several groups.
 */

let current: Session;
const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const D = "2025-08-12";
const t = (hh: number, mm: number) => new Date(Date.UTC(2025, 7, 12, hh - 6, mm));
const nine = () => String(Math.floor(Math.random() * 1e9)).padStart(9, "0");
const phone = () => `88017${nine().slice(1)}`;
const groupsWa = Array.from({ length: 3 }, (_, i) => `120373${Date.now()}${i}${Math.floor(Math.random() * 1000)}@g.us`);
const ourNumber = phone();
const stranger = phone();

vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => current,
  getSession: async () => current,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => p, inWorkspace: async () => false }));

const { runWithProject } = await import("@/server/projectContext");
const { loadTeamReport, parseTeamReportFilters } = await import("@/server/teamReport");
const { setGroupPriority } = await import("@/server/actions/groups");
const { createTeamMember, addTeamMemberFromSender } = await import("@/server/actions/teamMembers");
const { getRosterIdentityHealth, getMemberHistorySync } = await import("@/server/rosterIdentityHealth");

const ids = { role: "", user: "", project: "", slug: "", account: "", groups: [] as string[], rakib: "", bipul: "", onOurNumber: "" };
const project = () => ({ id: ids.project, slug: ids.slug, name: `Acc3 ${tag}`, status: "ACTIVE" as const });
const inProject = <T,>(fn: () => Promise<T>) => runWithProject(project(), fn);

beforeAll(async () => {
  const keys = ["whatsapp.manage", "whatsapp.view"];
  const perms = [];
  for (const key of keys) {
    const p = PERMISSIONS.find((x) => x.key === key)!;
    perms.push(await rawPrisma.permission.upsert({ where: { key }, create: { key, label: p.label, category: p.category }, update: {}, select: { id: true } }));
  }
  ids.role = (await rawPrisma.permissionModule.create({ data: { name: `Acc3 role ${tag}`, permissions: { create: perms.map((p) => ({ permissionId: p.id })) } } })).id;
  const u = await rawPrisma.user.create({ data: { username: `acc3_${tag}`, email: `acc3_${tag}@example.test`, name: "Acc3", passwordHash: "x", permissionModuleId: ids.role } });
  ids.user = u.id;
  current = { userId: u.id, username: u.username, email: u.email!, name: "Acc3" } as Session;
  const created = await createProjectWithDefaults({ name: `Acc3 ${tag}`, slug: `acc3-${tag}`, status: "ACTIVE", creatorUserId: u.id }, rawPrisma);
  ids.project = created.id;
  ids.slug = created.slug;
  const pid = { projectId: created.id };
  ids.account = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `Acc3 ${tag}`, status: "CONNECTED", phoneNumber: `+${ourNumber}` } })).id;
  ids.rakib = (await rawPrisma.internalTeamMember.create({ data: { ...pid, name: `Rakib ${tag}`, phoneNumber: `+${phone()}`, role: "Support" } })).id;
  ids.bipul = (await rawPrisma.internalTeamMember.create({ data: { ...pid, name: `Bipul ${tag}`, phoneNumber: `+${phone()}`, role: "Support" } })).id;
  ids.onOurNumber = (await rawPrisma.internalTeamMember.create({ data: { ...pid, name: `Shared ${tag}`, phoneNumber: `+${ourNumber}`, role: "Support" } })).id;
  for (const [i, wa] of groupsWa.entries()) {
    ids.groups.push(
      (
        await rawPrisma.whatsAppGroup.create({
          data: { ...pid, accountId: ids.account, whatsappGroupId: wa, name: `Acc3 ${i} ${tag}`, isMonitored: true, isActive: true, lastSyncedAt: new Date(), assignedTeamMemberId: i === 0 ? ids.rakib : null },
          select: { id: true },
        })
      ).id,
    );
  }
  // On D a customer asks in group 0 and nobody answers: a Missed wait while Rakib owns the group.
  // An unknown sender writes in all three groups (recently, for the identity check).
  const recent = new Date(Date.now() - 86_400_000);
  for (const [i, wa] of groupsWa.entries()) {
    const at = i === 0 ? t(10, 0) : recent;
    const sender = i === 0 ? phone() : stranger;
    await rawPrisma.message.create({
      data: { ...pid, accountId: ids.account, groupId: ids.groups[i]!, chatId: wa, whatsappMessageId: `false_${wa}_C${i}${tag}_${sender}@c.us`, senderPhone: sender, senderJid: `${sender}@c.us`, direction: "INCOMING", body: "text", normalizedBody: "text", timestampWa: at, processingStatus: "PROCESSED" },
    });
    await rawPrisma.message.create({
      data: { ...pid, accountId: ids.account, groupId: ids.groups[i]!, chatId: wa, whatsappMessageId: `false_${wa}_S${i}${tag}_${stranger}@c.us`, senderPhone: stranger, senderJid: `${stranger}@c.us`, direction: "INCOMING", body: "text", normalizedBody: "text", timestampWa: recent, processingStatus: "PROCESSED" },
    });
  }
}, 120_000);

afterAll(async () => {
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((r) => r.table_name);
  for (let pass = 0; pass < 6; pass++) {
    for (const name of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${name}" WHERE "projectId" = $1`, ids.project).catch(() => undefined);
  }
  await rawPrisma.projectAccess.deleteMany({ where: { userId: ids.user } });
  await rawPrisma.project.deleteMany({ where: { id: ids.project } });
  await rawPrisma.user.deleteMany({ where: { id: ids.user } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: ids.role } });
  await rawPrisma.$disconnect();
});

describe("Missed stays with whoever owned the group at the time", () => {
  it("is charged to Rakib, who was assigned when the customer asked, after the group moves to Bipul", async () => {
    const report = () => inProject(() => loadTeamReport(parseTeamReportFilters({ period: "day", date: D, groups: groupsWa[0]! }, new Date()), new Date()));
    expect((await report()).result.members.find((m) => m.memberId === ids.rakib)?.missed).toBe(1);

    const form = new FormData();
    form.set("priority", "");
    form.set("assignedTeamMemberId", ids.bipul);
    await inProject(() => setGroupPriority(ids.groups[0]!, form));
    expect(await rawPrisma.groupResponsibilityChange.count({ where: { projectId: ids.project } })).toBe(1);

    const after = await report();
    expect(after.result.members.find((m) => m.memberId === ids.rakib)?.missed).toBe(1);
    expect(after.result.members.find((m) => m.memberId === ids.bipul)).toBeUndefined();
  });
});

describe("a roster change reaches stored history", () => {
  it("queues the re-attribution of a new member's history", async () => {
    const form = new FormData();
    for (const [k, v] of Object.entries({ name: `Newcomer ${tag}`, phoneNumber: `+${phone()}`, role: "Support", status: "ACTIVE" })) form.set(k, v);
    expect(await inProject(() => createTeamMember({}, form))).toEqual({ success: true });
    const request = await rawPrisma.identityReattribution.findFirstOrThrow({ where: { projectId: ids.project } });
    expect(request).toMatchObject({ status: "PENDING" });
    expect(request.identifiers.length).toBeGreaterThan(0);
  });
});

describe("Team Members → Identity check", () => {
  it("finds a member on our own number, members nothing matched, and a frequent unknown sender", async () => {
    const health = await inProject(() => getRosterIdentityHealth());
    expect(health.ownNumberMembers.map((m) => m.id)).toEqual([ids.onOurNumber]);
    expect(health.quietMembers.map((m) => m.id)).toEqual(expect.arrayContaining([ids.rakib, ids.bipul]));
    expect(health.unknownFrequentSenders).toEqual([expect.objectContaining({ sender: stranger, groups: 3, phone: `+${stranger}` })]);
  });
});

describe("adding a colleague who was already supporting customers", () => {
  it("adds the frequent unknown sender by the number WhatsApp delivered, and queues collecting their history", async () => {
    const form = new FormData();
    form.set("name", `Found ${tag}`);
    expect(await inProject(() => addTeamMemberFromSender(stranger, {}, form))).toEqual({ added: `Found ${tag}` });
    const member = await rawPrisma.internalTeamMember.findFirstOrThrow({ where: { projectId: ids.project, name: `Found ${tag}` } });
    expect(member).toMatchObject({ phoneNumber: `+${stranger}`, whatsappId: null, status: "ACTIVE" });
    // They are no longer an unknown sender, and every report credits their earlier messages at once.
    expect((await inProject(() => getRosterIdentityHealth())).unknownFrequentSenders).toEqual([]);
    const pending = await inProject(() => getMemberHistorySync());
    expect(pending.get(member.id)?.state).toBe("SYNCING");

    // When the worker has collected it, the page says what was found.
    await rawPrisma.identityReattribution.updateMany({
      where: { projectId: ids.project, memberIds: { has: member.id } },
      data: { status: "DONE", result: { members: { [member.id]: { messages: 3, groups: 3, firstAt: null, lastAt: null } } } },
    });
    expect((await inProject(() => getMemberHistorySync())).get(member.id)).toMatchObject({ state: "DONE", messages: 3, groups: 3 });
  });
});
