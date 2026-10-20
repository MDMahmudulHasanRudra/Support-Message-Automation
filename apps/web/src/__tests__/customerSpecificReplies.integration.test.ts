import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { logicalMessageKey } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Unified reporting WP7: customer-specific reply attribution read from stored messages (quote and mention
 * evidence), and the Excel sheet. Synthetic data only; no real numbers or text. A second project fills the
 * same group id and window, so evidence that crosses the project boundary fails here.
 */

let current: Session;
const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const id = (name: string) => `cs-${tag}-${name}`;
const NOW = new Date(Date.UTC(2025, 6, 9, 12, 0));
const t = (hh: number, mm: number) => new Date(Date.UTC(2025, 6, 8, hh - 6, mm));
const G1 = "120000000000000001@g.us";
const G2 = "120000000000000002@g.us";
const C1_LID = "100000000001";
const C1_PHONE = "8801000000001";
const C2_PHONE = "8801000000002";
const RAKIB = "8801000000102";
const RINA = "8801000000103";
const SECRET = "SECRETBODY";

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
const { customerSpecificReplies } = await import("@/server/replyAttribution");
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

async function msg(
  project: Proj,
  o: { account: string; group: string; chat: string; at: Date; key: string; sender: string; jid: string; quotedMessageId?: string; mentions?: string[] },
) {
  const row = await rawPrisma.message.create({
    data: {
      projectId: project.id,
      accountId: o.account,
      groupId: o.group,
      chatId: o.chat,
      whatsappMessageId: `false_${o.chat}_${o.key}_${tag}`,
      senderPhone: o.sender,
      senderJid: o.jid,
      direction: "INCOMING",
      body: SECRET,
      normalizedBody: SECRET,
      timestampWa: o.at,
      processingStatus: "PROCESSED",
      ...(o.quotedMessageId ? { quotedMessageId: o.quotedMessageId } : {}),
      ...(o.mentions ? { mentionedPhones: o.mentions } : {}),
    },
    select: { id: true, whatsappMessageId: true },
  });
  return row;
}

beforeAll(async () => {
  const u = await rawPrisma.user.create({ data: { username: `cs_${tag}`, email: `cs_${tag}@example.test`, name: "CS", passwordHash: "x" } });
  userId = u.id;
  current = { userId: u.id, username: u.username, email: u.email!, name: "CS" } as Session;
  for (const key of ["isp", "other"] as const) {
    const created = await createProjectWithDefaults({ name: `CS ${key} ${tag}`, slug: `cs-${key}-${tag}`, status: "ACTIVE", creatorUserId: u.id }, rawPrisma);
    projects[key] = { id: created.id, slug: created.slug, name: `CS ${key} ${tag}`, status: "ACTIVE" };
    const pid = { projectId: created.id };
    await rawPrisma.whatsAppAccount.create({ data: { ...pid, id: id(`${key}-A`), label: `${key} A`, status: "CONNECTED", isPrimary: true } });
    await rawPrisma.whatsAppAccount.create({ data: { ...pid, id: id(`${key}-B`), label: `${key} B`, status: "CONNECTED" } });
    const grp = (account: "A" | "B", chat: string, name: string) =>
      rawPrisma.whatsAppGroup.create({
        data: { ...pid, id: id(`${key}-${name}-${account}`), accountId: id(`${key}-${account}`), whatsappGroupId: chat, name: `${key} ${name}`, isMonitored: true, isActive: true, lastSyncedAt: new Date(Date.UTC(2025, 6, 1)) },
      });
    await grp("A", G1, "g1");
    await grp("B", G1, "g1");
    await grp("A", G2, "g2");
    await rawPrisma.internalTeamMember.create({ data: { ...pid, id: id(`${key}-rakib`), name: "Rakib", phoneNumber: `+${RAKIB}`, role: "Support" } });
    await rawPrisma.internalTeamMember.create({ data: { ...pid, id: id(`${key}-rina`), name: "Rina", phoneNumber: `+${RINA}`, role: "Support" } });
  }

  const A = id("isp-A");
  const B = id("isp-B");
  const g1A = id("isp-g1-A");
  const g1B = id("isp-g1-B");
  const g2A = id("isp-g2-A");
  const isp = projects.isp;
  const cust = (account: string, group: string, chat: string, at: Date, key: string, who: "c1lid" | "c1phone" | "c2") =>
    msg(isp, {
      account,
      group,
      chat,
      at,
      key,
      sender: who === "c1lid" ? C1_LID : who === "c1phone" ? C1_PHONE : C2_PHONE,
      jid: who === "c1lid" ? `${C1_LID}@lid` : `${who === "c1phone" ? C1_PHONE : C2_PHONE}@c.us`,
    });
  const staff = (group: string, chat: string, at: Date, key: string, who: "rakib" | "rina", extra: { quotedMessageId?: string; mentions?: string[] } = {}) =>
    msg(isp, { account: A, group, chat, at, key, sender: who === "rakib" ? RAKIB : RINA, jid: `${who === "rakib" ? RAKIB : RINA}@c.us`, ...extra });

  // G1: C1's first line is stored by account A under a LID and by account B under the phone number (one message,
  // two ids: one customer). Then quote / mention / sequence / ambiguity.
  const q1 = await cust(A, g1A, G1, t(9, 0), "Q1", "c1lid");
  await cust(B, g1B, G1, t(9, 0), "Q1", "c1phone");
  await cust(A, g1A, G1, t(9, 1), "Q2", "c2");
  await staff(g1A, G1, t(9, 5), "R1", "rakib", { quotedMessageId: q1.id });
  await staff(g1A, G1, t(9, 10), "R2", "rina", { mentions: [C2_PHONE] });
  await cust(A, g1A, G1, t(11, 0), "Q3", "c1lid");
  await staff(g1A, G1, t(11, 5), "R3", "rakib");
  await cust(A, g1A, G1, t(13, 0), "Q4", "c1lid");
  await cust(A, g1A, G1, t(13, 1), "Q5", "c2");
  await staff(g1A, G1, t(13, 10), "R4", "rakib");
  await staff(g1A, G1, t(14, 0), "R5", "rina", { mentions: [C1_PHONE] });
  // G2: a quote and a mention that name C2 never credit C1, who is the one still waiting.
  await cust(A, g2A, G2, t(10, 0), "K1", "c1lid");
  const k2 = await cust(A, g2A, G2, t(10, 1), "K2", "c2");
  await staff(g2A, G2, t(10, 5), "KR1", "rakib", { quotedMessageId: k2.id });
  await staff(g2A, G2, t(10, 10), "KR2", "rakib", { mentions: [C2_PHONE] });
  // The other project: the same group ids, customers and window, answering by quote and mention — none of it ours.
  const O = id("other-A");
  // (Their own message ids, so nothing collapses into ours by key: only the project filter keeps them out.)
  const oq = await msg(projects.other, { account: O, group: id("other-g1-A"), chat: G1, at: t(9, 20), key: "OQ1", sender: C1_PHONE, jid: `${C1_PHONE}@c.us` });
  await msg(projects.other, { account: O, group: id("other-g1-A"), chat: G1, at: t(9, 25), key: "OR1", sender: RAKIB, jid: `${RAKIB}@c.us`, quotedMessageId: oq.id });
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

const filters = () => parseTeamReportFilters({ period: "day", date: "2025-07-08" }, NOW);
const load = (withReplyEvidence: boolean) => inIsp(() => loadTeamReport(filters(), NOW, undefined, withReplyEvidence ? { withReplyEvidence: true } : {}));
const setFlag = async (enabled: boolean) => {
  await rawPrisma.projectFeature.upsert({
    where: { projectId_key: { projectId: projects.isp.id, key: "UNIFIED_REPORTING" } },
    create: { projectId: projects.isp.id, key: "UNIFIED_REPORTING", enabled },
    update: { enabled },
  });
  forgetProjectFeatureStates();
};

describe("customer-specific reply evidence", () => {
  it("reads what a reply quotes and mentions, and every id of a customer's message", async () => {
    const report = await load(true);
    const evidence = report.replyEvidence!;
    const q1 = evidence.find((m) => m.key === logicalMessageKey(G1, `false_${G1}_Q1_${tag}`))!;
    // One message, two stored copies (a LID on one number, a phone on the other): one customer, both ids.
    expect(q1.kind).toBe("CUSTOMER");
    expect(q1.customerIds).toEqual([C1_LID, C1_PHONE].sort());
    const r1 = evidence.find((m) => m.key === logicalMessageKey(G1, `false_${G1}_R1_${tag}`))!;
    expect(r1.kind).toBe("MEMBER");
    // The quote is the logical key of the quoted message, so it resolves whichever account's copy was kept.
    expect(r1.quotedKey).toBe(q1.key);
    expect(evidence.find((m) => m.key === logicalMessageKey(G1, `false_${G1}_R2_${tag}`))!.mentionedIds).toEqual([C2_PHONE]);
    // Context rows are present too (the loader reads 4 hours before the period) and none carries a message text.
    expect(JSON.stringify(report.replyEvidence)).not.toContain(SECRET);
  });

  it("counts asks and replies by the evidence that linked them", async () => {
    const attribution = customerSpecificReplies(await load(true))!;
    expect(attribution.asks).toMatchObject({ total: 7, answeredTier1: 2, answeredTier2Mention: 2, answeredTier2Sequence: 1, unanswered: 2, pending: 0, noCustomerId: 0 });
    expect(attribution.replies.total).toBe(7);
    expect(attribution.replies.byTier).toMatchObject({ TIER1_QUOTE: 2, TIER2_MENTION: 2, TIER2_SEQUENCE: 1, TIER3_PROBABLE: 0, TIER4_UNRESOLVED: 2 });
    expect(attribution.replies.unresolvedReasons).toEqual({ MULTIPLE_OPEN_ASKS: 1, MENTIONED_OTHER_CUSTOMER: 1 });
    expect(attribution.byGroup).toEqual([
      { groupKey: G1, asks: 5, answeredVerified: 4, unanswered: 1, repliesUnresolved: 1 },
      { groupKey: G2, asks: 2, answeredVerified: 1, unanswered: 1, repliesUnresolved: 1 },
    ]);
  });

  it("a phone mention reaches a customer first seen under a LID (one cluster)", async () => {
    const report = await load(true);
    const detail = customerSpecificReplies(report, { detailGroupKey: G1 })!.asksDetail!;
    const answeredByMention = detail.filter((a) => a.tier === "TIER2_MENTION");
    // R5 mentions C1's phone at 14:00; the ask it closes is C1's (the cluster key is the smaller id, the LID).
    expect(answeredByMention.map((a) => [a.customerKey, a.askedAt])).toContainEqual([C1_LID, t(13, 0).getTime()]);
  });

  it("a quote or mention of a DIFFERENT customer is not credited as a reply to this one", async () => {
    const detail = customerSpecificReplies(await load(true), { detailGroupKey: G2 })!.asksDetail!;
    const c1 = detail.find((a) => a.customerKey === C1_LID)!;
    const c2 = detail.find((a) => a.customerKey === C2_PHONE)!;
    expect(c2).toMatchObject({ tier: "TIER1_QUOTE", answeredAt: t(10, 5).getTime() });
    // C1 was waiting the whole time, and neither reply was for them.
    expect(c1).toMatchObject({ tier: null, answeredAt: null, answeredBy: null });
  });

  it("shows a LID as a hidden number and never as a phone", async () => {
    const labels = (await load(true)).customerLabels!;
    expect(labels.get(C1_LID)).toBe("Hidden number ···0001");
    expect(labels.get(C1_PHONE)).toBe(`+${C1_PHONE}`);
    expect(labels.get(C2_PHONE)).toBe(`+${C2_PHONE}`);
    expect([...labels.values()].some((label) => label.startsWith(`+${C1_LID}`))).toBe(false);
  });

  it("another project's quote and mention never reach this project's evidence", async () => {
    const attribution = customerSpecificReplies(await load(true))!;
    // The other project answered its own Q1 by quote; had it leaked, G1 would show a third quoted reply.
    expect(attribution.replies.byTier.TIER1_QUOTE).toBe(2);
    expect(attribution.asks.total).toBe(7);
  });

  it("withReplyEvidence off returns exactly the legacy report, and on adds only the evidence", async () => {
    const off = await load(false);
    const on = await load(true);
    expect(off.replyEvidence).toBeUndefined();
    expect(off.customerLabels).toBeUndefined();
    expect(on.result).toEqual(off.result);
    expect(on.response).toEqual(off.response);
    expect(on.reliabilityCounts).toEqual(off.reliabilityCounts);
    expect(on.messages).toEqual(off.messages);
    expect(on.filters).toEqual(off.filters);
  });
});

describe("the Customer-specific replies sheet", () => {
  const workbook = async () => {
    const res = await inIsp(() => exportRoute.GET(new NextRequest(`http://localhost/p/${projects.isp.slug}/api/team-report/export?period=day&date=2025-07-08&asof=${Date.now() - 1000}&format=xlsx`)));
    return XLSX.read(Buffer.from(await res.arrayBuffer()), { type: "buffer" });
  };
  const cells = (book: XLSX.WorkBook, name: string) => XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[name]!, { header: 1, defval: "" });

  it("flag off: no such sheet; flag on: written after Run information, counts only", async () => {
    await setFlag(false);
    const off = await workbook();
    expect(off.SheetNames).not.toContain("Customer-specific replies");
    await setFlag(true);
    const on = await workbook();
    expect(on.SheetNames).toEqual([...off.SheetNames, "Run information", "Customer-specific replies"]);
    const rows = cells(on, "Customer-specific replies");
    expect(rows[0]!.slice(0, 4)).toEqual(["Section", "Measure", "Value", "Note"]);
    const value = (measure: string) => rows.find((r) => r[1] === measure)?.[2];
    expect(value("Customer requests")).toBe(7);
    expect(value("Answered, linked by a quote")).toBe(2);
    expect(value("Answered, linked by a mention")).toBe(2);
    expect(value("Answered, the only customer waiting")).toBe(1);
    expect(value("Calculation version")).toBe("reply-attribution-1");
    expect(rows.some((r) => r[0] === "Group" && r[1] === "Group ID")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    // Run information names the section's version beside the group's.
    const run = cells(on, "Run information");
    expect(run.find((r) => r[0] === "Calculation version")?.[1]).toBe("group-2026.10.19, reply-attribution-1");
    await setFlag(false);
  });
});
