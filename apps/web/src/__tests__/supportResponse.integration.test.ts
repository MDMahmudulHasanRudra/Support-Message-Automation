import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import * as XLSX from "xlsx";
import { NextRequest } from "next/server";
import { createProjectWithDefaults, ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Messages → Unanswered Groups / Response Time — the dashboard side (SUPPORT_RESPONSE.md): the lists,
 * filters, sorting and paging read from episodes; Clear changes only the episode; select-all and
 * both exports reach exactly what the filters match, in this project only, behind the same keys.
 * (The worker that writes the episodes is tested in apps/worker supportResponse.integration.test.ts.)
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
const reads = await import("@/server/supportResponse");
const actions = await import("@/server/actions/supportResponse");
const { POST } = await import("@/app/p/[project]/api/messages/support-response/export/route");

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const ISP = { id: ORIGINAL_PROJECT_ID, slug: "isp-digital", name: "ISP Digital", status: "ACTIVE" as const };
const inIsp = <T,>(fn: () => Promise<T>) => runWithProject(ISP, fn);
const ids = { users: [] as string[], roles: [] as string[], accounts: [] as string[], biz: "", teams: [] as string[], members: [] as string[] };
const sessions = {} as Record<"viewer" | "replier" | "noview" | "supportAdmin", Session>;
const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000);
const fx = {} as {
  accountA: string;
  accountB: string;
  groupA: string; // "Famous Online" on A
  groupB: string; // "Famous Online" on B — same name, different identity
  groupC: string; // "ABC ISP" on A
  inactive: string; // a group account A has left
  rudra: string;
  hasan: string;
  support: string;
  bizEpisode: string;
};

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
  ids.users.push(u.id);
  return { userId: u.id, username: u.username, email: u.email!, name } as Session;
}

/** A message in a group, for an episode to point at. */
async function message(projectId: string, accountId: string, groupId: string, at: Date, body: string, sender = "Hasib") {
  const g = await rawPrisma.whatsAppGroup.findUniqueOrThrow({ where: { id: groupId } });
  return rawPrisma.message.create({
    data: { projectId, accountId, groupId, whatsappMessageId: randomUUID(), chatId: g.whatsappGroupId, senderPhone: "8801912340000", senderName: sender, direction: "INCOMING", body, normalizedBody: body, timestampWa: at, processingStatus: "PROCESSED" },
  });
}

async function unanswered(groupId: string, accountId: string, firstMinAgo: number, latestMinAgo: number, count: number, body = "Change kora jabe?", sender = "Hasib") {
  const first = await message(ORIGINAL_PROJECT_ID, accountId, groupId, ago(firstMinAgo), "first");
  const latest = await message(ORIGINAL_PROJECT_ID, accountId, groupId, ago(latestMinAgo), body, sender);
  return rawPrisma.supportResponseEpisode.create({
    data: {
      projectId: ORIGINAL_PROJECT_ID,
      accountId,
      groupId,
      firstIncomingMessageId: first.id,
      firstIncomingAt: ago(firstMinAgo),
      latestIncomingMessageId: latest.id,
      latestIncomingAt: ago(latestMinAgo),
      incomingMessageCount: count,
    },
  });
}

async function answered(groupId: string, accountId: string, firstMinAgo: number, responseMin: number, memberId: string) {
  const first = await message(ORIGINAL_PROJECT_ID, accountId, groupId, ago(firstMinAgo), "please check");
  const reply = await message(ORIGINAL_PROJECT_ID, accountId, groupId, ago(firstMinAgo - responseMin), "on it", "Support");
  return rawPrisma.supportResponseEpisode.create({
    data: {
      projectId: ORIGINAL_PROJECT_ID,
      accountId,
      groupId,
      status: "ANSWERED",
      firstIncomingMessageId: first.id,
      firstIncomingAt: ago(firstMinAgo),
      latestIncomingMessageId: first.id,
      latestIncomingAt: ago(firstMinAgo),
      incomingMessageCount: 1,
      supportReplyMessageId: reply.id,
      supportRepliedAt: ago(firstMinAgo - responseMin),
      supportMemberId: memberId,
      supportTeamId: fx.support,
      responseSeconds: responseMin * 60,
    },
  });
}

async function exportFile(body: Record<string, unknown>) {
  const res = await inIsp(() => POST(new NextRequest("http://localhost/p/isp-digital/api/messages/support-response/export", { method: "POST", body: JSON.stringify(body) })));
  return res;
}
async function sheetRows(res: Response) {
  const book = XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: "array", cellNF: true });
  const sheet = book.Sheets[book.SheetNames[0]!]!;
  return { rows: XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { raw: true }), sheet };
}

beforeAll(async () => {
  sessions.viewer = await user("sr_viewer", await role("SR viewer", ["messages.view"]));
  sessions.replier = await user("sr_replier", await role("SR replier", ["messages.view", "messages.reply"]));
  sessions.noview = await user("sr_noview", await role("SR noview", ["settings.view"]));
  sessions.supportAdmin = await user("sr_admin", await role("SR admin", ["support_activity.view", "support_activity.manage", "messages.view"]));

  const pid = { projectId: ORIGINAL_PROJECT_ID };
  fx.accountA = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `Primary ${tag}`, status: "CONNECTED" } })).id;
  fx.accountB = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `Secondary ${tag}`, status: "CONNECTED" } })).id;
  ids.accounts.push(fx.accountA, fx.accountB);
  const wa = `1203631${Date.now()}@g.us`;
  fx.groupA = (await rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId: fx.accountA, whatsappGroupId: wa, name: `Famous Online ${tag}`, isActive: true } })).id;
  fx.groupB = (await rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId: fx.accountB, whatsappGroupId: wa, name: `Famous Online ${tag}`, isActive: true } })).id;
  fx.groupC = (await rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId: fx.accountA, whatsappGroupId: `abc-${tag}@g.us`, name: `ABC ISP ${tag}`, isActive: true } })).id;
  fx.inactive = (await rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId: fx.accountA, whatsappGroupId: `left-${tag}@g.us`, name: `Left group ${tag}`, isActive: false } })).id;
  fx.support = (await rawPrisma.team.create({ data: { ...pid, name: `Support ${tag}` } })).id;
  ids.teams.push(fx.support);
  fx.rudra = (await rawPrisma.internalTeamMember.create({ data: { ...pid, name: `Rudra ${tag}`, phoneNumber: `88017${Date.now() % 1e8}`, role: "Support", teamId: fx.support } })).id;
  fx.hasan = (await rawPrisma.internalTeamMember.create({ data: { ...pid, name: `Hasan ${tag}`, phoneNumber: `88018${Date.now() % 1e8}`, role: "Support", teamId: fx.support } })).id;
  ids.members.push(fx.rudra, fx.hasan);

  const biz = await createProjectWithDefaults({ name: `SR Biz ${tag}`, slug: `sr-biz-${tag}`, status: "ACTIVE", creatorUserId: ids.users[0]! }, rawPrisma);
  ids.biz = biz.id;
  const bizAccount = await rawPrisma.whatsAppAccount.create({ data: { projectId: biz.id, label: `Biz ${tag}`, status: "CONNECTED" } });
  const bizGroup = await rawPrisma.whatsAppGroup.create({ data: { projectId: biz.id, accountId: bizAccount.id, whatsappGroupId: wa, name: `Famous Online ${tag}`, isActive: true } });
  const bizMsg = await message(biz.id, bizAccount.id, bizGroup.id, ago(500), "biz secret");
  fx.bizEpisode = (
    await rawPrisma.supportResponseEpisode.create({
      data: { projectId: biz.id, accountId: bizAccount.id, groupId: bizGroup.id, firstIncomingMessageId: bizMsg.id, firstIncomingAt: ago(500), latestIncomingMessageId: bizMsg.id, latestIncomingAt: ago(500) },
    })
  ).id;
});

beforeEach(() => {
  current = sessions.viewer;
});

afterAll(async () => {
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: { in: ids.accounts } } });
  await rawPrisma.internalTeamMember.deleteMany({ where: { id: { in: ids.members } } });
  await rawPrisma.team.deleteMany({ where: { id: { in: ids.teams } } });
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((row) => row.table_name);
  for (let pass = 0; pass < 4; pass++) {
    for (const t of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "projectId" = $1`, ids.biz).catch(() => undefined);
  }
  await rawPrisma.project.deleteMany({ where: { id: ids.biz } });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: ids.users } } });
  await rawPrisma.systemLog.deleteMany({ where: { actorUserId: { in: ids.users } } });
  await rawPrisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: { in: ids.roles } } });
  await rawPrisma.$disconnect();
});

const q = (extra: Record<string, string> = {}) => ({ group: tag, ...extra });

describe("Unanswered Groups", () => {
  it("lists one row per open episode, longest waiting first, never a group the account has left", async () => {
    const old = await unanswered(fx.groupA, fx.accountA, 120, 100, 4);
    const mid = await unanswered(fx.groupC, fx.accountA, 30, 5, 2);
    const other = await unanswered(fx.groupB, fx.accountB, 60, 60, 1);
    await unanswered(fx.inactive, fx.accountA, 300, 300, 1);
    const { rows, total } = await inIsp(() => reads.listUnanswered(reads.parseUnansweredFilters(q()), 1, 50, new Date()));
    expect(total).toBe(3);
    expect(rows.map((r) => r.id)).toEqual([old.id, other.id, mid.id]);
    expect(rows[0]).toMatchObject({ groupName: `Famous Online ${tag}`, accountLabel: `Primary ${tag}`, messageCount: 4, latestMessage: "Change kora jabe?", latestSender: "Hasib" });
  });

  it("the same group name on two accounts stays two rows; filters narrow by account, group, sender, waiting, count and date", async () => {
    const f = (extra: Record<string, string>) => inIsp(() => reads.listUnanswered(reads.parseUnansweredFilters(q(extra)), 1, 50, new Date()));
    expect((await f({ accountId: fx.accountB })).rows.map((r) => r.accountLabel)).toEqual([`Secondary ${tag}`]);
    expect((await f({ group: `Famous Online ${tag}` })).total).toBe(2);
    expect((await f({ sender: "hasib" })).total).toBe(3);
    expect((await f({ sender: "nobody-like-this" })).total).toBe(0);
    expect((await f({ waitingMin: "60" })).total).toBe(2);
    expect((await f({ minMessages: "2" })).total).toBe(2);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka" }).format(new Date());
    expect((await f({ dateFrom: today, dateTo: today })).total).toBeGreaterThanOrEqual(1);
  });

  it("sorts by newest, by message count, by group and by account", async () => {
    const order = async (sort: string) => (await inIsp(() => reads.listUnanswered(reads.parseUnansweredFilters(q({ sort })), 1, 50, new Date()))).rows.map((r) => `${r.groupName.split(" ")[0]}/${r.accountLabel.split(" ")[0]}/${r.messageCount}`);
    expect(await order("newest")).toEqual(["ABC/Primary/2", "Famous/Secondary/1", "Famous/Primary/4"]);
    expect(await order("messages")).toEqual(["Famous/Primary/4", "ABC/Primary/2", "Famous/Secondary/1"]);
    expect((await order("group"))[0]).toMatch(/^ABC/);
    expect((await order("account")).at(-1)).toMatch(/Secondary/);
  });

  it("paging never changes the total, and the pages together are exactly the whole", async () => {
    const all = await inIsp(() => reads.listUnanswered(reads.parseUnansweredFilters(q()), 1, 50, new Date()));
    const p1 = await inIsp(() => reads.listUnanswered(reads.parseUnansweredFilters(q()), 1, 2, new Date()));
    const p2 = await inIsp(() => reads.listUnanswered(reads.parseUnansweredFilters(q()), 2, 2, new Date()));
    expect(p1.total).toBe(all.total);
    expect(p2.total).toBe(all.total);
    expect([...p1.rows, ...p2.rows].map((r) => r.id)).toEqual(all.rows.map((r) => r.id));
  });

  it("another project's waits are never listed, selected or counted here", async () => {
    const { rows } = await inIsp(() => reads.listUnanswered(reads.parseUnansweredFilters({}), 1, 1000, new Date()));
    expect(rows.some((r) => r.id === fx.bizEpisode)).toBe(false);
    const { ids: selected } = await inIsp(() => actions.selectAllMatchingEpisodeIds({ tab: "unanswered", query: {} }));
    expect(selected).not.toContain(fx.bizEpisode);
  });
});

describe("Clear", () => {
  it("needs messages.reply; a viewer is refused and nothing changes", async () => {
    const { rows } = await inIsp(() => reads.listUnanswered(reads.parseUnansweredFilters(q()), 1, 50, new Date()));
    current = sessions.viewer;
    expect((await inIsp(() => actions.clearUnansweredEpisodes({ ids: [rows[0]!.id], query: q() }))).error).toBeTruthy();
    expect((await rawPrisma.supportResponseEpisode.findUniqueOrThrow({ where: { id: rows[0]!.id } })).status).toBe("UNANSWERED");
  });

  it("clears only the chosen episode, records who, when and why, and deletes no message", async () => {
    current = sessions.replier;
    const { rows } = await inIsp(() => reads.listUnanswered(reads.parseUnansweredFilters(q()), 1, 50, new Date()));
    const target = rows.find((r) => r.accountLabel === `Secondary ${tag}`)!;
    const messagesBefore = await rawPrisma.message.count({ where: { groupId: target.groupId } });
    const result = await inIsp(() => actions.clearUnansweredEpisodes({ ids: [target.id, fx.bizEpisode], query: q(), reason: "Answered by phone" }));
    expect(result).toMatchObject({ cleared: 1, skipped: 1 });
    const row = await rawPrisma.supportResponseEpisode.findUniqueOrThrow({ where: { id: target.id } });
    expect(row).toMatchObject({ status: "CLEARED", clearedByUserId: sessions.replier.userId, clearReason: "Answered by phone" });
    expect(row.clearedAt).not.toBeNull();
    expect(await rawPrisma.message.count({ where: { groupId: target.groupId } })).toBe(messagesBefore);
    expect((await rawPrisma.supportResponseEpisode.findUniqueOrThrow({ where: { id: fx.bizEpisode } })).status).toBe("UNANSWERED");
    // Off the Unanswered list, onto the Cleared one.
    const now = await inIsp(() => reads.listUnanswered(reads.parseUnansweredFilters(q()), 1, 50, new Date()));
    expect(now.rows.some((r) => r.id === target.id)).toBe(false);
    const cleared = await inIsp(() => reads.listUnanswered(reads.parseUnansweredFilters(q({ status: "CLEARED" })), 1, 50, new Date()));
    expect(cleared.rows.map((r) => [r.id, r.clearedBy])).toEqual([[target.id, "sr_replier"]]);
  });

  it("a selection is only acted on within the page's filters", async () => {
    current = sessions.replier;
    const { rows } = await inIsp(() => reads.listUnanswered(reads.parseUnansweredFilters(q()), 1, 50, new Date()));
    const onA = rows.find((r) => r.accountLabel === `Primary ${tag}`)!;
    // The page is filtered to account B; an id from account A sent with it is not cleared.
    expect(await inIsp(() => actions.clearUnansweredEpisodes({ ids: [onA.id], query: q({ accountId: fx.accountB }) }))).toMatchObject({ cleared: 0, skipped: 1 });
    expect((await rawPrisma.supportResponseEpisode.findUniqueOrThrow({ where: { id: onA.id } })).status).toBe("UNANSWERED");
  });

  it("Clear all clears exactly what the filters match", async () => {
    current = sessions.replier;
    const extra = await unanswered(fx.groupB, fx.accountB, 10, 10, 1);
    const result = await inIsp(() => actions.clearAllUnanswered({ query: q({ accountId: fx.accountB }) }));
    expect(result.cleared).toBe(1);
    expect((await rawPrisma.supportResponseEpisode.findUniqueOrThrow({ where: { id: extra.id } })).status).toBe("CLEARED");
    expect((await inIsp(() => reads.listUnanswered(reads.parseUnansweredFilters(q()), 1, 50, new Date()))).total).toBe(2);
  });
});

describe("Response Time", () => {
  it("lists answered episodes with who replied, filters by member, team and response range, and reports average and slowest", async () => {
    await answered(fx.groupA, fx.accountA, 300, 11, fx.rudra);
    await answered(fx.groupC, fx.accountA, 200, 45, fx.hasan);
    await answered(fx.groupB, fx.accountB, 100, 5, fx.rudra);
    const list = (extra: Record<string, string> = {}) => inIsp(() => reads.listResponses(reads.parseResponseFilters(q(extra)), 1, 50));
    const all = await list();
    expect(all.total).toBe(3);
    expect(all.rows[0]).toMatchObject({ memberName: `Rudra ${tag}`, responseSeconds: 300, accountLabel: `Secondary ${tag}` }); // newest reply first
    expect(Math.round(all.averageSeconds!)).toBe(((11 + 45 + 5) * 60) / 3);
    expect(all.slowestSeconds).toBe(45 * 60);
    expect((await list({ memberId: fx.hasan })).total).toBe(1);
    expect((await list({ teamId: fx.support })).total).toBe(3);
    expect((await list({ minMinutes: "10" })).total).toBe(2);
    expect((await list({ maxMinutes: "10" })).total).toBe(1);
    expect((await list({ sort: "slowest" })).rows[0]!.responseSeconds).toBe(45 * 60);
  });
});

describe("export", () => {
  it("Export selected: exactly the chosen rows, real Excel dates, duration as text and seconds — and another project's id is ignored", async () => {
    const { rows } = await inIsp(() => reads.listResponses(reads.parseResponseFilters(q()), 1, 50));
    const res = await exportFile({ tab: "response-time", format: "xlsx", query: q(), ids: [rows[0]!.id, fx.bizEpisode] });
    expect(res.status).toBe(200);
    const { rows: data, sheet } = await sheetRows(res);
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ "Response Duration": "5m 00s", "Response (seconds)": 300, "Response (minutes)": 5, "Support Team Member": `Rudra ${tag}`, "Response Episode ID": rows[0]!.id });
    expect(typeof data[0]!["Support Reply Time"]).toBe("number");
    expect(sheet["E2"]?.z).toBe("yyyy-mm-dd hh:mm:ss");
  });

  it("an id from the other tab is never exported under this one", async () => {
    const { rows } = await inIsp(() => reads.listUnanswered(reads.parseUnansweredFilters(q()), 1, 50, new Date()));
    const res = await exportFile({ tab: "response-time", format: "xlsx", query: q(), ids: [rows[0]!.id] });
    expect((await sheetRows(res)).rows).toHaveLength(0);
  });

  it("Export all: every matching row, server-side, not just a page; Unanswered includes cleared details", async () => {
    const res = await exportFile({ tab: "unanswered", format: "xlsx", query: q({ status: "CLEARED" }), ids: null });
    const { rows } = await sheetRows(res);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r["Status"] === "Cleared" && typeof r["Cleared At"] === "number")).toBe(true);
    const open = await sheetRows(await exportFile({ tab: "unanswered", format: "xlsx", query: q(), ids: null }));
    expect(open.rows).toHaveLength(2);
    expect(open.rows[0]).toMatchObject({ "Group Name": `Famous Online ${tag}`, "Unanswered Message Count": 4, "Latest Message": "Change kora jabe?", Status: "Unanswered" });
    expect(open.rows[0]!["Waiting (seconds)"]).toBeGreaterThanOrEqual(120 * 60);
  });

  it("CSV works too, and a formula-looking cell cannot run in a spreadsheet", async () => {
    const groupD = await rawPrisma.whatsAppGroup.create({ data: { projectId: ORIGINAL_PROJECT_ID, accountId: fx.accountA, whatsappGroupId: `d-${tag}@g.us`, name: `Dhaka Net ${tag}`, isActive: true } });
    await unanswered(groupD.id, fx.accountA, 400, 399, 1, "=HYPERLINK(\"http://x\")");
    const res = await exportFile({ tab: "unanswered", format: "csv", query: q({ sort: "oldest" }), ids: null });
    const textOut = await res.text();
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    expect(textOut).toMatch(/HYPERLINK/);
    expect(textOut).not.toMatch(/,"?=HYPERLINK/);
  });

  it("export needs messages.view", async () => {
    current = sessions.noview;
    await expect(exportFile({ tab: "unanswered", format: "xlsx", query: {}, ids: null })).rejects.toThrow();
  });
});

describe("Support Team setting", () => {
  it("accepts only this project's Teams, needs support_activity.manage", async () => {
    current = sessions.viewer;
    const form = new FormData();
    form.append("teamIds", fx.support);
    expect((await inIsp(() => actions.saveSupportResponseTeams({}, form))).error).toBeTruthy();
    current = sessions.supportAdmin;
    // A fresh database may have no settings row yet; the action creates one.
    const existing = await rawPrisma.supportActivitySettings.findUnique({ where: { projectId: ORIGINAL_PROJECT_ID } });
    try {
      expect(await inIsp(() => actions.saveSupportResponseTeams({}, form))).toEqual({ saved: true });
      expect((await rawPrisma.supportActivitySettings.findUniqueOrThrow({ where: { projectId: ORIGINAL_PROJECT_ID } })).responseTrackingTeamIds).toEqual([fx.support]);
      const bizTeam = await rawPrisma.team.create({ data: { projectId: ids.biz, name: `Biz support ${tag}` } });
      const bad = new FormData();
      bad.append("teamIds", bizTeam.id);
      expect((await inIsp(() => actions.saveSupportResponseTeams({}, bad))).error).toMatch(/not in this project/);
    } finally {
      if (existing) await rawPrisma.supportActivitySettings.update({ where: { projectId: ORIGINAL_PROJECT_ID }, data: { responseTrackingTeamIds: existing.responseTrackingTeamIds } });
      else await rawPrisma.supportActivitySettings.deleteMany({ where: { projectId: ORIGINAL_PROJECT_ID } });
    }
  });
});
