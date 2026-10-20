import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import type { Session } from "@/server/auth";

/**
 * Legacy parity harness (unified reporting WP2). The group Team Report as it behaves with
 * UNIFIED_REPORTING off (the flag's default), captured once as a committed JSON snapshot: the
 * `loadTeamReport` result and summary, the three table builders, and the CSV and XLSX the export
 * route returns. Every later unified-reporting work package must leave this file green; a figure that
 * moves is a deliberate edit of the snapshot, never a side effect.
 *
 * The fixture is synthetic (fixed numbers, no real text): two accounts, two groups each stored by
 * both numbers, a personal chat, an AI reply, a dashboard reply through a linked login, a CONFLICT
 * sender, a recall, a miss and a wait that continues from before midnight (context window).
 *
 * Volatile values are made stable: every id this file creates embeds the run's tag, which is replaced
 * by "TAG"; the project id is replaced by "PROJECT"; "now" is fixed; the Summary sheet's
 * "Computed as of" row (the real clock) is dropped.
 *
 * Regenerate (only for a deliberate change):
 *   UPDATE_PARITY_SNAPSHOT=1 pnpm --filter @support-automation/web test:isolated src/__tests__/teamReportParity.integration.test.ts
 */

let current: Session;
const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const D = "2025-07-08";
const NOW = new Date(Date.UTC(2025, 6, 9, 12, 0));
/** A Dhaka wall-clock time on 7 or 8 July 2025, as an instant. */
const t = (day: 7 | 8, hh: number, mm: number) => new Date(Date.UTC(2025, 6, day, hh - 6, mm));
const SNAPSHOT_PATH = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "teamReportParity.snapshot.json");

const G0 = "120000000000000001@g.us";
const G1 = "120000000000000002@g.us";
const G2 = "120000000000000003@g.us";
const P = {
  customer: "100000000001",
  customer2: "100000000002",
  customer3: "100000000003",
  rina: "8801000000101",
  rakib: "8801000000102",
  nadia: "8801000000103",
  late: "8801000000104",
  rinaLid: "200000000101",
  personalChat: "8801000000201@c.us",
};
const id = (name: string) => `parity-${tag}-${name}`;

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
const { loadTeamReport, parseTeamReportFilters } = await import("@/server/teamReport");
const { buildMembersTable, buildBucketsTable, buildGroupsTable } = await import("@/server/teamReportTables");
const exportRoute = await import("@/app/p/[project]/api/team-report/export/route");

const ids = { user: "", project: "", slug: "" };
const project = () => ({ id: ids.project, slug: ids.slug, name: `Parity ${tag}`, status: "ACTIVE" as const });
const inProject = <T,>(fn: () => Promise<T>) => runWithProject(project(), fn);

async function message(opts: {
  account: "A" | "B";
  chat: string;
  key: string;
  sender: string;
  jid: string | null;
  at: Date;
  direction?: "INCOMING" | "OUTGOING";
  fromMe?: boolean;
  personal?: boolean;
}) {
  const group = opts.personal ? null : id(`${opts.chat === G0 ? "g0" : opts.chat === G2 ? "g2" : "g1"}-${opts.account}`);
  return rawPrisma.message.create({
    data: {
      projectId: ids.project,
      accountId: id(`acct-${opts.account}`),
      groupId: group,
      chatId: opts.chat,
      whatsappMessageId: `${opts.fromMe ? "true" : "false"}_${opts.chat}_${opts.key}_${tag}`,
      senderPhone: opts.sender,
      senderJid: opts.jid,
      direction: opts.direction ?? "INCOMING",
      body: "text",
      normalizedBody: "text",
      timestampWa: opts.at,
      processingStatus: "PROCESSED",
    },
    select: { whatsappMessageId: true },
  });
}

const customerJid = `${P.customer}@lid`;

async function outbound(chat: string, wamid: string, actionType: "AUTO_REPLY" | "MANUAL_REPLY", sentAt: Date, createdById: string | null) {
  await rawPrisma.outboundMessage.create({
    data: {
      projectId: ids.project,
      accountId: id("acct-A"),
      chatId: chat,
      toPhone: chat,
      body: "text",
      actionType,
      idempotencyKey: `parity-${tag}-${wamid}`,
      status: "SENT",
      sentAt,
      providerMessageId: wamid,
      createdById,
    },
  });
}

beforeAll(async () => {
  const u = await rawPrisma.user.create({ data: { username: `parity_${tag}`, email: `parity_${tag}@example.test`, name: "Parity", passwordHash: "x" } });
  ids.user = u.id;
  current = { userId: u.id, username: u.username, email: u.email!, name: "Parity" } as Session;
  const created = await createProjectWithDefaults({ name: `Parity ${tag}`, slug: `parity-${tag}`, status: "ACTIVE", creatorUserId: u.id }, rawPrisma);
  ids.project = created.id;
  ids.slug = created.slug;
  const pid = { projectId: created.id };

  await rawPrisma.whatsAppAccount.create({ data: { ...pid, id: id("acct-A"), label: "Parity A", status: "CONNECTED", isPrimary: true } });
  await rawPrisma.whatsAppAccount.create({ data: { ...pid, id: id("acct-B"), label: "Parity B", status: "CONNECTED" } });

  const member = (name: string, data: Record<string, unknown>) => rawPrisma.internalTeamMember.create({ data: { ...pid, id: id(name), role: "Support", ...data } as never });
  await member("rakib", { name: "Rakib", phoneNumber: `+${P.rakib}` });
  await member("rina", { name: "Rina", phoneNumber: `+${P.rina}`, whatsappId: `${P.rinaLid}@lid` });
  // Omar's number is the digits of Rina's WhatsApp id: a message from that id is a CONFLICT.
  await member("omar", { name: "Omar", phoneNumber: `+${P.rinaLid}` });
  await member("nadia", { name: "Nadia", phoneNumber: `+${P.nadia}` });
  await member("late", { name: "Late", phoneNumber: `+${P.late}`, userId: u.id });

  await rawPrisma.supportPriorityPolicy.upsert({
    where: { projectId_priority: { projectId: created.id, priority: "P1" } },
    create: { ...pid, priority: "P1", firstAlertMinutes: 10, secondAlertMinutes: 20, memberEscalationMinutes: 30, adminEscalationMinutes: 40, followUpIntervalMinutes: 60, maxEscalations: 3 },
    update: { firstAlertMinutes: 10 },
  });

  const row = (account: "A" | "B", chat: string, key: string, extra: Record<string, unknown> = {}) =>
    rawPrisma.whatsAppGroup.create({
      data: { ...pid, id: id(`${key}-${account}`), accountId: id(`acct-${account}`), whatsappGroupId: chat, name: `Parity group ${key}`, isMonitored: true, isActive: true, lastSyncedAt: new Date(Date.UTC(2025, 6, 1)), ...extra },
    });
  await row("A", G0, "g0", { assignedTeamMemberId: id("rakib"), priority: "P1" });
  await row("B", G0, "g0");
  await row("A", G1, "g1");
  await row("B", G1, "g1");
  await row("A", G2, "g2");

  // G0, stored by both numbers: asked 09:00, Rina answers at 09:20 (late against the 10-minute P1
  // rule: a recall); asked again at 11:00 and never answered (a miss).
  for (const account of ["A", "B"] as const) {
    await message({ account, chat: G0, key: "Q1", sender: P.customer, jid: customerJid, at: t(8, 9, 0) });
    await message({ account, chat: G0, key: "Q2", sender: P.customer, jid: customerJid, at: t(8, 11, 0) });
  }
  await message({ account: "A", chat: G0, key: "R1", sender: P.rina, jid: `${P.rina}@c.us`, at: t(8, 9, 20) });

  // G1: a wait begun the evening before (context window) that continues just after midnight; the AI
  // answers at 00:20; asked again at 10:00; the dashboard reply at 10:05 goes out through Late's login;
  // a CONFLICT sender (Rina's WhatsApp id, which is also Omar's number) at 10:30; asked at 12:00, Nadia answers
  // on the second number only at 12:05.
  await message({ account: "A", chat: G1, key: "C0", sender: P.customer2, jid: `${P.customer2}@lid`, at: t(7, 23, 30) });
  await message({ account: "A", chat: G1, key: "C1", sender: P.customer2, jid: `${P.customer2}@lid`, at: t(8, 0, 10) });
  const ai = await message({ account: "A", chat: G1, key: "AI", sender: "199900000001", jid: "199900000001@lid", at: t(8, 0, 20), direction: "OUTGOING", fromMe: true });
  await outbound(G1, ai.whatsappMessageId, "AUTO_REPLY", t(8, 0, 20), null);
  await message({ account: "A", chat: G1, key: "Q3", sender: P.customer2, jid: `${P.customer2}@lid`, at: t(8, 10, 0) });
  const op = await message({ account: "A", chat: G1, key: "OP", sender: "199900000001", jid: "199900000001@lid", at: t(8, 10, 5), direction: "OUTGOING", fromMe: true });
  await outbound(G1, op.whatsappMessageId, "MANUAL_REPLY", t(8, 10, 5), u.id);
  await message({ account: "A", chat: G1, key: "CF", sender: P.rinaLid, jid: `${P.rinaLid}@lid`, at: t(8, 10, 30) });
  await message({ account: "B", chat: G1, key: "Q4", sender: P.customer2, jid: `${P.customer2}@lid`, at: t(8, 12, 0) });
  await message({ account: "B", chat: G1, key: "N1", sender: P.nadia, jid: `${P.nadia}@c.us`, at: t(8, 12, 5) });

  // G2: a wait opened BEFORE the period, inside the 4-hour context window, and answered inside it.
  // The customer asks at 23:00 the evening before and the AI answers at 23:30 (both context rows); the
  // same customer writes again at 00:10 and Nadia answers at 00:30. Read with its context, the
  // 00:10 line continues the human wait opened at 23:00 (begun before the period, so not counted); with
  // no context window the AI reply is the newest earlier message, the 00:10 line opens a new human wait
  // inside the period and Nadia's answer is counted. So this fixture moves if the context window does.
  await message({ account: "A", chat: G2, key: "K1", sender: P.customer3, jid: `${P.customer3}@lid`, at: t(7, 23, 0) });
  const ctxAi = await message({ account: "A", chat: G2, key: "KAI", sender: "199900000001", jid: "199900000001@lid", at: t(7, 23, 30), direction: "OUTGOING", fromMe: true });
  await outbound(G2, ctxAi.whatsappMessageId, "AUTO_REPLY", t(7, 23, 30), null);
  await message({ account: "A", chat: G2, key: "K2", sender: P.customer3, jid: `${P.customer3}@lid`, at: t(8, 0, 10) });
  await message({ account: "A", chat: G2, key: "KN", sender: P.nadia, jid: `${P.nadia}@c.us`, at: t(8, 0, 30) });

  // One personal chat on the Primary account.
  await message({ account: "A", chat: P.personalChat, key: "PC1", sender: P.customer, jid: P.personalChat, at: t(8, 14, 0), personal: true });
  await message({ account: "A", chat: P.personalChat, key: "PC2", sender: P.rina, jid: `${P.rina}@c.us`, at: t(8, 14, 5), personal: true });
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
  await rawPrisma.$disconnect();
});

/** JSON with Maps/functions made plain, then every run-specific id replaced by a fixed token. */
function normalise(value: unknown): unknown {
  const text = JSON.stringify(value, (_key, v) => {
    if (v instanceof Map) return { __map: [...v.entries()].sort(([a], [b]) => String(a).localeCompare(String(b))) };
    if (typeof v === "function") return undefined;
    return v;
  });
  return JSON.parse((text ?? "null").split(tag).join("TAG").split(ids.project).join("PROJECT").split(ids.user).join("USER"));
}

async function capture(params: Record<string, string>) {
  const filters = parseTeamReportFilters({ period: "day", date: D, ...params }, NOW);
  const data = await inProject(() => loadTeamReport(filters, NOW));
  const at = [t(8, 9, 0).getTime(), t(8, 23, 0).getTime()];
  return normalise({
    filters: data.filters,
    range: data.range,
    result: data.result,
    summary: data.result.summary,
    memberNames: data.memberNames,
    members: data.members,
    teamName: data.teamName,
    filterNote: data.filterNote,
    groups: data.groups,
    rules: data.rules,
    response: data.response,
    reliabilityCounts: data.reliabilityCounts,
    computedAt: data.computedAt,
    responsibility: [G0, G1].map((g) => at.map((ts) => ({ g, ts, ...data.responsibilityAt(g, ts), missedAfterMs: data.missedAfterMs(g, ts) }))),
    tables: {
      members: buildMembersTable(data),
      buckets: buildBucketsTable(data),
      groups: buildGroupsTable(data),
    },
  });
}

async function exported(format: "csv" | "xlsx") {
  return inProject(() => exportRoute.GET(new NextRequest(`http://localhost/p/${ids.slug}/api/team-report/export?period=day&date=${D}&format=${format}`)));
}

async function captureCsv() {
  const res = await exported("csv");
  return normalise({ type: res.headers.get("content-type"), body: await res.text() });
}

async function captureXlsx() {
  const res = await exported("xlsx");
  const book = XLSX.read(Buffer.from(await res.arrayBuffer()), { type: "buffer" });
  const sheets: Record<string, unknown[][]> = {};
  for (const name of book.SheetNames) {
    let rows = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[name]!, { header: 1, defval: "" });
    // The real clock when the file was made: the only value that differs between two runs.
    if (name === "Summary") rows = rows.filter((r) => r[0] !== "Computed as of");
    sheets[name] = rows;
  }
  return normalise({ sheetNames: book.SheetNames, sheets });
}

type Snapshot = Record<string, unknown>;
const snapshot: Snapshot = {};
const stored: Snapshot | null = existsSync(SNAPSHOT_PATH) ? (JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as Snapshot) : null;
const updating = process.env.UPDATE_PARITY_SNAPSHOT === "1";

function check(name: string, actual: unknown) {
  snapshot[name] = actual;
  if (updating) return;
  expect(stored, "snapshot fixture missing: generate it with UPDATE_PARITY_SNAPSHOT=1").not.toBeNull();
  expect(actual).toEqual(stored![name]);
}

describe("legacy Team Report parity (flag off)", () => {
  it("flag off: loadTeamReport output identical to baseline", async () => {
    check("day", await capture({}));
    check("monthByWeek", await capture({ period: "month", by: "week" }));
    check("oneGroupOneAccount", await capture({ groups: G1, account: id("acct-A") }));
  });

  it("flag off: CSV identical", async () => {
    check("csv", await captureCsv());
  });

  it("flag off: XLSX sheets and cells identical", async () => {
    check("xlsx", await captureXlsx());
  });

  it("personal messages never change group figures", async () => {
    const before = await capture({});
    const beforeXlsx = await captureXlsx();
    await rawPrisma.message.createMany({
      data: Array.from({ length: 50 }, (_, i) => ({
        projectId: ids.project,
        accountId: id("acct-A"),
        groupId: null,
        chatId: P.personalChat,
        whatsappMessageId: `false_${P.personalChat}_bulk${i}_${tag}`,
        senderPhone: i % 2 ? P.customer : P.rina,
        senderJid: i % 2 ? P.personalChat : `${P.rina}@c.us`,
        direction: "INCOMING" as const,
        body: "text",
        normalizedBody: "text",
        timestampWa: t(8, 15, i),
        processingStatus: "PROCESSED" as const,
      })),
    });
    expect(await capture({})).toEqual(before);
    expect(await captureXlsx()).toEqual(beforeXlsx);
  });

  it("writes the snapshot when asked", () => {
    if (!updating) return;
    writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  });
});
