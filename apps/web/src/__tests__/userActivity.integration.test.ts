import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as XLSX from "xlsx";
import { createProjectWithDefaults, ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { runWithProject } from "@/server/projectContext";
import { buildReport } from "@/server/reports";
import { reportWorkbook } from "@/server/reports/exportFile";
import { getChatThread } from "@/server/chatInbox";

/**
 * WhatsApp Chat User Activity: who pressed send, from which number, to which group, when — read from
 * the outbound queue with the same attribution the chat thread shows. Fixed November 2025 dates so no
 * other suite's rows land in the period.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const isp = { id: ORIGINAL_PROJECT_ID, slug: "isp-digital", name: "ISP Digital", status: "ACTIVE" as const };
const inIsp = <T,>(fn: () => Promise<T>) => runWithProject(isp, fn);
const pid = { projectId: ORIGINAL_PROJECT_ID };
const NOVEMBER = { period: "custom", from: "2025-11-01", to: "2025-11-30" };
const NOW = new Date("2025-12-01T00:00:00Z");
/** Asia/Dhaka wall-clock time in November 2025. */
const at = (day: number, hh: number, mm = 0) => new Date(Date.UTC(2025, 10, day, hh - 6, mm));

const ids = { rudra: "", hasan: "", a: "", b: "", g1: "", g2: "", bizAccount: "", bizUser: "", rule: "", decisionMessage: "" };
const keys = { g1: `ua-${tag}-1@g.us`, g2: `ua-${tag}-2@g.us` };

let n = 0;
async function send(over: Record<string, unknown>) {
  return rawPrisma.outboundMessage.create({
    data: { ...pid, accountId: ids.a, chatId: keys.g1, toPhone: keys.g1, body: `msg ${n}`, idempotencyKey: `manual-reply:ua-${tag}-${n++}`, status: "SENT", actionType: "MANUAL_REPLY", ...over } as never,
  });
}

beforeAll(async () => {
  ids.rudra = (await rawPrisma.user.create({ data: { username: `rudra_${tag}`, name: "Rudra", passwordHash: "x" } })).id;
  ids.hasan = (await rawPrisma.user.create({ data: { username: `hasan_${tag}`, name: "Hasan", passwordHash: "x" } })).id;
  ids.a = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `UA Primary ${tag}`, status: "CONNECTED" } })).id;
  ids.b = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `UA Support ${tag}`, status: "CONNECTED" } })).id;
  ids.g1 = (await rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId: ids.a, whatsappGroupId: keys.g1, name: `UA Shuvo ${tag}`, isActive: true } })).id;
  ids.g2 = (await rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId: ids.b, whatsappGroupId: keys.g2, name: `UA Dhaka ${tag}`, isActive: true } })).id;
  ids.rule = (await rawPrisma.automationRule.create({ data: { ...pid, name: `UA rule ${tag}`, type: "AUTO_REPLY", matchType: "ALWAYS" } })).id;

  // Rudra: two chat replies from Primary, one from Support, one template test. Hasan: one chat reply
  // from Primary and one broadcast. Automation: one AI reply, one rule reply.
  const confirmed = await send({ createdById: ids.rudra, createdAt: at(3, 10), groupId: ids.g1, groupNameSnapshot: `UA Shuvo ${tag}`, providerMessageId: `ua-${tag}-wa1`, body: "Please check now." });
  await rawPrisma.message.create({ data: { ...pid, accountId: ids.a, groupId: ids.g1, chatId: keys.g1, whatsappMessageId: `ua-${tag}-wa1`, senderPhone: "us", direction: "OUTGOING", body: "Please check now.", normalizedBody: "please check now.", timestampWa: at(3, 10, 1), processingStatus: "PROCESSED" } });
  await send({ createdById: ids.rudra, createdAt: at(3, 10, 20), groupId: ids.g1, body: "Line reset korechi." });
  await send({ createdById: ids.rudra, createdAt: at(4, 15), accountId: ids.b, chatId: keys.g2, toPhone: keys.g2, groupId: ids.g2, body: "From Support." });
  await send({ createdById: ids.rudra, createdAt: at(4, 16), idempotencyKey: `template-test:AI_HANDOVER:${tag}`, body: "🧪 TEST" });
  await send({ createdById: ids.hasan, createdAt: at(5, 11), groupId: ids.g1, body: "Hasan here.", status: "FAILED" });
  await send({ createdById: ids.hasan, createdAt: at(5, 12), actionType: "GROUP_BROADCAST", idempotencyKey: `ua-${tag}-bc`, body: "Maintenance tonight." });
  const customer = await rawPrisma.message.create({ data: { ...pid, accountId: ids.a, groupId: ids.g1, chatId: keys.g1, whatsappMessageId: `ua-${tag}-q`, senderPhone: "8801999000444", direction: "INCOMING", body: "bill?", normalizedBody: "bill?", timestampWa: at(6, 9), processingStatus: "PROCESSED" } });
  ids.decisionMessage = customer.id;
  const ai = await send({ actionType: "AUTO_REPLY", createdAt: at(6, 9, 1), idempotencyKey: `ua-${tag}-ai`, body: "AI answer." });
  await rawPrisma.aiFallbackDecision.create({ data: { ...pid, messageId: customer.id, accountId: ids.a, groupId: ids.g1, outcome: "AI_REPLIED", reason: "ANSWERED", outboundMessageId: ai.id } });
  await send({ actionType: "AUTO_REPLY", ruleId: ids.rule, createdAt: at(6, 9, 2), idempotencyKey: `ua-${tag}-rule`, body: "Rule answer." });
  // Outside the period.
  await send({ createdById: ids.rudra, createdAt: new Date("2025-12-02T06:00:00Z"), body: "December." });
  void confirmed;

  // Another project's send, by another user, in the same period.
  const biz = (await rawPrisma.project.findFirst({ where: { slug: "bizify" } })) ?? (await createProjectWithDefaults({ name: "Bizify", slug: "bizify", status: "ACTIVE", creatorUserId: ids.rudra }, rawPrisma));
  ids.bizUser = (await rawPrisma.user.create({ data: { username: `biz_${tag}`, name: "Biz Person", passwordHash: "x" } })).id;
  ids.bizAccount = (await rawPrisma.whatsAppAccount.create({ data: { projectId: biz.id, label: `UA Biz ${tag}`, status: "CONNECTED" } })).id;
  await rawPrisma.outboundMessage.create({
    data: { projectId: biz.id, accountId: ids.bizAccount, chatId: "biz@g.us", toPhone: "biz@g.us", body: "Biz secret", idempotencyKey: `ua-${tag}-biz`, status: "SENT", actionType: "MANUAL_REPLY", createdById: ids.bizUser, createdAt: at(3, 12) },
  });
});

afterAll(async () => {
  const accounts = [ids.a, ids.b, ids.bizAccount].filter(Boolean);
  await rawPrisma.aiFallbackDecision.deleteMany({ where: { messageId: ids.decisionMessage } });
  await rawPrisma.outboundMessage.deleteMany({ where: { accountId: { in: accounts } } });
  await rawPrisma.message.deleteMany({ where: { accountId: { in: accounts } } });
  await rawPrisma.whatsAppGroup.deleteMany({ where: { accountId: { in: accounts } } });
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: { in: accounts } } });
  await rawPrisma.automationRule.deleteMany({ where: { id: ids.rule } });
  await rawPrisma.user.deleteMany({ where: { id: { in: [ids.rudra, ids.hasan, ids.bizUser].filter(Boolean) } } });
});

const build = (params: Record<string, string>) => inIsp(async () => (await buildReport("whatsapp-user-activity", { ...NOVEMBER, ...params }, NOW)).report);
const table = (report: Awaited<ReturnType<typeof build>>, id: string) => report.tables.find((t) => t.id === id)!;
const cell = (report: Awaited<ReturnType<typeof build>>, tableId: string, column: string) => {
  const t = table(report, tableId);
  const i = t.columns.findIndex((c) => c.label === column);
  return t.rows.map((r) => r.cells[i]);
};

describe("WhatsApp Chat User Activity", () => {
  it("defaults to human sends: chat replies and template tests, attributed to the person and the number", async () => {
    const report = await build({});
    const ours = table(report, "messages").rows.filter((r) => String(r.cells[2]).includes(tag));
    expect(ours).toHaveLength(5);
    const users = table(report, "users").rows.filter((r) => [ids.rudra, ids.hasan].includes(r.key));
    expect(users.map((r) => [r.cells[0], r.cells[1]])).toEqual([
      ["Rudra", 4],
      ["Hasan", 1],
    ]);
    expect(report.selects.find((s) => s.name === "sender")!.value).toBe("HUMAN_USER");
  });

  it("never shows another project's sends or people", async () => {
    const report = await build({});
    const text = JSON.stringify(report);
    expect(text).not.toContain("Biz secret");
    expect(text).not.toContain("Biz Person");
    expect(report.selects.find((s) => s.name === "user")!.options.some((o) => o.value === ids.bizUser)).toBe(false);
  });

  it("a person's detail: accounts, groups, every message, and the status WhatsApp confirmed", async () => {
    const report = await build({ user: ids.rudra });
    expect(report.title).toContain("Rudra");
    expect(report.tiles.find((t) => t.label === "Messages")!.value).toBe("4");
    expect(table(report, "accounts").rows.map((r) => r.cells[0]).sort()).toEqual([`UA Primary ${tag}`, `UA Support ${tag}`]);
    const statuses = cell(report, "messages", "Status");
    expect(statuses).toContain("Sent · confirmed by WhatsApp");
    expect(cell(report, "messages", "Source")).toContain("Template test");
    expect(cell(report, "messages", "Message")).not.toContain("December.");
  });

  it("drills from a person to one group's messages", async () => {
    const report = await build({ user: ids.rudra, groups: keys.g2 });
    expect(cell(report, "messages", "Message")).toEqual(["From Support."]);
    expect(cell(report, "messages", "WhatsApp account")).toEqual([`UA Support ${tag}`]);
  });

  it("the account filter narrows to one number", async () => {
    const report = await build({ account: ids.b });
    expect(cell(report, "messages", "Message")).toEqual(["From Support."]);
  });

  it("sender types stay apart: AI, rule and broadcast are never a person's chat reply", async () => {
    const ai = await build({ sender: "AI", account: ids.a });
    expect(cell(ai, "messages", "Message")).toEqual(["AI answer."]);
    expect(ai.tiles.find((t) => t.label === "Active users")!.value).toBe("—");
    const rule = await build({ sender: "RULE_AUTOMATION", account: ids.a });
    expect(cell(rule, "messages", "Message")).toEqual(["Rule answer."]);
    const broadcast = await build({ sender: "BROADCAST", account: ids.a });
    expect(cell(broadcast, "messages", "Message")).toEqual(["Maintenance tonight."]);
    expect(cell(broadcast, "messages", "User")).toEqual(["Hasan"]);
    const all = await build({ sender: "ALL", account: ids.a });
    expect(cell(all, "messages", "Message")).toHaveLength(7);
  });

  it("says what it is: no Team or member pickers, no 'Showing' scope in the export", async () => {
    const result = await inIsp(() => buildReport("whatsapp-user-activity", NOVEMBER, NOW));
    expect(result.report.usesMemberFilters).toBe(false);
    const book = XLSX.read(reportWorkbook(result.report, result.ctx), { type: "buffer" });
    const summary = XLSX.utils.sheet_to_json<string[]>(book.Sheets.Summary!, { header: 1 });
    expect(summary.some((row) => row[0] === "Showing")).toBe(false);
    expect(summary.some((row) => row[0] === "Software user")).toBe(true);
  });

  it("the conversation and the report name the same person for the same send", async () => {
    const thread = await inIsp(() => getChatThread(ids.g1));
    const inThread = thread!.entries.find((e) => e.body === "Please check now.")!;
    const report = await build({ account: ids.a });
    const row = table(report, "messages").rows.find((r) => r.cells[7] === "Please check now.")!;
    expect(inThread.sentBy?.name).toBe(row.cells[1]);
    expect(inThread.authoredBy).toBe("HUMAN_USER");
    expect(row.cells[4]).toBe("Human user");
  });
});
