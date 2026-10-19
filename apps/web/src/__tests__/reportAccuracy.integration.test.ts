import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Report accuracy audit (19 Oct 2026), Phase 1: every employee's message is credited to them, every
 * message is counted once, and our own messages are never a customer's — against real rows.
 *
 * Each case failed against the loader before the fix it names:
 *  - a colleague on file with only their phone, whose message one of our numbers stored with their
 *    LID and the other with their phone, was a CUSTOMER whenever the LID copy happened to be kept;
 *  - an AI reply was reported as a person's whenever the copy another of our numbers stored was kept;
 *  - our number A's post, stored by B as INCOMING before B recognised our own posts, was a customer
 *    message that opened a wait;
 *  - the stored team-member stamp overrode a member's "count their messages from" date;
 *  - a dashboard reply from a login linked to a team member was credited to nobody;
 *  - a member entered in local form ("01…") matched no message at all;
 *  - a member's report showed Missed in a group they were assigned to but whose waits it left out.
 * And the Team Members actions: local numbers stored with their country code, Add from group storing
 * a phone as a number (not as "needs a phone number"), the chat link replacing such a placeholder,
 * and Delete keeping anybody who has messages.
 */

let current: Session;
const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const D = "2025-05-14";
/** A Dhaka wall-clock time on D, as an instant. */
const t = (hh: number, mm: number) => new Date(Date.UTC(2025, 4, 14, hh - 6, mm));
const NOW = new Date();
const lid = () => `${Math.floor(1e14 + Math.random() * 8e14)}`;
const nine = () => String(Math.floor(Math.random() * 1e9)).padStart(9, "0");
const phone = () => `88017${nine().slice(1)}`;
const wgid = (n: number) => `120367${Date.now()}${n}${Math.floor(Math.random() * 1000)}@g.us`;

vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => current,
  getSession: async () => current,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => p, inWorkspace: async () => false }));

const { runWithProject } = await import("@/server/projectContext");
const { loadTeamReport, parseTeamReportFilters } = await import("@/server/teamReport");
const { createTeamMember, addTeamMembersFromGroup, linkWhatsAppSender, deleteTeamMember } = await import("@/server/actions/teamMembers");

const ids = { role: "", user: "", project: "", slug: "", accountA: "", accountB: "" };
const G = Array.from({ length: 8 }, (_, i) => wgid(i));
const groupRow: Record<string, { A: string; B: string }> = {};
const people = {
  accountAPhone: phone(),
  customer: lid(),
  nadiaLid: lid(),
  nadiaPhone: phone(),
  aiLid: lid(),
  karimPhone: phone(),
  formerPhone: phone(),
  limaLocal: `017${nine().slice(1)}`,
};
const members = { nadia: "", karim: "", sara: "", lima: "", rakib: "" };

const project = () => ({ id: ids.project, slug: ids.slug, name: `Accuracy ${tag}`, status: "ACTIVE" as const });
const inProject = <T,>(fn: () => Promise<T>) => runWithProject(project(), fn);
const report = (extra: Record<string, string> = {}) =>
  inProject(() => loadTeamReport(parseTeamReportFilters({ period: "day", date: D, ...extra }, NOW), NOW));

async function message(input: {
  g: number;
  row: "A" | "B";
  key: string;
  sender: string;
  jid: string | null;
  direction: "INCOMING" | "OUTGOING";
  at: Date;
  fromTeam?: boolean;
  fromMe?: boolean;
}) {
  const chat = G[input.g]!;
  return rawPrisma.message.create({
    data: {
      projectId: ids.project,
      accountId: input.row === "A" ? ids.accountA : ids.accountB,
      groupId: groupRow[chat]![input.row],
      chatId: chat,
      whatsappMessageId: `${input.fromMe ? "true" : "false"}_${chat}_${input.key}${tag}_${input.jid ?? input.sender}`,
      senderPhone: input.sender,
      senderJid: input.jid,
      isFromTeamMember: input.fromTeam ?? false,
      direction: input.direction,
      body: "text",
      normalizedBody: "text",
      timestampWa: input.at,
      processingStatus: "PROCESSED",
    },
    select: { id: true, whatsappMessageId: true },
  });
}

const customerAsks = (g: number, at: Date) =>
  message({ g, row: "A", key: `C${g}`, sender: people.customer, jid: `${people.customer}@lid`, direction: "INCOMING", at });

beforeAll(async () => {
  const permission = PERMISSIONS.find((p) => p.key === "whatsapp.manage")!;
  const perm = await rawPrisma.permission.upsert({
    where: { key: permission.key },
    create: { key: permission.key, label: permission.label, category: permission.category },
    update: {},
    select: { id: true },
  });
  ids.role = (await rawPrisma.permissionModule.create({ data: { name: `Accuracy role ${tag}`, permissions: { create: [{ permissionId: perm.id }] } } })).id;
  const u = await rawPrisma.user.create({
    data: { username: `acc_${tag}`, email: `acc_${tag}@example.test`, name: "Accuracy", passwordHash: "x", permissionModuleId: ids.role },
  });
  ids.user = u.id;
  current = { userId: u.id, username: u.username, email: u.email!, name: "Accuracy" } as Session;
  const created = await createProjectWithDefaults({ name: `Accuracy ${tag}`, slug: `acc-${tag}`, status: "ACTIVE", creatorUserId: u.id }, rawPrisma);
  ids.project = created.id;
  ids.slug = created.slug;
  // The creator already has access (createProjectWithDefaults).
  const pid = { projectId: created.id };
  ids.accountA = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `Acc A ${tag}`, status: "CONNECTED", phoneNumber: `+${people.accountAPhone}` } })).id;
  ids.accountB = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `Acc B ${tag}`, status: "CONNECTED" } })).id;
  for (const chat of G) {
    const row = (accountId: string) =>
      rawPrisma.whatsAppGroup.create({
        data: { ...pid, accountId, whatsappGroupId: chat, name: `Acc group ${tag}`, isMonitored: true, isActive: true, lastSyncedAt: new Date() },
        select: { id: true },
      });
    groupRow[chat] = { A: (await row(ids.accountA)).id, B: (await row(ids.accountB)).id };
  }

  members.nadia = (await rawPrisma.internalTeamMember.create({ data: { ...pid, name: `Nadia ${tag}`, phoneNumber: `+${people.nadiaPhone}`, role: "Support" } })).id;
  members.karim = (
    await rawPrisma.internalTeamMember.create({
      data: { ...pid, name: `Karim ${tag}`, phoneNumber: `+${people.karimPhone}`, role: "Support", attributeFrom: new Date(Date.UTC(2025, 4, 20)) },
    })
  ).id;
  members.sara = (await rawPrisma.internalTeamMember.create({ data: { ...pid, name: `Sara ${tag}`, phoneNumber: `+${phone()}`, role: "Support", userId: u.id } })).id;
  // Stored exactly as somebody typed it before the form added the country code.
  members.lima = (await rawPrisma.internalTeamMember.create({ data: { ...pid, name: `Lima ${tag}`, phoneNumber: people.limaLocal, role: "Support" } })).id;
  members.rakib = (await rawPrisma.internalTeamMember.create({ data: { ...pid, name: `Rakib ${tag}`, phoneNumber: `+${phone()}`, role: "Support" } })).id;

  // G0 — Nadia (phone on file only) answers; A stored her LID, B her phone. The LID copy is stored first.
  await customerAsks(0, t(9, 0));
  await message({ g: 0, row: "A", key: "N", sender: people.nadiaLid, jid: `${people.nadiaLid}@lid`, direction: "INCOMING", at: t(9, 5) });
  await message({ g: 0, row: "B", key: "N", sender: people.nadiaPhone, jid: `${people.nadiaPhone}@c.us`, direction: "INCOMING", at: t(9, 5) });

  // G1 — the AI answers from A. B's copy of it (stored OUTGOING by the own-number check) is stored first.
  await customerAsks(1, t(10, 0));
  await message({ g: 1, row: "B", key: "AI", sender: people.aiLid, jid: `${people.aiLid}@lid`, direction: "OUTGOING", at: t(10, 2) });
  const aiCopy = await message({ g: 1, row: "A", key: "AI", sender: people.aiLid, jid: `${people.aiLid}@lid`, direction: "OUTGOING", at: t(10, 2), fromMe: true });
  await rawPrisma.outboundMessage.create({
    data: {
      ...pid,
      accountId: ids.accountA,
      chatId: G[1]!,
      toPhone: G[1]!,
      body: "text",
      actionType: "AUTO_REPLY",
      idempotencyKey: `acc-ai-${tag}`,
      status: "SENT",
      sentAt: t(10, 2),
      providerMessageId: aiCopy.whatsappMessageId,
    },
  });

  // G2 — A's reply, which only B stored, as INCOMING from A's own number (before the own-number check).
  await customerAsks(2, t(11, 0));
  await message({ g: 2, row: "B", key: "OWN", sender: people.accountAPhone, jid: `${people.accountAPhone}@c.us`, direction: "INCOMING", at: t(11, 3) });

  // G3 — Karim, stamped staff live, writes before his "count their messages from" date: a customer then.
  await message({ g: 3, row: "A", key: "K", sender: people.karimPhone, jid: `${people.karimPhone}@c.us`, direction: "INCOMING", at: t(12, 0), fromTeam: true });

  // G4 — somebody stamped staff and since deleted from the roster: still staff, credited to nobody.
  await customerAsks(4, t(12, 30));
  await message({ g: 4, row: "A", key: "F", sender: people.formerPhone, jid: `${people.formerPhone}@c.us`, direction: "INCOMING", at: t(12, 35), fromTeam: true });

  // G5 — Sara answers from the dashboard inbox (her login is linked to her roster entry).
  await customerAsks(5, t(13, 0));
  const operatorEcho = await message({ g: 5, row: "A", key: "OP", sender: people.aiLid, jid: `${people.aiLid}@lid`, direction: "OUTGOING", at: t(13, 1), fromMe: true });
  await rawPrisma.outboundMessage.create({
    data: {
      ...pid,
      accountId: ids.accountA,
      chatId: G[5]!,
      toPhone: G[5]!,
      body: "text",
      actionType: "MANUAL_REPLY",
      idempotencyKey: `acc-op-${tag}`,
      status: "SENT",
      sentAt: t(13, 1),
      providerMessageId: operatorEcho.whatsappMessageId,
      createdById: u.id,
    },
  });

  // G6 — Lima, on file as "01…", answers from her number.
  await customerAsks(6, t(14, 0));
  await message({ g: 6, row: "A", key: "L", sender: `88${people.limaLocal}`, jid: `88${people.limaLocal}@c.us`, direction: "INCOMING", at: t(14, 4) });

  // G7 — assigned to Rakib; a customer asks and nobody ever answers. Rakib never writes there.
  await rawPrisma.whatsAppGroup.updateMany({ where: { whatsappGroupId: G[7]! }, data: { assignedTeamMemberId: members.rakib } });
  await customerAsks(7, t(9, 0));
}, 120_000);

afterAll(async () => {
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((row) => row.table_name);
  for (let pass = 0; pass < 6; pass++) {
    for (const name of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${name}" WHERE "projectId" = $1`, ids.project).catch(() => undefined);
  }
  await rawPrisma.projectAccess.deleteMany({ where: { userId: ids.user } });
  await rawPrisma.project.deleteMany({ where: { id: ids.project } });
  await rawPrisma.user.deleteMany({ where: { id: ids.user } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: ids.role } });
  await rawPrisma.$disconnect();
});

const groupOf = (data: Awaited<ReturnType<typeof report>>, g: number) => data.result.groups.find((row) => row.groupKey === G[g]);
const memberOf = (data: Awaited<ReturnType<typeof report>>, id: string) => data.result.members.find((row) => row.memberId === id);

describe("Team Report: who sent it", () => {
  it("credits a colleague when ANY stored copy identifies them, not only the copy that was kept", async () => {
    const data = await report();
    expect(memberOf(data, members.nadia)?.messages).toBe(1);
    expect(groupOf(data, 0)).toMatchObject({ customerMessages: 1, memberReplies: 1 });
    expect(data.result.waits.find((w) => w.groupKey === G[0])?.repliedBy).toBe(members.nadia);
  });

  it("reports an AI reply as the AI whichever of our numbers' copies is kept", async () => {
    const data = await report();
    const wait = data.result.waits.find((w) => w.groupKey === G[1]);
    expect(wait?.repliedByActor).toBe("AI");
  });

  it("never counts our own number's post as a customer message, even when only another number stored it", async () => {
    const data = await report();
    expect(groupOf(data, 2)).toMatchObject({ customerMessages: 1, businessReplies: 1 });
    expect(data.result.waits.find((w) => w.groupKey === G[2])?.repliedBy).toBe("BUSINESS");
  });

  it("lets a member's 'count their messages from' date win over the stored team-member stamp", async () => {
    const data = await report();
    expect(memberOf(data, members.karim)).toBeUndefined();
    expect(groupOf(data, 3)).toMatchObject({ customerMessages: 1, memberReplies: 0 });
  });

  it("keeps a message stamped staff by a member since deleted as staff, credited to nobody and counted as such", async () => {
    const data = await report();
    expect(groupOf(data, 4)).toMatchObject({ customerMessages: 1, memberReplies: 1 });
    expect(data.result.summary.unattributedStaffReplies).toBeGreaterThanOrEqual(1);
  });

  it("credits a reply typed in the dashboard to the team member linked to that login", async () => {
    const data = await report();
    expect(memberOf(data, members.sara)?.messages).toBe(1);
    expect(data.result.waits.find((w) => w.groupKey === G[5])?.repliedBy).toBe(members.sara);
  });

  it("matches a member entered in local form ('01…') to WhatsApp's international number", async () => {
    const data = await report();
    expect(memberOf(data, members.lima)?.messages).toBe(1);
  });

  it("shows a member the groups and waits behind the Missed charged to them", async () => {
    const data = await report({ member: members.rakib });
    expect(data.result.summary.missed).toBeGreaterThanOrEqual(1);
    expect(data.result.summary.waits).toBeGreaterThanOrEqual(data.result.summary.missed);
    expect(groupOf(data, 7)).toBeDefined();
  });
});

describe("Team Members: identifiers stored so they match", () => {
  const form = (fields: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries({ role: "Support", status: "ACTIVE", ...fields })) f.set(k, v);
    return f;
  };

  it("stores a local Bangladeshi number with its country code, and refuses it again in international form", async () => {
    const local = `018${nine().slice(1)}`;
    expect(await inProject(() => createTeamMember({}, form({ name: `Local ${tag}`, phoneNumber: local })))).toEqual({ success: true });
    const row = await rawPrisma.internalTeamMember.findFirstOrThrow({ where: { projectId: ids.project, name: `Local ${tag}` } });
    expect(row.phoneNumber).toBe(`+88${local}`);
    const again = await inProject(() => createTeamMember({}, form({ name: `Twin ${tag}`, phoneNumber: `+88 ${local}` })));
    expect(again.error).toMatch(/already has that number/);
  });

  it("adds a person picked from a group by PHONE as a reachable number, and by LID as a WhatsApp ID", async () => {
    const pn = phone();
    const id = lid();
    const f = new FormData();
    f.append("selected", `pn:${pn}|Phone Person ${tag}`);
    f.append("selected", `lid:${id}|Lid Person ${tag}`);
    expect(await inProject(() => addTeamMembersFromGroup({}, f))).toEqual({ addedCount: 2 });
    const byPhone = await rawPrisma.internalTeamMember.findFirstOrThrow({ where: { projectId: ids.project, name: `Phone Person ${tag}` } });
    const byLid = await rawPrisma.internalTeamMember.findFirstOrThrow({ where: { projectId: ids.project, name: `Lid Person ${tag}` } });
    expect(byPhone).toMatchObject({ phoneNumber: `+${pn}`, whatsappId: null });
    expect(byLid).toMatchObject({ phoneNumber: id, whatsappId: id });
  });

  it("lets the chat link replace a WhatsApp ID that is only the member's own phone number", async () => {
    const pn = phone();
    const member = await rawPrisma.internalTeamMember.create({
      data: { projectId: ids.project, name: `Placeholder ${tag}`, phoneNumber: pn, whatsappId: pn, role: "Support" },
    });
    const newLid = lid();
    const f = new FormData();
    f.set("memberId", member.id);
    expect(await inProject(() => linkWhatsAppSender(`${newLid}@lid`, {}, f))).toEqual({ linked: `Placeholder ${tag}` });
    expect((await rawPrisma.internalTeamMember.findUniqueOrThrow({ where: { id: member.id } })).whatsappId).toBe(newLid);
  });

  it("deactivates instead of deleting a member who has messages, even with Support Activity off", async () => {
    expect(await inProject(() => deleteTeamMember(members.nadia))).toEqual({ deactivated: true });
    expect((await rawPrisma.internalTeamMember.findUniqueOrThrow({ where: { id: members.nadia } })).status).toBe("INACTIVE");
    // Her history is still hers.
    expect(memberOf(await report(), members.nadia)?.messages).toBe(1);
  });
});
