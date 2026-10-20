import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import type { Session } from "@/server/auth";

/**
 * Unified reporting WP6: the personal-chat Team Report (loader, scope gate, exports) on the isolated
 * database. Synthetic data only. Two projects fill the same window, so a personal chat that leaks across
 * the project boundary fails here; every customer line carries a marker the exports must never print.
 */

let current: Session;
const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const id = (name: string) => `pr-${tag}-${name}`;
const NOW = new Date(Date.UTC(2025, 6, 9, 12, 0));
/** A Dhaka wall-clock time on 7 or 8 July 2025, as an instant. */
const t = (day: 7 | 8, hh: number, mm: number) => new Date(Date.UTC(2025, 6, day, hh - 6, mm));
const SECRET = "SECRETBODY";

const G0 = "120000000000000001@g.us";
const CHAT = {
  c1: "8801000000301@c.us",
  c2: "100000000302@lid",
  internal: "8801000000102@c.us",
  own: "8801500000001@c.us",
  other: "8801000000399@c.us",
  status: "status@broadcast",
  newsletter: "120363000000000009@newsletter",
  orphan: "120000000000000099@g.us",
};
const PHONE = { rakib: "8801000000102", dash: "8801000000103", ourA: "8801500000001" };

vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => current,
  getSession: async () => current,
}));
vi.mock("@/server/authorize", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/authorize")>()),
  requireAccess: async () => current,
  checkPermission: async () => ({ session: current }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => p, inWorkspace: async () => false }));

const { runWithProject } = await import("@/server/projectContext");
const { loadPersonalReport } = await import("@/server/personalReport");
const { loadCombinedReport } = await import("@/server/combinedReport");
const { loadTeamReport, parseTeamReportFilters } = await import("@/server/teamReport");
const { resolvePageScope } = await import("@/server/unifiedReporting");
const { forgetProjectFeatureStates } = await import("@/server/projectFeatures");
const { PERSONAL_CHAT_SQL } = await import("@/server/chatInbox");
const { isPersonalChatId } = await import("@/lib/chatConversationType");
const exportRoute = await import("@/app/p/[project]/api/team-report/export/route");
const tableExportRoute = await import("@/app/p/[project]/api/team-report/table-export/route");

interface Proj {
  id: string;
  slug: string;
  name: string;
  status: "ACTIVE";
}
const projects: { isp: Proj; other: Proj } = { isp: { id: "", slug: "", name: "", status: "ACTIVE" }, other: { id: "", slug: "", name: "", status: "ACTIVE" } };
const users = { full: null as unknown as Session, limited: null as unknown as Session, linked: "", unlinked: "" };
const moduleIds: string[] = [];
const userIds: string[] = [];
const inIsp = <T,>(fn: () => Promise<T>) => runWithProject(projects.isp, fn);
const inOther = <T,>(fn: () => Promise<T>) => runWithProject(projects.other, fn);

let seq = 0;
async function msg(project: Proj, o: { account: string; chat: string; group?: string | null; at: Date; sender?: string; jid?: string | null; out?: boolean; key?: string; name?: string; body?: string }) {
  seq += 1;
  const key = o.key ?? `M${seq}`;
  const wamid = `${o.out ? "true" : "false"}_${o.chat}_${key}_${tag}`;
  await rawPrisma.message.create({
    data: {
      projectId: project.id,
      accountId: o.account,
      groupId: o.group ?? null,
      chatId: o.chat,
      whatsappMessageId: wamid,
      senderPhone: o.sender ?? o.chat.split("@")[0]!,
      senderJid: o.jid === undefined ? o.chat : o.jid,
      senderName: o.name ?? null,
      direction: o.out ? "OUTGOING" : "INCOMING",
      body: o.body ?? SECRET,
      normalizedBody: o.body ?? SECRET,
      timestampWa: o.at,
      processingStatus: "PROCESSED",
    },
  });
  return wamid;
}

async function reply(project: Proj, account: string, chat: string, at: Date, kind: "AUTO_REPLY" | "MANUAL_REPLY", createdById: string | null) {
  seq += 1;
  const wamid = await msg(project, { account, chat, at, out: true, key: `R${seq}`, sender: PHONE.ourA, jid: `${PHONE.ourA}@c.us` });
  await rawPrisma.outboundMessage.create({
    data: {
      projectId: project.id,
      accountId: account,
      chatId: chat,
      toPhone: chat,
      body: SECRET,
      actionType: kind,
      idempotencyKey: `pr-${tag}-${seq}`,
      status: "SENT",
      sentAt: at,
      scheduledAt: at,
      providerMessageId: wamid,
      createdById,
    },
  });
}

async function seedPermissionUser(name: string, keys: string[]): Promise<Session> {
  const permissions = await Promise.all(
    keys.map((key) => rawPrisma.permission.upsert({ where: { key }, create: { key, label: key, category: "Test" }, update: {}, select: { id: true } })),
  );
  const role = await rawPrisma.permissionModule.create({ data: { name: `${name} ${tag}`, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } } });
  moduleIds.push(role.id);
  const u = await rawPrisma.user.create({ data: { username: `${name}_${tag}`, email: `${name}_${tag}@example.test`, name, passwordHash: "x", permissionModuleId: role.id } });
  userIds.push(u.id);
  await rawPrisma.projectAccess.create({ data: { projectId: projects.isp.id, userId: u.id } });
  return { userId: u.id, username: u.username, email: u.email!, name } as Session;
}

beforeAll(async () => {
  users.full = await (async () => {
    // Projects first: the permission users need an ISP project to enter.
    const creator = await rawPrisma.user.create({ data: { username: `pr_${tag}`, email: `pr_${tag}@example.test`, name: "PR", passwordHash: "x" } });
    userIds.push(creator.id);
    for (const key of ["isp", "other"] as const) {
      const created = await createProjectWithDefaults({ name: `PR ${key} ${tag}`, slug: `pr-${key}-${tag}`, status: "ACTIVE", creatorUserId: creator.id }, rawPrisma);
      projects[key] = { id: created.id, slug: created.slug, name: `PR ${key} ${tag}`, status: "ACTIVE" };
    }
    return seedPermissionUser("full", ["support_activity.view", "messages.view"]);
  })();
  users.limited = await seedPermissionUser("limited", ["support_activity.view"]);
  current = users.full;

  // The team: a plain member (their own phone writing to the business is an internal chat) and one linked to a login.
  const linkedUser = await rawPrisma.user.create({ data: { username: `link_${tag}`, email: `link_${tag}@example.test`, name: "Dash", passwordHash: "x" } });
  const unlinkedUser = await rawPrisma.user.create({ data: { username: `unlink_${tag}`, email: `unlink_${tag}@example.test`, name: "Nobody", passwordHash: "x" } });
  users.linked = linkedUser.id;
  users.unlinked = unlinkedUser.id;
  userIds.push(linkedUser.id, unlinkedUser.id);

  for (const key of ["isp", "other"] as const) {
    const project = projects[key];
    const pid = { projectId: project.id };
    const A = id(`${key}-A`);
    await rawPrisma.whatsAppAccount.create({ data: { ...pid, id: A, label: `${key} A`, status: "CONNECTED", isPrimary: true, phoneNumber: key === "isp" ? PHONE.ourA : "8801500000009" } });
    await rawPrisma.whatsAppAccount.create({ data: { ...pid, id: id(`${key}-B`), label: `${key} B`, status: "CONNECTED" } });
    await rawPrisma.whatsAppGroup.create({
      data: { ...pid, id: id(`${key}-g0`), accountId: A, whatsappGroupId: G0, name: `${key} group`, isMonitored: true, isActive: true, lastSyncedAt: new Date(Date.UTC(2025, 6, 1)) },
    });
  }
  const pid = { projectId: projects.isp.id };
  await rawPrisma.internalTeamMember.create({ data: { ...pid, id: id("rakib"), name: "Rakib", phoneNumber: `+${PHONE.rakib}`, role: "Support" } });
  await rawPrisma.internalTeamMember.create({ data: { ...pid, id: id("dash"), name: "Dash Member", phoneNumber: `+${PHONE.dash}`, role: "Support", userId: linkedUser.id } });

  const A = id("isp-A");
  const B = id("isp-B");
  // C1 on account A: a run of two customer lines, a linked dashboard reply, the AI, an unanswered line.
  await msg(projects.isp, { account: A, chat: CHAT.c1, at: t(8, 9, 0), name: "Customer One" });
  await msg(projects.isp, { account: A, chat: CHAT.c1, at: t(8, 9, 1), name: "Customer One" });
  await reply(projects.isp, A, CHAT.c1, t(8, 9, 20), "MANUAL_REPLY", linkedUser.id);
  await msg(projects.isp, { account: A, chat: CHAT.c1, at: t(8, 11, 0), name: "Customer One" });
  await reply(projects.isp, A, CHAT.c1, t(8, 11, 2), "AUTO_REPLY", null);
  await msg(projects.isp, { account: A, chat: CHAT.c1, at: t(8, 13, 0), name: "Customer One" });
  // The same customer on the second account: a conversation of its own.
  await msg(projects.isp, { account: B, chat: CHAT.c1, at: t(8, 9, 30) });
  // C2 (a hidden-number chat): an earlier business message the day before, a customer line, an unlinked login's reply.
  await msg(projects.isp, { account: A, chat: CHAT.c2, at: t(7, 12, 0), out: true, key: "E1", sender: PHONE.ourA, jid: `${PHONE.ourA}@c.us` });
  await msg(projects.isp, { account: A, chat: CHAT.c2, at: t(8, 10, 0), jid: CHAT.c2 });
  await reply(projects.isp, A, CHAT.c2, t(8, 10, 10), "MANUAL_REPLY", unlinkedUser.id);
  // Left out: a colleague writing to the business number, and a chat between our own numbers.
  await msg(projects.isp, { account: A, chat: CHAT.internal, at: t(8, 10, 30), sender: PHONE.rakib });
  await msg(projects.isp, { account: B, chat: CHAT.own, at: t(8, 10, 40), sender: PHONE.ourA });
  // Neither scope's rows: status, a newsletter, a group whose record is gone.
  await msg(projects.isp, { account: A, chat: CHAT.status, at: t(8, 9, 0), jid: null });
  await msg(projects.isp, { account: A, chat: CHAT.newsletter, at: t(8, 9, 1), jid: null });
  await msg(projects.isp, { account: A, chat: CHAT.orphan, at: t(8, 9, 2), jid: null });
  // One group conversation: a customer line and a team member's answer.
  await msg(projects.isp, { account: A, chat: G0, group: id("isp-g0"), at: t(8, 9, 0), sender: "100000000001", jid: "100000000001@lid" });
  await msg(projects.isp, { account: A, chat: G0, group: id("isp-g0"), at: t(8, 9, 10), sender: PHONE.rakib, jid: `${PHONE.rakib}@c.us` });
  // The other project: the same window, its own personal chat, loud.
  for (let i = 0; i < 4; i++) await msg(projects.other, { account: id("other-A"), chat: CHAT.other, at: t(8, 9, i), name: "Other Customer" });
  await msg(projects.other, { account: id("other-A"), chat: CHAT.c1, at: t(8, 9, 10) });
}, 180_000);

afterAll(async () => {
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((r) => r.table_name);
  for (const project of [projects.isp, projects.other]) {
    for (let pass = 0; pass < 6; pass++) {
      for (const name of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${name}" WHERE "projectId" = $1`, project.id).catch(() => undefined);
    }
    await rawPrisma.projectAccess.deleteMany({ where: { projectId: project.id } });
    await rawPrisma.project.deleteMany({ where: { id: project.id } });
  }
  await rawPrisma.user.deleteMany({ where: { id: { in: userIds } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: { in: moduleIds } } });
  await rawPrisma.$disconnect();
});

const filtersFor = (extra: Record<string, string> = {}) => parseTeamReportFilters({ period: "day", date: "2025-07-08", scope: "personal", ...extra }, NOW);
const personal = (extra: Record<string, string> = {}) => inIsp(() => loadPersonalReport(filtersFor(extra), NOW));
const keysOf = (data: Awaited<ReturnType<typeof personal>>) => data.result.conversations.map((c) => c.conversationKey).sort();
const setFlag = async (enabled: boolean) => {
  await rawPrisma.projectFeature.upsert({
    where: { projectId_key: { projectId: projects.isp.id, key: "UNIFIED_REPORTING" } },
    create: { projectId: projects.isp.id, key: "UNIFIED_REPORTING", enabled },
    update: { enabled },
  });
  forgetProjectFeatureStates();
};

describe("personal report loader", () => {
  it("reads only @c.us/@lid with groupId NULL", async () => {
    const data = await personal();
    expect(keysOf(data)).toEqual(
      [`${id("isp-A")}|${CHAT.c1}`, `${id("isp-A")}|${CHAT.c2}`, `${id("isp-B")}|${CHAT.c1}`].sort(),
    );
    // status@broadcast, a newsletter and an orphaned @g.us are neither scope: named, never counted.
    expect(data.dataQuality.excludedNonConversation).toBe(3);
    for (const row of data.result.conversations) expect(row.chatId.endsWith("@g.us")).toBe(false);
  });

  it("matches PERSONAL_CHAT_SQL and isPersonalChatId on the same fixture", async () => {
    const rows = await rawPrisma.$queryRaw<Array<{ chatId: string; personal: boolean }>>`
      SELECT DISTINCT m."chatId", (${PERSONAL_CHAT_SQL}) AS personal FROM "Message" m
      WHERE m."projectId" = ${projects.isp.id} AND m."groupId" IS NULL`;
    for (const row of rows) expect(row.personal, row.chatId).toBe(isPersonalChatId(row.chatId));
    expect(rows.some((r) => r.personal)).toBe(true);
    expect(rows.some((r) => !r.personal)).toBe(true);
  });

  it("counts the period: a run of lines is one wait, replies are split by who sent them", async () => {
    const { result } = await personal();
    const s = result.summary;
    expect(s).toMatchObject({
      conversations: 3,
      customerConversations: 3,
      customerMessages: 6,
      businessReplies: 3,
      verifiedEmployeeReplies: 1,
      unlinkedOperatorReplies: 1,
      automatedReplies: { ai: 1, rule: 0 },
      waits: 5,
      missed: 2,
      unrecovered: 2,
      recalled: 0,
      waitingConversations: 2,
      newConversations: 2,
      excluded: { ownNumber: 1, internal: 1 },
    });
  });

  it("linked-login manual reply is a verified employee reply; unlinked is not", async () => {
    const { result, memberNames } = await personal();
    expect(result.summary.verifiedEmployeeReplies).toBe(1);
    expect(result.members.map((m) => [memberNames.get(m.memberId), m.verifiedReplies])).toEqual([["Dash Member", 1]]);
    const c2 = result.conversations.find((c) => c.chatId === CHAT.c2)!;
    expect(c2.verifiedEmployeeReplies).toBe(0);
    expect(c2.businessReplies).toBe(1);
    expect(result.summary.unlinkedOperatorReplies).toBe(1);
  });

  it("AI reply in a personal chat is automated (outboundByKeyJoin on chatId)", async () => {
    const { result } = await personal();
    const c1 = result.conversations.find((c) => c.accountId === id("isp-A") && c.chatId === CHAT.c1)!;
    expect(c1.automatedReplies).toBe(1);
    expect(result.response.firstReplyBy.AUTOMATED_AI).toBe(1);
    expect(result.waits.find((w) => w.repliedByActor === "AI")).toBeTruthy();
  });

  it("same customer on two accounts is two conversations; context makes an older chat not new", async () => {
    const data = await personal();
    expect(data.result.conversations.filter((c) => c.chatId === CHAT.c1)).toHaveLength(2);
    const c2 = data.result.conversations.find((c) => c.chatId === CHAT.c2)!;
    expect(c2.isNew).toBe(false);
    expect(data.result.conversations.find((c) => c.accountId === id("isp-B"))!.isNew).toBe(true);
  });

  it("the account filter and a member scope narrow the conversations", async () => {
    expect(keysOf(await personal({ account: id("isp-B") }))).toEqual([`${id("isp-B")}|${CHAT.c1}`]);
    const answered = await personal({ member: id("dash") });
    expect(keysOf(answered)).toEqual([`${id("isp-A")}|${CHAT.c1}`]);
    expect(answered.result.summary.verifiedEmployeeReplies).toBe(1);
  });

  it("the group filter does not apply, and says so", async () => {
    const data = await personal({ groups: G0 });
    expect(data.filterNote).toBe("The group filter does not apply to personal chats.");
    expect(keysOf(data)).toHaveLength(3);
  });

  it("the personal scope never counts a group message", async () => {
    const before = await personal();
    const A = id("isp-A");
    for (let i = 0; i < 20; i++) {
      await msg(projects.isp, { account: A, chat: G0, group: id("isp-g0"), at: t(8, 15, i), sender: `10000000009${i}`, jid: `10000000009${i}@lid` });
    }
    const after = await personal();
    expect(after.result.summary).toEqual(before.result.summary);
    expect(keysOf(after)).toEqual(keysOf(before));
    expect(after.reliabilityCounts.storedCopies).toBe(before.reliabilityCounts.storedCopies);
    expect(after.messages.some((m) => m.chatId === G0)).toBe(false);
  });

  it("a group report is unchanged by personal traffic", async () => {
    const group = () => inIsp(() => loadTeamReport(parseTeamReportFilters({ period: "day", date: "2025-07-08" }, NOW), NOW));
    const before = await group();
    const A = id("isp-A");
    for (let i = 0; i < 30; i++) await msg(projects.isp, { account: A, chat: CHAT.c1, at: t(8, 16, i), key: `PX${i}` });
    try {
      const after = await group();
      expect(after.result).toEqual(before.result);
      expect(after.reliabilityCounts).toEqual(before.reliabilityCounts);
      expect(after.response).toEqual(before.response);
      // ...and the personal report did move: the proof the rows were read at all.
      expect((await personal()).result.summary.customerMessages).toBe(36);
    } finally {
      await rawPrisma.message.deleteMany({ where: { projectId: projects.isp.id, whatsappMessageId: { contains: "_PX" } } });
    }
  });

  it("another project's personal chat never appears", async () => {
    const isp = await personal();
    expect(isp.result.conversations.some((c) => c.chatId === CHAT.other)).toBe(false);
    expect(JSON.stringify([...isp.conversationNames.entries()])).not.toContain("Other Customer");
    const other = await inOther(() => loadPersonalReport(filtersFor(), NOW));
    expect(other.result.conversations.map((c) => c.chatId).sort()).toEqual([CHAT.c1, CHAT.other].sort());
    expect(other.result.summary.customerMessages).toBe(5);
    // The same chat id in both projects is two conversations, each with its own figures.
    expect(other.result.conversations.find((c) => c.chatId === CHAT.c1)!.customerMessages).toBe(1);
    expect(other.dataQuality.storedCopies).toBe(5);
    expect(isp.dataQuality.storedCopies).not.toBe(5);
  });

  it("never carries a message text", async () => {
    const data = await personal();
    expect(JSON.stringify(data, (_k, v) => (v instanceof Map ? [...v.entries()] : v))).not.toContain(SECRET);
  });
});

describe("combined report", () => {
  it("group figures equal the group-only report (no cross-contamination)", async () => {
    const filters = parseTeamReportFilters({ period: "day", date: "2025-07-08", scope: "combined" }, NOW);
    const groupOnly = await inIsp(() => loadTeamReport(parseTeamReportFilters({ period: "day", date: "2025-07-08" }, NOW), NOW));
    const combined = await inIsp(() => loadCombinedReport(filters, NOW));
    expect(combined.group.result).toEqual(groupOnly.result);
    expect(combined.group.response).toEqual(groupOnly.response);
    const line = (label: string) => combined.lines.find((l) => l.label === label)!;
    const customer = line("Customer messages");
    expect(customer.group).toBe(groupOnly.result.summary.customerMessages);
    expect(customer.personal).toBe(combined.personal.result.summary.customerMessages);
    expect(customer.combined).toBe((customer.group as number) + (customer.personal as number));
    expect(line("Median first observed response").additivity).toBe("RECOMPUTED");
    expect(line("Support Overtime").personal).toBeNull();
  });
});

describe("the scope gate and the exports", () => {
  const url = (scope: string, format: "csv" | "xlsx") =>
    `http://localhost/p/${projects.isp.slug}/api/team-report/export?period=day&date=2025-07-08&scope=${scope}&format=${format}`;
  const get = (scope: string, format: "csv" | "xlsx") => inIsp(() => exportRoute.GET(new NextRequest(url(scope, format))));
  const sheets = async (scope: string) => {
    const res = await get(scope, "xlsx");
    const book = XLSX.read(Buffer.from(await res.arrayBuffer()), { type: "buffer" });
    return { names: book.SheetNames, book, disposition: res.headers.get("Content-Disposition") ?? "" };
  };
  // Bytes, not Response.text(): text() drops the UTF-8 byte-order mark the files must carry.
  const csvText = async (scope: string) => Buffer.from(await (await get(scope, "csv")).arrayBuffer()).toString("utf8");
  const cells = (book: XLSX.WorkBook, name: string) => XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[name]!, { header: 1, defval: "" });

  it("flag off: scope=personal resolves to group silently and the export is the group one", async () => {
    await setFlag(false);
    current = users.full;
    const resolved = await inIsp(() => resolvePageScope({ scope: "personal" }, current));
    expect(resolved).toMatchObject({ scope: "group", note: null, enabled: false });
    const csv = await csvText("personal");
    expect(csv.split("\r\n")[0]).toBe("﻿Group,Group ID,Assigned now,Team members,Messages,Customer messages,Team member replies,Business number replies,Customer waits,Missed,Recall,Never answered,First support,Last support,Support time (hours)");
  });

  it("scope=personal without messages.view renders group with the note (page and export)", async () => {
    await setFlag(true);
    current = users.limited;
    const resolved = await inIsp(() => resolvePageScope({ scope: "personal" }, current));
    expect(resolved).toMatchObject({ scope: "group", note: "Personal chat reporting needs the View Messages permission.", enabled: true, canViewPersonal: false });
    expect((await inIsp(() => resolvePageScope({ scope: "combined" }, current))).scope).toBe("group");
    // The export falls back exactly as the page does: the group CSV and the group workbook, no personal sheet, no conversation.
    const csv = await csvText("personal");
    expect(csv.startsWith("﻿Group,Group ID")).toBe(true);
    const book = await sheets("personal");
    expect(book.names[0]).toBe("Summary");
    expect(book.names.some((n) => n.startsWith("Personal"))).toBe(false);
    const combinedCsv = await csvText("combined");
    expect(combinedCsv.startsWith("﻿Group,Group ID")).toBe(true);
    // A personal table is refused out loud, never answered with a group table.
    const res = await inIsp(() =>
      tableExportRoute.POST(
        new NextRequest(`http://localhost/p/${projects.isp.slug}/api/team-report/table-export?period=day&date=2025-07-08&scope=personal`, {
          method: "POST",
          body: JSON.stringify({ table: "personal-conversations", format: "csv", keys: [`${id("isp-A")}|${CHAT.c1}`] }),
        }),
      ),
    );
    expect(res.status).toBe(403);
  });

  it("export scope=personal CSV columns and BOM", async () => {
    await setFlag(true);
    current = users.full;
    const res = await get("personal", "csv");
    const csv = Buffer.from(await res.arrayBuffer()).toString("utf8");
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const [header, ...rows] = csv.slice(1).split("\r\n");
    expect(header).toBe(
      "Conversation,Account,Chat type,Customer msgs,Business replies,Verified employee replies,Automated replies,Waits,Missed,Recall,Never answered,Median first response,Waiting now,First message,Last message",
    );
    expect(rows).toHaveLength(3);
    expect(rows.some((r) => r.startsWith("Customer One,isp A,Phone,4,2,1,1,3,1,0,1,"))).toBe(true);
    expect(rows.some((r) => r.includes("Hidden number ···0302,isp A,Hidden number"))).toBe(true);
    expect(res.headers.get("Content-Disposition")).toContain("personal");
    // Never a message text, and never a raw LID shown as if it were a phone number.
    expect(csv).not.toContain(SECRET);
    expect(csv).not.toContain("+100000000302");
  });

  it("xlsx starts with Personal summary, carries no group sheet and no text", async () => {
    current = users.full;
    const { names, book, disposition } = await sheets("personal");
    expect(names).toEqual(["Personal summary", "Personal conversations", "Personal by day", "Personal members", "Data quality", "Run information"]);
    expect(disposition).toContain("personal");
    const summary = cells(book, "Personal summary");
    const value = (metric: string) => summary.find((r) => r[0] === metric)?.[1];
    expect(value("Customer messages")).toBe(6);
    expect(value("Verified employee replies")).toBe(1);
    const text = JSON.stringify(names.map((n) => cells(book, n)));
    expect(text).not.toContain(SECRET);
    const run = cells(book, "Run information");
    expect(run.find((r) => r[0] === "Calculation version")?.[1]).toBe("personal-1");
    expect(run.find((r) => r[0] === "Scope")?.[1]).toBe("Personal chats");
  });

  it("combined export: the group workbook untouched, then the personal sheets and the Combined sheet", async () => {
    current = users.full;
    const group = await sheets("group");
    const combined = await sheets("combined");
    expect(combined.names.slice(0, group.names.length)).toEqual(group.names);
    expect(combined.names.slice(group.names.length)).toEqual(["Personal summary", "Personal conversations", "Personal by day", "Personal members", "Personal data quality", "Combined"]);
    for (const name of group.names.filter((n) => n !== "Run information" && n !== "Summary")) expect(cells(combined.book, name)).toEqual(cells(group.book, name));
    const rows = cells(combined.book, "Combined");
    expect(rows[0]).toEqual(["Figure", "Groups", "Personal", "Combined", "How combined", "Note"]);
    expect(rows.find((r) => r[0] === "Median first observed response")?.[4]).toBe("Recalculated over both, not averaged");
    const csv = await csvText("combined");
    expect(csv.startsWith("﻿Figure,Groups,Personal,Combined,How combined,Note")).toBe(true);
    expect(csv).not.toContain(SECRET);
  });

  it("the table export serves a personal table to a permitted viewer", async () => {
    current = users.full;
    const key = `${id("isp-A")}|${CHAT.c1}`;
    const res = await inIsp(() =>
      tableExportRoute.POST(
        new NextRequest(`http://localhost/p/${projects.isp.slug}/api/team-report/table-export?period=day&date=2025-07-08&scope=personal`, {
          method: "POST",
          body: JSON.stringify({ table: "personal-conversations", format: "csv", keys: [key] }),
        }),
      ),
    );
    expect(res.status).toBe(200);
    const csv = await res.text();
    expect(csv).toContain("Customer One");
    expect(csv).not.toContain(SECRET);
  });
});
