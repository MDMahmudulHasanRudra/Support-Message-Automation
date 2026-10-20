import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import type { Session } from "@/server/auth";

/**
 * Unified reporting WP3: the "Collection detail" counts (late-arriving, loaded from history, revoked,
 * excluded) and the pending re-attribution count. Synthetic data only: fixed fake numbers, no text.
 * Two projects fill the same window, so a count that leaks across the project boundary fails here.
 */

let current: Session;
const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const id = (name: string) => `uq-${tag}-${name}`;
const G = "120000000000000001@g.us";
const G2 = "120000000000000002@g.us";
const PERSONAL = "8801000000201@c.us";
const LID_CHAT = "100000000301@lid";
/** The window under test: 8 July 2025, Dhaka. */
const START = new Date(Date.UTC(2025, 6, 7, 18, 0));
const END = new Date(Date.UTC(2025, 6, 8, 18, 0));
const at = (hh: number, mm: number) => new Date(Date.UTC(2025, 6, 8, hh, mm));
const minutesAfter = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);

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
const { loadDataQualityCounts, loadPendingReattributions } = await import("@/server/unifiedReporting");
const { loadTeamReport, parseTeamReportFilters } = await import("@/server/teamReport");
const { forgetProjectFeatureStates } = await import("@/server/projectFeatures");
const exportRoute = await import("@/app/p/[project]/api/team-report/export/route");

interface Proj {
  id: string;
  slug: string;
  name: string;
  status: "ACTIVE";
}
const projects: { isp: Proj; other: Proj } = { isp: { id: "", slug: "", name: "", status: "ACTIVE" }, other: { id: "", slug: "", name: "", status: "ACTIVE" } };
let userId = "";
const inIsp = <T,>(fn: () => Promise<T>) => runWithProject(projects.isp, fn);
const inOther = <T,>(fn: () => Promise<T>) => runWithProject(projects.other, fn);

let seq = 0;
async function msg(project: Proj, opts: { account: string; group: string | null; chat: string; ts: Date; storedAt?: Date; direction?: "INCOMING" | "OUTGOING" | "SYSTEM"; history?: boolean; revoked?: boolean; sender?: string }) {
  seq += 1;
  await rawPrisma.message.create({
    data: {
      projectId: project.id,
      accountId: opts.account,
      groupId: opts.group,
      chatId: opts.chat,
      whatsappMessageId: `false_${opts.chat}_M${seq}_${tag}`,
      senderPhone: opts.sender ?? "100000000001",
      senderJid: `${opts.sender ?? "100000000001"}@lid`,
      direction: opts.direction ?? "INCOMING",
      body: "text",
      normalizedBody: "text",
      timestampWa: opts.ts,
      createdAt: opts.storedAt ?? opts.ts,
      processingStatus: "PROCESSED",
      ...(opts.history ? { loadedFromHistoryAt: minutesAfter(opts.ts, 600) } : {}),
      ...(opts.revoked ? { revokedAt: minutesAfter(opts.ts, 5) } : {}),
    },
  });
}

async function seedProject(project: Proj, label: string) {
  const pid = { projectId: project.id };
  await rawPrisma.whatsAppAccount.create({ data: { ...pid, id: id(`${label}-A`), label: `${label} A`, status: "CONNECTED", isPrimary: true } });
  await rawPrisma.whatsAppAccount.create({ data: { ...pid, id: id(`${label}-B`), label: `${label} B`, status: "CONNECTED" } });
  for (const [key, chat] of [["g1", G], ["g2", G2]] as const) {
    await rawPrisma.whatsAppGroup.create({
      data: { ...pid, id: id(`${label}-${key}`), accountId: id(`${label}-A`), whatsappGroupId: chat, name: `${label} ${key}`, isMonitored: true, isActive: true, lastSyncedAt: new Date(Date.UTC(2025, 6, 1)) },
    });
  }
}

beforeAll(async () => {
  const u = await rawPrisma.user.create({ data: { username: `uq_${tag}`, email: `uq_${tag}@example.test`, name: "UQ", passwordHash: "x" } });
  userId = u.id;
  current = { userId: u.id, username: u.username, email: u.email!, name: "UQ" } as Session;
  for (const key of ["isp", "other"] as const) {
    const created = await createProjectWithDefaults({ name: `UQ ${key} ${tag}`, slug: `uq-${key}-${tag}`, status: "ACTIVE", creatorUserId: u.id }, rawPrisma);
    projects[key] = { id: created.id, slug: created.slug, name: `UQ ${key} ${tag}`, status: "ACTIVE" };
    await seedProject(projects[key], key);
  }
  const A = id("isp-A");
  const gA = id("isp-g1");
  const gB = id("isp-g2");

  // Group G1 (account A). On time, 14 minutes late (not late), 16 minutes late (late), way late (late).
  await msg(projects.isp, { account: A, group: gA, chat: G, ts: at(2, 0) });
  await msg(projects.isp, { account: A, group: gA, chat: G, ts: at(2, 1), storedAt: minutesAfter(at(2, 1), 14) });
  await msg(projects.isp, { account: A, group: gA, chat: G, ts: at(2, 2), storedAt: minutesAfter(at(2, 2), 16) });
  await msg(projects.isp, { account: A, group: gA, chat: G, ts: at(2, 3), storedAt: minutesAfter(at(2, 3), 300) });
  // Loaded from history long after: counted as history, never as late.
  await msg(projects.isp, { account: A, group: gA, chat: G, ts: at(3, 0), storedAt: minutesAfter(at(3, 0), 700), history: true });
  // A system row (a join) stored on time, and a revoked message.
  await msg(projects.isp, { account: A, group: gA, chat: G, ts: at(4, 0), direction: "SYSTEM" });
  await msg(projects.isp, { account: A, group: gA, chat: G, ts: at(5, 0), revoked: true, sender: "100000000002" });
  // Group G2 on account B's stored copy: for the account / group filters.
  await msg(projects.isp, { account: id("isp-B"), group: gB, chat: G2, ts: at(6, 0), storedAt: minutesAfter(at(6, 0), 40) });
  // Outside the window: never counted.
  await msg(projects.isp, { account: A, group: gA, chat: G, ts: new Date(START.getTime() - 60_000), storedAt: minutesAfter(START, 500) });
  await msg(projects.isp, { account: A, group: gA, chat: G, ts: END, storedAt: minutesAfter(END, 500) });
  // The other project: the same window, loud, with every kind of row.
  const OA = id("other-A");
  const og = id("other-g1");
  for (let i = 0; i < 5; i++) {
    await msg(projects.other, { account: OA, group: og, chat: G, ts: at(2, 10 + i), storedAt: minutesAfter(at(2, 10 + i), 60), revoked: true });
    await msg(projects.other, { account: OA, group: og, chat: G, ts: at(3, 10 + i), history: true });
    await msg(projects.other, { account: OA, group: og, chat: G, ts: at(4, 10 + i), direction: "SYSTEM" });
    await msg(projects.other, { account: OA, group: null, chat: PERSONAL, ts: at(7, 10 + i), storedAt: minutesAfter(at(7, 10 + i), 60) });
  }

  // Personal rows of the ISP project: a chat with a phone, a chat with a LID, a system row in one, plus
  // rows that are not conversations (status, a newsletter, a group whose record is gone).
  await msg(projects.isp, { account: A, group: null, chat: PERSONAL, ts: at(8, 0) });
  await msg(projects.isp, { account: A, group: null, chat: PERSONAL, ts: at(8, 1), storedAt: minutesAfter(at(8, 1), 30) });
  await msg(projects.isp, { account: A, group: null, chat: LID_CHAT, ts: at(8, 2), history: true });
  await msg(projects.isp, { account: A, group: null, chat: PERSONAL, ts: at(8, 3), direction: "SYSTEM" });
  await msg(projects.isp, { account: A, group: null, chat: PERSONAL, ts: at(8, 4), revoked: true });
  await msg(projects.isp, { account: A, group: null, chat: "status@broadcast", ts: at(9, 0) });
  await msg(projects.isp, { account: A, group: null, chat: "120363000000000009@newsletter", ts: at(9, 1) });
  await msg(projects.isp, { account: A, group: null, chat: "120000000000000099@g.us", ts: at(9, 2) });
  await msg(projects.isp, { account: id("isp-B"), group: null, chat: PERSONAL, ts: at(9, 3), storedAt: minutesAfter(at(9, 3), 30) });

  // Re-attributions: two open, one done in ISP; open ones in the other project.
  const reattr = (project: Proj, status: string) =>
    rawPrisma.identityReattribution.create({ data: { projectId: project.id, status, reason: "test", memberIds: [], identifiers: [] } });
  await reattr(projects.isp, "PENDING");
  await reattr(projects.isp, "RUNNING");
  await reattr(projects.isp, "DONE");
  await reattr(projects.isp, "FAILED");
  for (let i = 0; i < 3; i++) await reattr(projects.other, "PENDING");
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
  await rawPrisma.user.deleteMany({ where: { id: userId } });
  await rawPrisma.$disconnect();
});

const group = (extra: { storedBy?: Date; accountId?: string | null; groupKeys?: string[] } = {}) =>
  inIsp(() => loadDataQualityCounts({ kind: "GROUP", start: START, end: END, ...extra }));
const personal = (extra: { storedBy?: Date; accountId?: string | null } = {}) =>
  inIsp(() => loadDataQualityCounts({ kind: "PERSONAL", start: START, end: END, ...extra }));

describe("unified reporting data quality (counts only)", () => {
  it("late-arriving counts createdAt > ts+15m only", async () => {
    const counts = await group();
    // 16 min and 300 min after sending are late; on time and 14 min are not; the history row never is;
    // the message on account B stored 40 min late is one more.
    expect(counts.lateArriving).toBe(3);
    // Boundary rows outside the window are not read at all.
    expect(counts.storedCopies).toBe(7);
  });

  it("history-loaded counted separately, not as late", async () => {
    const counts = await group({ groupKeys: [G] });
    expect(counts.loadedFromHistory).toBe(1);
    expect(counts.lateArriving).toBe(2);
  });

  it("SYSTEM rows counted as excluded", async () => {
    const counts = await group();
    expect(counts.excludedSystem).toBe(1);
    // A system row is not among the stored message records the reliability section counts.
    expect(counts.storedCopies).toBe(7);
  });

  it("revoked counted and still in logical messages", async () => {
    const counts = await group({ groupKeys: [G] });
    expect(counts.revoked).toBe(1);
    const report = await inIsp(() => loadTeamReport(parseTeamReportFilters({ period: "day", date: "2025-07-08", groups: G }, new Date(Date.UTC(2025, 6, 9, 12, 0))), new Date(Date.UTC(2025, 6, 9, 12, 0))));
    // 6 stored non-system rows in G1 in the window; the revoked one is among the logical messages.
    expect(report.reliabilityCounts.storedCopies).toBe(6);
    expect(report.reliabilityCounts.logicalMessages).toBe(6);
    expect(counts.storedCopies).toBe(report.reliabilityCounts.storedCopies);
  });

  it("other project's rows never counted", async () => {
    const isp = await group();
    const other = await inOther(() => loadDataQualityCounts({ kind: "GROUP", start: START, end: END }));
    expect(other).toMatchObject({ revoked: 5, loadedFromHistory: 5, excludedSystem: 5, lateArriving: 5, storedCopies: 10 });
    expect(isp.revoked).toBe(1);
    expect(isp.excludedSystem).toBe(1);
    expect(isp.loadedFromHistory).toBe(1);
    const otherPersonal = await inOther(() => loadDataQualityCounts({ kind: "PERSONAL", start: START, end: END }));
    expect(otherPersonal.storedCopies).toBe(5);
    expect(await inIsp(() => loadPendingReattributions())).toBe(2);
    expect(await inOther(() => loadPendingReattributions())).toBe(3);
  });

  it("filters: one account, one group, and an export's stored-by bound", async () => {
    expect((await group({ accountId: id("isp-B") })).storedCopies).toBe(1);
    expect((await group({ accountId: id("isp-A") })).storedCopies).toBe(6);
    expect((await group({ groupKeys: [G2] })).lateArriving).toBe(1);
    // As the page stood 15 minutes after the second message was sent: the on-time row and that one are
    // stored, the rows stored later (the late ones, the history load) are not in it.
    const early = await group({ storedBy: minutesAfter(at(2, 1), 15) });
    expect(early.lateArriving).toBe(0);
    expect(early.storedCopies).toBe(2);
  });

  it("personal scope counts personal chats, and names what is not a conversation", async () => {
    const counts = await personal();
    // PERSONAL (phone) x2 on A + one on B, the LID chat, and the revoked one; the system row is apart.
    expect(counts.storedCopies).toBe(5);
    expect(counts.excludedSystem).toBe(1);
    expect(counts.loadedFromHistory).toBe(1);
    expect(counts.revoked).toBe(1);
    // 30 minutes late: the second row on account A and the one on account B.
    expect(counts.lateArriving).toBe(2);
    // status, newsletter and an orphaned @g.us: neither scope's rows.
    expect(counts.excludedNonConversation).toBe(3);
    // Decided from classification, not SQL: the personal loader fills these.
    expect(counts.excludedOwnNumberChats).toBe(0);
    expect(counts.excludedInternalChats).toBe(0);
    expect((await personal({ accountId: id("isp-B") })).storedCopies).toBe(1);
  });

  it("group counts never read personal rows, and personal counts never read group rows", async () => {
    const g = await group();
    const p = await personal();
    expect(g.storedCopies + p.storedCopies).toBe(12);
    expect(p.storedCopies).toBe(5);
    expect(g.storedCopies).toBe(7);
  });
});

describe("Team Report export with the flag", () => {
  const asof = Date.now() - 3_600_000;
  const url = (format: "csv" | "xlsx") => `http://localhost/p/${projects.isp.slug}/api/team-report/export?period=day&date=2025-07-08&asof=${asof}&format=${format}`;
  const sheets = async (format: "xlsx") => {
    const res = await inIsp(() => exportRoute.GET(new NextRequest(url(format))));
    const book = XLSX.read(Buffer.from(await res.arrayBuffer()), { type: "buffer" });
    const out: Record<string, unknown[][]> = {};
    for (const name of book.SheetNames) out[name] = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[name]!, { header: 1, defval: "" });
    return { names: book.SheetNames, out };
  };
  const csv = async () => (await inIsp(() => exportRoute.GET(new NextRequest(url("csv"))))).text();
  const setFlag = async (enabled: boolean) => {
    await rawPrisma.projectFeature.upsert({
      where: { projectId_key: { projectId: projects.isp.id, key: "UNIFIED_REPORTING" } },
      create: { projectId: projects.isp.id, key: "UNIFIED_REPORTING", enabled },
      update: { enabled },
    });
    forgetProjectFeatureStates();
  };

  it("flag off: no Run information sheet and no Collection detail lines; flag on adds them and changes nothing else", async () => {
    await setFlag(false);
    const off = await sheets("xlsx");
    const offCsv = await csv();
    expect(off.names).not.toContain("Run information");
    expect(JSON.stringify(off.out["Data quality"])).not.toContain("Collection detail");

    await setFlag(true);
    const on = await sheets("xlsx");
    // WP10 adds Ranking and Daily engagement, WP7 the Customer-specific replies sheet after them (its own test file checks the contents).
    expect(on.names).toEqual([...off.names, "Run information", "Ranking", "Daily engagement", "Customer-specific replies"]);
    // Every existing sheet is byte-for-byte what it was, except "Data quality", which only gained rows.
    for (const name of off.names.filter((n) => n !== "Data quality")) expect(on.out[name], name).toEqual(off.out[name]);
    const quality = on.out["Data quality"]!;
    expect(quality.slice(0, off.out["Data quality"]!.length)).toEqual(off.out["Data quality"]);
    const detail = quality.slice(off.out["Data quality"]!.length);
    expect(detail.length).toBeGreaterThanOrEqual(5);
    expect(detail.every((row) => row[0] === "Collection detail")).toBe(true);
    const late = detail.find((row) => String(row[1]).startsWith("Stored later than"));
    expect(late?.[2]).toBe(3);
    expect(detail.find((row) => row[1] === "Roster changes still being applied to history")?.[2]).toBe(2);
    // The CSV is the group list only, unchanged by the flag.
    expect(await csv()).toBe(offCsv);
  });

  it("Run information says what the run was: version, the page's moment as the data cutoff, filters and identity mode", async () => {
    await setFlag(true);
    const { out } = await sheets("xlsx");
    const rows = out["Run information"]!;
    expect(rows[0]).toEqual(["Item", "Value", "Note"]);
    const value = (item: string) => rows.find((row) => row[0] === item)?.[1];
    // With the flag on the section ran, so its version is named beside the group's (06 §5.2).
    expect(value("Calculation version")).toBe("group-2026.10.19, reply-attribution-1");
    expect(value("Time zone")).toBe("Asia/Dhaka");
    expect(value("Scope")).toBe("Groups");
    expect(String(value("Period"))).toContain("8 July 2025");
    const cutoff = String(value("Data cutoff"));
    const generated = String(value("Generated at"));
    // An export carrying `asof` reads rows stored by then: the cutoff and the generation moment are that moment.
    expect(cutoff).toBe(generated);
    expect(rows.find((row) => row[0] === "Data cutoff")?.[2]).toBe("Everything stored at that moment.");
    expect(String(value("How senders are identified"))).toContain("team roster as it is now");
    expect(value("Roster changes still being applied")).toBe("2");
    expect(rows.every((row) => !String(row[1]).includes("%"))).toBe(true);
    await setFlag(false);
  });
});
