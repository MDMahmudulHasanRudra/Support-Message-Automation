import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as XLSX from "xlsx";
import { createProjectWithDefaults, ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { runWithProject, type ActiveProject } from "@/server/projectContext";
import { buildReport } from "@/server/reports";
import { loadReportContext } from "@/server/reports/context";
import { loadIntelligence } from "@/server/intelligence/loader";
import { reportWorkbook } from "@/server/reports/exportFile";

/**
 * Support Intelligence against real rows (SUPPORT_INTELLIGENCE_IMPLEMENTATION_AUDIT.md): who sent
 * each message — through the OutboundMessage echo join — the SQL phrase pre-filter, human vs existing
 * SLA, cases and ownership from real text, concurrency, duty, eligibility, project isolation and the
 * exports. Bizify holds the SAME WhatsApp group ids with different messages.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const at = (month: number, day: number, hh = 10, mm = 0) => new Date(Date.UTC(2025, month - 1, day, hh - 6, mm));
const NOW = at(11, 20, 12);
const OCTOBER = { period: "custom", from: "2025-10-01", to: "2025-10-31" };
const digits = () => `8801${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
const isp: ActiveProject = { id: ORIGINAL_PROJECT_ID, slug: "isp-digital", name: "ISP Digital", status: "ACTIVE" };
let biz: ActiveProject;
const ids = { account: "", rina: "", bipul: "", kamal: "", user: "", biz: "", rule: "" };
const phones = { rina: digits(), bipul: digits(), kamal: digits(), customer: digits() };
const wg = { g1: `si1-${tag}@g.us`, g2: `si2-${tag}@g.us`, g3: `si3-${tag}@g.us`, g4: `si4-${tag}@g.us`, g5: `si5-${tag}@g.us` };
const groupRow = {} as Record<keyof typeof wg, { id: string; accountId: string; whatsappGroupId: string }>;
const rinaFix = { key: `si-fix-${tag}` };
let originalVerifiedFrom: Date | null = null;
const sharedKey = { value: "" };

async function message(
  g: keyof typeof wg,
  when: Date,
  from: "customer" | "rina" | "bipul" | "kamal" | "us",
  body: string,
  extra: { key?: string; quoted?: string; outbound?: { actionType: string; ruleId?: string | null; createdById?: string | null } } = {},
) {
  const row = groupRow[g];
  const key = extra.key ?? `si-${randomUUID()}`;
  const quoted = extra.quoted ? await rawPrisma.message.findFirst({ where: { whatsappMessageId: extra.quoted, projectId: ORIGINAL_PROJECT_ID } }) : null;
  await rawPrisma.message.create({
    data: {
      projectId: ORIGINAL_PROJECT_ID,
      accountId: row.accountId,
      groupId: row.id,
      chatId: row.whatsappGroupId,
      whatsappMessageId: key,
      senderPhone: from === "customer" ? phones.customer : from === "us" ? "8801000000000" : phones[from],
      direction: from === "us" ? "OUTGOING" : "INCOMING",
      body,
      normalizedBody: body.toLowerCase(),
      timestampWa: when,
      processingStatus: "PROCESSED",
      quotedMessageId: quoted?.id ?? null,
    },
  });
  if (extra.outbound) {
    await rawPrisma.outboundMessage.create({
      data: {
        projectId: ORIGINAL_PROJECT_ID,
        accountId: row.accountId,
        chatId: row.whatsappGroupId,
        toPhone: phones.customer,
        body,
        actionType: extra.outbound.actionType as never,
        ruleId: extra.outbound.ruleId ?? null,
        createdById: extra.outbound.createdById ?? null,
        idempotencyKey: `si-${randomUUID()}`,
        status: "SENT",
        sentAt: when,
        providerMessageId: key,
      },
    });
  }
  return key;
}

const run = (project: ActiveProject, id: string, extra: Record<string, string> = {}, groups = Object.values(wg)) =>
  runWithProject(project, async () => (await buildReport(id, { ...OCTOBER, groups: groups.join(","), ...extra }, NOW)).report);
const intelFor = (project: ActiveProject, params: Record<string, string>, groups = Object.values(wg)) =>
  runWithProject(project, async () => {
    const ctx = await loadReportContext({ ...params, groups: groups.join(",") }, NOW);
    return { ctx, intel: await loadIntelligence(ctx) };
  });

beforeAll(async () => {
  const settings = await rawPrisma.supportActivitySettings.findUnique({ where: { projectId: ORIGINAL_PROJECT_ID } });
  originalVerifiedFrom = settings?.reportingVerifiedFrom ?? null;
  ids.user = (await rawPrisma.user.create({ data: { username: `si_${tag}`, email: `si_${tag}@example.test`, name: "Operator Ola", passwordHash: "x" } })).id;
  const pid = { projectId: ORIGINAL_PROJECT_ID };
  ids.account = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `SI ${tag}`, status: "CONNECTED" } })).id;
  ids.rina = (await rawPrisma.internalTeamMember.create({ data: { ...pid, name: `Rina ${tag}`, phoneNumber: phones.rina, role: "Support" } })).id;
  ids.bipul = (await rawPrisma.internalTeamMember.create({ data: { ...pid, name: `Bipul ${tag}`, phoneNumber: phones.bipul, role: "Support" } })).id;
  ids.kamal = (await rawPrisma.internalTeamMember.create({ data: { ...pid, name: `Kamal ${tag}`, phoneNumber: phones.kamal, role: "Support" } })).id;
  ids.rule = (await rawPrisma.automationRule.create({ data: { ...pid, name: `SI rule ${tag}`, type: "AUTO_REPLY", matchType: "ALWAYS" } })).id;
  for (const [k, v] of Object.entries(wg) as Array<[keyof typeof wg, string]>) {
    groupRow[k] = await rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId: ids.account, whatsappGroupId: v, name: `SI ${k} ${tag}`, isMonitored: true, isActive: true } });
  }

  // G1, 6 Oct: a developer hand-off, a return with the fix, the customer confirming and thanking — quoting Rina.
  await message("g1", at(10, 6, 10, 0), "customer", "Internet not working since morning");
  await message("g1", at(10, 6, 10, 2), "rina", "I will check with the developer");
  await message("g1", at(10, 6, 11, 20), "rina", "It has been fixed, please check now", { key: rinaFix.key });
  await message("g1", at(10, 6, 11, 30), "customer", "Yes it is working, thank you", { quoted: rinaFix.key });
  // A long message no catalogue matches: its text must not leave the database.
  await message("g1", at(10, 6, 18, 0), "customer", "Could you look into the connection because the speed keeps dropping every evening around eight");

  // G2, 7 Oct: the AI answers at once, a person 45 minutes later.
  await message("g2", at(10, 7, 10, 0), "customer", "amar bill ta ki bhul?");
  await message("g2", at(10, 7, 10, 1), "us", "Apnar bill thik ache.", { outbound: { actionType: "AUTO_REPLY", ruleId: null } });
  await message("g2", at(10, 7, 10, 45), "bipul", "Ami check kore dekhchi");

  // G3, 8 Oct: the business phone (no send of ours), then a dashboard operator.
  await message("g3", at(10, 8, 10, 0), "customer", "router change korte chai");
  const businessPhoneKey = await message("g3", at(10, 8, 10, 10), "us", "ji, kal technician jabe");
  sharedKey.value = businessPhoneKey;
  await message("g3", at(10, 8, 12, 0), "customer", "kokhon asbe?");
  await message("g3", at(10, 8, 12, 5), "us", "Sokal 10 tay", { outbound: { actionType: "MANUAL_REPLY", createdById: ids.user } });

  // G4, 9 Oct: only a rule answers — never a person.
  await message("g4", at(10, 9, 10, 0), "customer", "connection nai");
  await message("g4", at(10, 9, 10, 1), "us", "Thank you for contacting us.", { outbound: { actionType: "AUTO_REPLY", ruleId: ids.rule } });

  // 10 Oct: Rina in three groups at once — 50 minutes of observed time, not 90.
  await message("g1", at(10, 10, 10, 0), "rina", "update dicchi");
  await message("g1", at(10, 10, 10, 30), "rina", "ok");
  await message("g2", at(10, 10, 10, 10), "rina", "checking");
  await message("g2", at(10, 10, 10, 40), "rina", "ok");
  await message("g3", at(10, 10, 10, 20), "rina", "dekhchi");
  await message("g3", at(10, 10, 10, 50), "rina", "ok");
  // Her shift that day: 10:15–11:00.
  await rawPrisma.dutyAssignment.create({ data: { ...pid, teamMemberId: ids.rina, dutyDate: new Date("2025-10-10T00:00:00Z"), status: "DUTY", shiftName: "Short", shiftStartMinute: 615, shiftEndMinute: 660 } });

  // G5, 13–15 Oct: Kamal answers 21 customers within two minutes, across three days.
  for (let i = 0; i < 21; i++) {
    const day = 13 + Math.floor(i / 7);
    const hour = 9 + (i % 7);
    await message("g5", at(10, day, hour, 0), "customer", `prosno ${i}`);
    await message("g5", at(10, day, hour, 2), "kamal", `uttor ${i}`);
  }

  // Bizify: the SAME group ids, its own conversation.
  const bizRow = await createProjectWithDefaults({ name: `SI Biz ${tag}`, slug: `si-biz-${tag}`, status: "ACTIVE", creatorUserId: ids.user }, rawPrisma);
  biz = { id: bizRow.id, slug: bizRow.slug, name: "SI Biz", status: "ACTIVE" };
  ids.biz = bizRow.id;
  const bacc = await rawPrisma.whatsAppAccount.create({ data: { projectId: biz.id, label: `SI Biz ${tag}`, status: "CONNECTED" } });
  const bg = await rawPrisma.whatsAppGroup.create({ data: { projectId: biz.id, accountId: bacc.id, whatsappGroupId: wg.g1, name: "Biz copy", isMonitored: true, isActive: true } });
  // Another project's send carrying the same WhatsApp id must never explain ISP Digital's message.
  await rawPrisma.outboundMessage.create({
    data: { projectId: biz.id, accountId: bacc.id, chatId: wg.g3, toPhone: "x", body: "x", actionType: "MANUAL_REPLY", idempotencyKey: `si-biz-${randomUUID()}`, status: "SENT", providerMessageId: sharedKey.value },
  });
  for (let i = 0; i < 4; i++) {
    await rawPrisma.message.create({
      data: { projectId: biz.id, accountId: bacc.id, groupId: bg.id, chatId: wg.g1, whatsappMessageId: `si-biz-${randomUUID()}`, senderPhone: digits(), direction: "INCOMING", body: "still not working", normalizedBody: "still not working", timestampWa: at(10, 6, 9 + i), processingStatus: "PROCESSED" },
    });
  }
});

afterAll(async () => {
  await rawPrisma.supportActivitySettings.updateMany({ where: { projectId: ORIGINAL_PROJECT_ID }, data: { reportingVerifiedFrom: originalVerifiedFrom } });
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: ids.account } });
  await rawPrisma.dutyAssignment.deleteMany({ where: { teamMemberId: { in: [ids.rina, ids.bipul, ids.kamal] } } });
  await rawPrisma.internalTeamMember.deleteMany({ where: { id: { in: [ids.rina, ids.bipul, ids.kamal] } } });
  await rawPrisma.automationRule.deleteMany({ where: { id: ids.rule } });
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((r) => r.table_name);
  for (let pass = 0; pass < 4; pass++) {
    for (const t of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "projectId" = $1`, ids.biz).catch(() => undefined);
  }
  await rawPrisma.project.deleteMany({ where: { id: ids.biz } });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: ids.user } });
  await rawPrisma.user.deleteMany({ where: { id: ids.user } });
  await rawPrisma.$disconnect();
});

describe("who sent each message", () => {
  it("member by phone; AI, rule and operator through the send they echo; business phone when there is none", async () => {
    const { intel } = await intelFor(isp, OCTOBER);
    const actorAt = (g: keyof typeof wg, d: Date) => intel.messages.find((m) => m.groupKey === wg[g] && m.ts === d.getTime())!;
    expect(actorAt("g1", at(10, 6, 10, 2))).toMatchObject({ actor: "MEMBER", memberId: ids.rina });
    expect(actorAt("g2", at(10, 7, 10, 1)).actor).toBe("AI");
    expect(actorAt("g4", at(10, 9, 10, 1)).actor).toBe("RULE");
    expect(actorAt("g3", at(10, 8, 10, 10)).actor).toBe("BUSINESS_PHONE");
    expect(actorAt("g3", at(10, 8, 12, 5))).toMatchObject({ actor: "OPERATOR", operatorUserId: ids.user });
    expect(actorAt("g1", at(10, 6, 11, 30)).quotedMemberId).toBe(ids.rina);
  });

  it("text leaves the database only when a catalogue could match it", async () => {
    const { intel } = await intelFor(isp, OCTOBER);
    const long = intel.messages.find((m) => m.ts === at(10, 6, 18, 0).getTime())!;
    expect(long.text).toBeNull();
    expect(intel.messages.find((m) => m.ts === at(10, 6, 10, 2).getTime())!.text).toBe("I will check with the developer");
  });

  it("the period's customer messages agree with the Team Report's", async () => {
    const { ctx, intel } = await intelFor(isp, OCTOBER);
    const inPeriod = intel.messages.filter((m) => m.actor === "CUSTOMER" && m.ts >= ctx.rangeStart && m.ts < ctx.rangeEnd).length;
    expect(inPeriod).toBe(ctx.data.result.summary.customerMessages);
  });
});

describe("Human Response SLA beside the existing Response SLA", () => {
  it("AI at once and a person 45 minutes later: on time for the existing SLA, LATE for a person", async () => {
    const r = await run(isp, "human-response-sla", {}, [wg.g2]);
    const tile = (label: string) => r.tiles.find((t) => t.label === label)!.value;
    expect(tile("Human SLA")).toBe("0.0%");
    expect(tile("Response SLA (existing)")).toBe("100.0%");
    expect(tile("AI or rule replied first")).toBe("1");
  });

  it("a rule-only answer is never a person's: missed", async () => {
    const r = await run(isp, "human-response-sla", {}, [wg.g4]);
    expect(r.tiles.find((t) => t.label === "Never answered by a person")!.value).toBe("1");
  });

  it("the business phone and the operator are people", async () => {
    const r = await run(isp, "human-response-sla", {}, [wg.g3]);
    const responders = r.tables.find((t) => t.id === "responders")!.rows.map((row) => row.cells[0]);
    expect(responders).toEqual(expect.arrayContaining(["Business phone (person unknown)", "Operator Ola (dashboard)"]));
  });
});

describe("cases from the real conversation", () => {
  it("the developer hand-off case: resolved HIGH, owned by Rina with the reasons, and she is thanked", async () => {
    const { intel } = await intelFor(isp, OCTOBER, [wg.g1]);
    const c = intel.cases.find((x) => x.openedAt === at(10, 6, 10, 0).getTime())!;
    expect(c.state).toBe("RESOLVED");
    expect(c.resolution).toMatchObject({ confidence: "HIGH" });
    expect(c.owner).toMatchObject({ memberId: ids.rina, confidence: "HIGH" });
    expect(c.handoffs[0]).toMatchObject({ confidence: "HIGH", returned: true });
    const thanks = intel.appreciation.find((a) => a.at === at(10, 6, 11, 30).getTime())!;
    expect(thanks).toMatchObject({ memberId: ids.rina, confidence: "HIGH", kind: "GENERAL_THANKS" });
  });

  it("the rule-only case is 'no further contact', never resolved", async () => {
    const { intel } = await intelFor(isp, OCTOBER, [wg.g4]);
    expect(intel.cases[0]).toMatchObject({ state: "ABANDONED", resolution: null, owner: null });
  });
});

describe("time, concurrency and duty", () => {
  it("three overlapping groups: 50 minutes observed, peak 3; 35 minutes in duty, 15 before the shift", async () => {
    const { intel } = await intelFor(isp, { period: "custom", from: "2025-10-10", to: "2025-10-10" }, [wg.g1, wg.g2, wg.g3]);
    const rina = intel.effectiveness.find((e) => e.memberId === ids.rina)!.metrics;
    expect(rina.observed).toMatchObject({ observedSeconds: 50 * 60, summedSessionSeconds: 90 * 60, peakConcurrency: 3 });
    expect(rina.duty).toMatchObject({ scheduledSeconds: 45 * 60, inDutySeconds: 35 * 60, beforeShiftSeconds: 15 * 60, afterShiftSeconds: 0 });
  });
});

describe("eligibility follows verified data", () => {
  it("without a verified-from date nobody is scored; with one, Kamal's 21 waits on 3 days earn a score", async () => {
    await rawPrisma.supportActivitySettings.upsert({ where: { projectId: ORIGINAL_PROJECT_ID }, update: { reportingVerifiedFrom: null }, create: { id: "global", projectId: ORIGINAL_PROJECT_ID } });
    let r = await run(isp, "employee-effectiveness", {}, [wg.g5]);
    let kamal = r.tables.find((t) => t.id === "employees")!.rows.find((row) => row.key === ids.kamal)!;
    expect(kamal.cells[2]).toBe("Insufficient sample");
    await rawPrisma.supportActivitySettings.update({ where: { projectId: ORIGINAL_PROJECT_ID }, data: { reportingVerifiedFrom: at(9, 1, 0) } });
    r = await run(isp, "employee-effectiveness", {}, [wg.g5]);
    kamal = r.tables.find((t) => t.id === "employees")!.rows.find((row) => row.key === ids.kamal)!;
    expect(Number(kamal.cells[2])).toBeGreaterThan(0);
    expect(r.tables.find((t) => t.id === "leaderboards")!.rows.find((row) => row.key === "sla")!.cells[1]).toBe(`Kamal ${tag}`);
  });

  it("the member drill-down shows the breakdown and the evidence", async () => {
    const r = await run(isp, "employee-effectiveness", { member: ids.rina }, [wg.g1]);
    expect(r.title).toBe(`Employee Effectiveness — Rina ${tag}`);
    expect(r.tables.map((t) => t.id)).toEqual(["dimensions", "cases", "sessions", "appreciation", "preferences"]);
    expect(r.tables.find((t) => t.id === "appreciation")!.rows[0]!.cells[5]).toBe("Yes it is working, thank you");
  });
});

describe("isolation, comparison and exports", () => {
  it("Bizify's messages in the same group never become ISP Digital's cases, and the reverse", async () => {
    const ispIntel = (await intelFor(isp, OCTOBER, [wg.g1])).intel;
    expect(ispIntel.messages.every((m) => !m.key.startsWith("si-biz-"))).toBe(true);
    const bizIntel = (await intelFor(biz, OCTOBER, [wg.g1])).intel;
    expect(bizIntel.messages.length).toBe(4);
    expect(bizIntel.messages.every((m) => m.key.startsWith("si-biz-"))).toBe(true);
  });

  it("Executive Support Intelligence compares with the previous equal period, never a % from zero", async () => {
    const r = await run(isp, "support-intelligence");
    const cases = r.tables.find((t) => t.id === "comparison")!.rows.find((row) => row.key === "Cases")!;
    expect(cases.cells[1]).toBe("0");
    expect(String(cases.cells[3])).toMatch(/^new \(0 → \d+\)$/);
  });

  it("every intelligence report exports Summary, Detailed and Breakdown from the same builder", async () => {
    for (const id of ["support-intelligence", "employee-effectiveness", "support-cases", "human-response-sla", "customer-signals"]) {
      const { report, ctx } = await runWithProject(isp, () => buildReport(id, { ...OCTOBER, groups: Object.values(wg).join(",") }, NOW));
      const book = XLSX.read(reportWorkbook(report, ctx), { type: "buffer" });
      expect(book.SheetNames[0]).toBe("Summary");
      expect(book.SheetNames.some((n) => n.startsWith("Detailed"))).toBe(true);
    }
  });
});
