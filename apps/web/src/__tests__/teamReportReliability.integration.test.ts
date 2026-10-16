import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { runWithProject, type ActiveProject } from "@/server/projectContext";
import { loadTeamReport, parseTeamReportFilters } from "@/server/teamReport";

/**
 * Phase 2, Stage 7 (PHASE2.md), against real rows: the Team Report's loader classifies every reply
 * from the send it echoes, reads the message before the period so a wait crossing midnight is not
 * counted twice, and counts what it read for the reliability section.
 *
 * The conversation (one WhatsApp group, both of our numbers in it):
 *   day 1 18:00  customer "my internet is down"            — stored by A and B
 *   day 2 00:10  customer "still down"                      — continues the 18:00 wait (6 h earlier,
 *                                                             past the 4-hour context window)
 *   day 2 00:20  AI reply (OutboundMessage AUTO_REPLY, no rule)
 *   day 2 00:25  customer "ok but when?"                    — a new wait
 *   day 2 00:40  Rina (WhatsApp id + phone)
 *   day 2 10:00  customer "bill please"                     — stored by A and B
 *   day 2 10:02  rule reply (OutboundMessage AUTO_REPLY with a rule)
 *   day 2 10:05  dashboard reply (OutboundMessage MANUAL_REPLY, who pressed send)
 *   day 2 14:00  customer "hello?"
 *   day 2 14:03  business phone (echoes no send of ours)
 *   day 2 16:00  Tanvir (phone number only)
 *
 * And a second group, where the AI answered just before midnight:
 *   day 1 23:00  customer "router?"   23:01 AI reply
 *   day 2 00:30  customer "??"        — a new wait (the AI answered), but NOT a new wait for a person:
 *                                       the 23:00 one is still open, and only the 4-hour context shows it
 *   day 2 00:45  Rina
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const D1 = "2025-05-09";
const D2 = "2025-05-10";
/** A Dhaka wall-clock time on 9 or 10 May 2025, as an instant. */
const t = (day: 9 | 10, hh: number, mm: number) => new Date(Date.UTC(2025, 4, day, hh - 6, mm));
const NOW = new Date();
const WGID = `120363${Date.now()}${Math.floor(Math.random() * 1000)}@g.us`;
const WGID2 = `120364${Date.now()}${Math.floor(Math.random() * 1000)}@g.us`;
const digits = () => `8801${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;

let project: ActiveProject;
let userId: string;
const ids = { a: "", b: "", groupA: "", groupB: "", group2: "", rule: "", rina: "", tanvir: "" };
const people = { customer: digits(), rina: digits(), tanvir: digits(), businessA: digits() };

async function stored(row: "A" | "B" | "G2", wamid: string, at: Date, sender: string, direction: "INCOMING" | "OUTGOING", body: string) {
  await rawPrisma.message.create({
    data: {
      projectId: project.id,
      accountId: row === "B" ? ids.b : ids.a,
      groupId: row === "A" ? ids.groupA : row === "B" ? ids.groupB : ids.group2,
      chatId: row === "G2" ? WGID2 : WGID,
      whatsappMessageId: wamid,
      senderPhone: sender,
      senderJid: `${sender}@c.us`,
      isFromTeamMember: false,
      direction,
      body,
      normalizedBody: body,
      timestampWa: at,
      processingStatus: "PROCESSED",
    },
  });
}

/** A customer line; `both` stores it on our second number too (one message, two rows). */
async function customer(key: string, at: Date, body: string, both = false) {
  for (const row of both ? (["A", "B"] as const) : (["A"] as const)) {
    await stored(row, `false_${WGID}_${key}${tag}_${people.customer}@c.us`, at, people.customer, "INCOMING", body);
  }
}

/** Our reply from number A, and — unless it was typed on the phone — the send it echoes. */
async function reply(
  key: string,
  at: Date,
  body: string,
  send: { actionType: "AUTO_REPLY" | "MANUAL_REPLY"; ruleId?: string; createdById?: string } | null,
  row: "A" | "G2" = "A",
) {
  const chat = row === "G2" ? WGID2 : WGID;
  const wamid = `true_${chat}_${key}${tag}`;
  if (send) {
    await rawPrisma.outboundMessage.create({
      data: {
        projectId: project.id,
        accountId: ids.a,
        chatId: chat,
        toPhone: chat,
        body,
        actionType: send.actionType,
        ruleId: send.ruleId ?? null,
        createdById: send.createdById ?? null,
        idempotencyKey: `rel-${key}-${tag}`,
        status: "SENT",
        sentAt: at,
        scheduledAt: at,
        providerMessageId: wamid,
      },
    });
  }
  await stored(row, wamid, at, people.businessA, "OUTGOING", body);
}

beforeAll(async () => {
  const user = await rawPrisma.user.create({ data: { username: `rel_${tag}`, email: `rel_${tag}@example.test`, name: "Reliability", passwordHash: "x" } });
  userId = user.id;
  const created = await createProjectWithDefaults({ name: `Reliability ${tag}`, slug: `rel-${tag}`, status: "ACTIVE", creatorUserId: userId }, rawPrisma);
  project = { id: created.id, slug: created.slug, name: `Reliability ${tag}`, status: "ACTIVE" };
  const pid = { projectId: project.id };

  ids.a = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `Rel A ${tag}`, status: "CONNECTED", phoneNumber: people.businessA } })).id;
  ids.b = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `Rel B ${tag}`, status: "CONNECTED" } })).id;
  const group = (accountId: string) =>
    rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId, whatsappGroupId: WGID, name: `Rel group ${tag}`, isMonitored: true, isActive: true, lastSyncedAt: new Date() } });
  ids.groupA = (await group(ids.a)).id;
  ids.groupB = (await group(ids.b)).id;
  ids.group2 = (
    await rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId: ids.a, whatsappGroupId: WGID2, name: `Rel group 2 ${tag}`, isMonitored: true, isActive: true, lastSyncedAt: new Date() } })
  ).id;
  ids.rule = (await rawPrisma.automationRule.create({ data: { ...pid, name: `Rel rule ${tag}`, type: "AUTO_REPLY", matchType: "ALWAYS" } })).id;
  ids.rina = (await rawPrisma.internalTeamMember.create({ data: { ...pid, name: `Rina ${tag}`, phoneNumber: `+${people.rina}`, whatsappId: people.rina, role: "Support" } })).id;
  ids.tanvir = (await rawPrisma.internalTeamMember.create({ data: { ...pid, name: `Tanvir ${tag}`, phoneNumber: `+${people.tanvir}`, role: "Support" } })).id;

  await customer("K1", t(9, 18, 0), "my internet is down", true);
  await customer("K2", t(10, 0, 10), "still down");
  await reply("K3", t(10, 0, 20), "We are checking your line.", { actionType: "AUTO_REPLY" });
  await customer("K4", t(10, 0, 25), "ok but when?");
  await stored("A", `false_${WGID}_K5${tag}_${people.rina}@c.us`, t(10, 0, 40), people.rina, "INCOMING", "A technician is on the way");
  await customer("K6", t(10, 10, 0), "bill please", true);
  await reply("K7", t(10, 10, 2), "Your bill is in the app.", { actionType: "AUTO_REPLY", ruleId: ids.rule });
  await reply("K8", t(10, 10, 5), "I have sent it to you as well.", { actionType: "MANUAL_REPLY", createdById: userId });
  await customer("K9", t(10, 14, 0), "hello?");
  await reply("K10", t(10, 14, 3), "yes, tell me", null);
  await stored("A", `false_${WGID}_K11${tag}_${people.tanvir}@c.us`, t(10, 16, 0), people.tanvir, "INCOMING", "following up on the outage");

  await stored("G2", `false_${WGID2}_L1${tag}_${people.customer}@c.us`, t(9, 23, 0), people.customer, "INCOMING", "router?");
  await reply("L2", t(9, 23, 1), "Please restart the router.", { actionType: "AUTO_REPLY" }, "G2");
  await stored("G2", `false_${WGID2}_L3${tag}_${people.customer}@c.us`, t(10, 0, 30), people.customer, "INCOMING", "??");
  await stored("G2", `false_${WGID2}_L4${tag}_${people.rina}@c.us`, t(10, 0, 45), people.rina, "INCOMING", "Checking it now");
});

afterAll(async () => {
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((row) => row.table_name);
  for (let pass = 0; pass < 6; pass++) {
    for (const name of tables) {
      await rawPrisma.$executeRawUnsafe(`DELETE FROM "${name}" WHERE "projectId" = $1`, project.id).catch(() => undefined);
    }
  }
  await rawPrisma.project.deleteMany({ where: { id: project.id } });
  await rawPrisma.user.deleteMany({ where: { id: userId } });
  await rawPrisma.$disconnect();
});

const report = (params: Record<string, string>) => runWithProject(project, () => loadTeamReport(parseTeamReportFilters(params, NOW), NOW));

describe("a wait that crosses midnight", () => {
  it("is counted on the day it began, once — the days add up to the month", async () => {
    const [day1, day2, month] = await Promise.all([
      report({ period: "day", date: D1 }),
      report({ period: "day", date: D2 }),
      report({ period: "month", date: D2 }),
    ]);
    // 18:00 and 23:00 (day 1); then 00:25, 10:00, 14:00 and group 2's 00:30 (day 2). 00:10
    // continues the 18:00 wait.
    expect(day1.result.summary.waits).toBe(2);
    expect(day2.result.summary.waits).toBe(4);
    expect(month.result.summary.waits).toBe(6);
    expect(day1.result.summary.waits + day2.result.summary.waits).toBe(month.result.summary.waits);
    // The context is read, never counted: day 2's customer messages are its own five lines.
    expect(day2.result.summary.customerMessages).toBe(5);
  });

  it("hands the reports at /reports/<id> exactly the period and its look-ahead, as before", async () => {
    const day2 = await report({ period: "day", date: D2 });
    expect(day2.messages.every((m) => m.ts >= day2.range.start.getTime())).toBe(true);
  });
});

describe("who answered (reply provenance)", () => {
  it("classifies each reply from the send it echoes, never from direction alone", async () => {
    const [day1, day2] = await Promise.all([report({ period: "day", date: D1 }), report({ period: "day", date: D2 })]);
    // Both of day 1's waits were ended by the AI — the first observed response.
    expect(day1.response.firstReplyBy).toMatchObject({ AUTOMATED_AI: 2, HUMAN_TEAM_MEMBER: 0 });
    expect(day1.result.waits[0]).toMatchObject({ repliedByActor: "AI", status: "RECALLED" });
    // Day 2: Rina twice, the rule, the business phone.
    expect(day2.response.firstReplyBy).toEqual({
      HUMAN_TEAM_MEMBER: 2,
      AUTOMATED_AI: 0,
      AUTOMATED_RULE: 1,
      OTHER_BUSINESS_REPLY: 1,
      UNKNOWN_OR_UNATTRIBUTED: 0,
      UNCLASSIFIED: 0,
    });
    expect(day2.response.automated).toMatchObject({ waits: 1, medianSeconds: 120 });
  });

  it("measures the first human response the Human Response SLA way, to a verified person", async () => {
    const day2 = await report({ period: "day", date: D2 });
    // The 18:00 and 23:00 human waits began on day 1 and are not day 2's — group 2's 00:30 line
    // continues the 23:00 one, which only the 4 hours before the period show. 10:00: rule first, the
    // dashboard user five minutes in. 14:00: ended by the business phone — a person nobody can name.
    expect(day2.response.human).toMatchObject({ waits: 2, answeredVerified: 1, answeredUnverified: 1, afterAutomation: 1, medianSeconds: 300 });
    const day1 = await report({ period: "day", date: D1 });
    expect(day1.response.human).toMatchObject({ waits: 2, answeredVerified: 2, afterAutomation: 2 });
  });

  it("changes none of the report's existing figures", async () => {
    const day2 = await report({ period: "day", date: D2 });
    expect(day2.result.summary).toMatchObject({ memberReplies: 3, businessReplies: 4, waits: 4, groupsSupported: 2 });
  });
});

describe("what the period was built from", () => {
  it("counts stored copies, logical messages, senders and attribution strength", async () => {
    const day2 = await report({ period: "day", date: D2 });
    expect(day2.reliabilityCounts).toMatchObject({
      storedCopies: 13,
      logicalMessages: 12,
      byActor: { CUSTOMER: 5, MEMBER: 3, MEMBER_UNMAPPED: 0, OPERATOR: 1, AI: 1, RULE: 1, BROADCAST: 0, BUSINESS_PHONE: 1 },
      attribution: { idAndPhone: 2, idOnly: 0, phoneOnly: 1 },
      conflicting: 0,
      unattributedSenders: 0,
    });
  });
});
