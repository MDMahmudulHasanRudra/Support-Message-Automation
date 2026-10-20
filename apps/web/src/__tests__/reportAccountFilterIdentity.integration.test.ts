import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { runWithProject, type ActiveProject } from "@/server/projectContext";
import { buildReport } from "@/server/reports";
import { loadReportContext } from "@/server/reports/context";
import { loadIntelligence } from "@/server/intelligence/loader";
import { loadTeamReport, parseTeamReportFilters } from "@/server/teamReport";

/**
 * Audit bug B2 (docs/unified-reporting/01-existing-system-audit.md): with ONE WhatsApp account chosen,
 * the Support Intelligence reports and Calls decided who sent a message from that account's copy alone,
 * so a colleague WhatsApp showed to account A as a hidden id (a LID) and to account B as their number was
 * a CUSTOMER there while the Team Report, which hears every stored copy, credited them. Same filter, two
 * pages, two answers. Synthetic ids only.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const id = (name: string) => `b2-${tag}-${name}`;
const G = "120000000000000077@g.us";
const RINA = "8801000000001";
const LID = "100000000001";
const CUSTOMER = "8801999000001";
const at = (day: number, hh: number, mm = 0) => new Date(Date.UTC(2025, 9, day, hh - 6, mm));
const NOW = at(30, 12);
const PERIOD = { period: "custom", from: "2025-10-01", to: "2025-10-31", groups: G };

let project: ActiveProject;
let creatorId = "";
const inProject = <T,>(fn: () => Promise<T>) => runWithProject(project, fn);

let seq = 0;
async function copy(account: "A" | "B", key: string, when: Date, sender: string, jid: string, body: string) {
  seq += 1;
  await rawPrisma.message.create({
    data: {
      projectId: project.id,
      accountId: id(account),
      groupId: id(`g${account}`),
      chatId: G,
      whatsappMessageId: `false_${G}_${key}_${seq}`,
      senderPhone: sender,
      senderJid: jid,
      direction: "INCOMING",
      body,
      normalizedBody: body.toLowerCase(),
      timestampWa: when,
      processingStatus: "PROCESSED",
    },
  });
}

beforeAll(async () => {
  creatorId = (await rawPrisma.user.create({ data: { username: `b2_${tag}`, email: `b2_${tag}@example.test`, name: "B2", passwordHash: "x" } })).id;
  const created = await createProjectWithDefaults({ name: `B2 ${tag}`, slug: `b2-${tag}`, status: "ACTIVE", creatorUserId: creatorId }, rawPrisma);
  project = { id: created.id, slug: created.slug, name: `B2 ${tag}`, status: "ACTIVE" };
  const pid = { projectId: project.id };
  for (const a of ["A", "B"] as const) {
    await rawPrisma.whatsAppAccount.create({ data: { ...pid, id: id(a), label: `Account ${a}`, status: "CONNECTED", isPrimary: a === "A" } });
    await rawPrisma.whatsAppGroup.create({ data: { ...pid, id: id(`g${a}`), accountId: id(a), whatsappGroupId: G, name: "Shared group", isMonitored: true, isActive: true } });
  }
  // Rina is on the roster by her phone number only: her LID is not on file.
  await rawPrisma.internalTeamMember.create({ data: { ...pid, id: id("rina"), name: "Rina B2", phoneNumber: `+${RINA}`, role: "Support" } });

  // A customer asks; Rina answers. Account A saw Rina's answer under her LID, account B under her number.
  await copy("A", "Q1", at(6, 10, 0), CUSTOMER, `${CUSTOMER}@c.us`, "Internet is not working since morning");
  await copy("B", "Q1", at(6, 10, 0), CUSTOMER, `${CUSTOMER}@c.us`, "Internet is not working since morning");
  await copy("A", "R1", at(6, 10, 5), LID, `${LID}@lid`, "I will check this now");
  await copy("B", "R1", at(6, 10, 5), RINA, `${RINA}@c.us`, "I will check this now");
  // A call request, answered the same way by Rina (LID on A, phone on B).
  await copy("A", "R2", at(7, 11, 0), LID, `${LID}@lid`, "please call me on this number");
  await copy("B", "R2", at(7, 11, 0), RINA, `${RINA}@c.us`, "please call me on this number");
  // A line only account B stored: not part of account A's report at all.
  await copy("B", "ONLYB", at(8, 9, 0), CUSTOMER, `${CUSTOMER}@c.us`, "Only B has this line, thanks");
}, 120_000);

afterAll(async () => {
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((r) => r.table_name);
  for (let pass = 0; pass < 6; pass++) {
    for (const name of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${name}" WHERE "projectId" = $1`, project.id).catch(() => undefined);
  }
  await rawPrisma.projectAccess.deleteMany({ where: { projectId: project.id } });
  await rawPrisma.project.deleteMany({ where: { id: project.id } });
  await rawPrisma.user.deleteMany({ where: { id: creatorId } });
  await rawPrisma.$disconnect();
});

const intelFor = (extra: Record<string, string>) =>
  inProject(async () => {
    const ctx = await loadReportContext({ ...PERIOD, ...extra }, NOW);
    return loadIntelligence(ctx);
  });
const messageNamed = (intel: Awaited<ReturnType<typeof intelFor>>, key: string) => intel.messages.find((m) => m.key.includes(key));

describe("B2: the account filter changes WHICH messages a report reads, never who sent them", () => {
  it("the Team Report credits Rina on either account (the reference)", async () => {
    for (const account of [id("A"), id("B")]) {
      const data = await inProject(() => loadTeamReport(parseTeamReportFilters({ ...PERIOD, account }, NOW), NOW));
      expect(data.result.summary.memberReplies, account).toBe(2);
      expect(data.result.summary.customerMessages, account).toBe(account === id("A") ? 1 : 2);
    }
  });

  it("Support Intelligence classifies Rina's reply as Rina with account A chosen, as with no account", async () => {
    const all = await intelFor({});
    const onA = await intelFor({ account: id("A") });
    for (const intel of [all, onA]) {
      const reply = messageNamed(intel, "R1");
      expect(reply?.actor).toBe("MEMBER");
      expect(reply?.memberId).toBe(id("rina"));
    }
    // The same messages, in the same order: the account filter narrows, it does not reclassify.
    const shape = (intel: typeof all) => intel.messages.filter((m) => !m.key.includes("ONLYB")).map((m) => [m.key, m.actor, m.memberId]);
    expect(shape(onA)).toEqual(shape(all));
  });

  it("the account filter still narrows to the chosen account's own messages", async () => {
    const onA = await intelFor({ account: id("A") });
    const onB = await intelFor({ account: id("B") });
    expect(messageNamed(onA, "ONLYB")).toBeUndefined();
    expect(messageNamed(onB, "ONLYB")?.actor).toBe("CUSTOMER");
    expect(messageNamed(onB, "R1")?.memberId).toBe(id("rina"));
  });

  it("Calls names Rina, not a customer, with account A chosen", async () => {
    for (const extra of [{}, { account: id("A") }, { account: id("B") }]) {
      const report = await inProject(async () => (await buildReport("calls", { ...PERIOD, ...extra }, NOW)).report);
      const rows = report.tables.find((t) => t.id === "calls")!.rows;
      expect(rows.length, JSON.stringify(extra)).toBe(1);
      expect(rows[0]!.cells[2], JSON.stringify(extra)).toBe("Rina B2");
    }
  });

});
