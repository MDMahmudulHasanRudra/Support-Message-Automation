import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { logicalMessageKey } from "@support-automation/shared";
import { runWithProject, type ActiveProject } from "@/server/projectContext";
import { prisma } from "@/server/db";
import { messageKeySql } from "@/server/messageIdentity";
import { loadTeamReport, parseTeamReportFilters } from "@/server/teamReport";
import { loadLastActivity, loadRoster } from "@/server/reports/groupReports";
import type { ReportContext } from "@/server/reports/context";
import { getContactProfile, getGroupProfile } from "@/server/chatProfiles";
import { getFirstResponseStats } from "@/server/supportActivityReports";

/**
 * WHATSAPP_IDENTITY.md, against real rows: the Team Report counts each WhatsApp message once
 * whichever of our accounts stored it, and credits a message to a team member only when the one
 * identity rule names exactly one.
 *
 * Each case below failed against the loader before the rule existed:
 *  - our own post, seen by our second number, was counted again as a CUSTOMER message;
 *  - a sender whose WhatsApp id and phone named two different members was credited to whichever
 *    member's name sorted first;
 *  - a message carrying the GROUP's id as its sender was credited to a member whose digits agreed.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const D = "2025-04-09";
/** A Dhaka wall-clock time on D, as an instant. */
const t = (hh: number, mm: number) => new Date(Date.UTC(2025, 3, 9, hh - 6, mm));
const NOW = new Date();
const WGID = `120363${Date.now()}${Math.floor(Math.random() * 1000)}@g.us`;
const lid = () => `${Math.floor(1e14 + Math.random() * 8e14)}`;
const phone = () => `8801${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;

let project: ActiveProject;
let userId: string;
const ids = { accountA: "", accountB: "", groupA: "", groupB: "", rakib: "", bipul: "", sara: "" };
const people = { customerLid: lid(), accountALid: lid(), rakibLid: lid(), saraPhone: phone() };

async function message(input: {
  groupRow: "A" | "B";
  wamid: string;
  senderPhone: string;
  senderJid: string | null;
  direction: "INCOMING" | "OUTGOING";
  at: Date;
  body: string;
}) {
  return rawPrisma.message.create({
    data: {
      projectId: project.id,
      accountId: input.groupRow === "A" ? ids.accountA : ids.accountB,
      groupId: input.groupRow === "A" ? ids.groupA : ids.groupB,
      chatId: WGID,
      whatsappMessageId: input.wamid,
      senderPhone: input.senderPhone,
      senderJid: input.senderJid,
      isFromTeamMember: false,
      direction: input.direction,
      body: input.body,
      normalizedBody: input.body,
      timestampWa: input.at,
      processingStatus: "PROCESSED",
    },
  });
}

beforeAll(async () => {
  const user = await rawPrisma.user.create({
    data: { username: `ident_${tag}`, email: `ident_${tag}@example.test`, name: "Identity", passwordHash: "x" },
  });
  userId = user.id;
  const created = await createProjectWithDefaults(
    { name: `Identity ${tag}`, slug: `ident-${tag}`, status: "ACTIVE", creatorUserId: userId },
    rawPrisma,
  );
  project = { id: created.id, slug: created.slug, name: `Identity ${tag}`, status: "ACTIVE" };
  const pid = { projectId: project.id };

  const a = await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `Ident A ${tag}`, status: "CONNECTED" } });
  const b = await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `Ident B ${tag}`, status: "CONNECTED" } });
  ids.accountA = a.id;
  ids.accountB = b.id;
  // One WhatsApp group, both of our numbers in it: one WhatsAppGroup row per account.
  const groupFor = (accountId: string) =>
    rawPrisma.whatsAppGroup.create({
      data: { ...pid, accountId, whatsappGroupId: WGID, name: `Ident group ${tag}`, isMonitored: true, isActive: true, lastSyncedAt: new Date() },
    });
  ids.groupA = (await groupFor(a.id)).id;
  ids.groupB = (await groupFor(b.id)).id;

  // "Aaron" sorts before "Bipul": the old first-wins map credited the conflict to him.
  const rakib = await rawPrisma.internalTeamMember.create({
    data: { ...pid, name: `Aaron Rakib ${tag}`, phoneNumber: phone(), whatsappId: people.rakibLid, role: "Support" },
  });
  // Bipul's record holds Rakib's LID as its "phone number" — the WhatsApp id and the phone disagree.
  const bipul = await rawPrisma.internalTeamMember.create({
    data: { ...pid, name: `Bipul ${tag}`, phoneNumber: people.rakibLid, role: "Support" },
  });
  const sara = await rawPrisma.internalTeamMember.create({
    data: { ...pid, name: `Sara ${tag}`, phoneNumber: `+${people.saraPhone}`, role: "Support" },
  });
  ids.rakib = rakib.id;
  ids.bipul = bipul.id;
  ids.sara = sara.id;

  // 09:00 a customer asks — both of our numbers store it (same key, same author).
  for (const row of ["A", "B"] as const) {
    await message({
      groupRow: row,
      wamid: `false_${WGID}_K1${tag}_${people.customerLid}@lid`,
      senderPhone: people.customerLid,
      senderJid: `${people.customerLid}@lid`,
      direction: "INCOMING",
      at: t(9, 0),
      body: "internet is down",
    });
  }
  // 09:05 our number A replies. A stores its own OUTGOING copy; B receives the same message from
  // A's LID as INCOMING. One message, two rows, two different stored ids.
  await message({
    groupRow: "A",
    wamid: `true_${WGID}_K2${tag}_${people.accountALid}@lid`,
    senderPhone: people.accountALid,
    senderJid: `${people.accountALid}@lid`,
    direction: "OUTGOING",
    at: t(9, 5),
    body: "we are checking",
  });
  await message({
    groupRow: "B",
    wamid: `false_${WGID}_K2${tag}_${people.accountALid}@lid`,
    senderPhone: people.accountALid,
    senderJid: `${people.accountALid}@lid`,
    direction: "INCOMING",
    at: t(9, 5),
    body: "we are checking",
  });
  // 09:30 our number B also replies — on its own copy only.
  await message({
    groupRow: "B",
    wamid: `true_${WGID}_K2B${tag}_444400000000002@lid`,
    senderPhone: "444400000000002",
    senderJid: "444400000000002@lid",
    direction: "OUTGOING",
    at: t(9, 30),
    body: "any update?",
  });
  // 10:00 the conflicted colleague writes.
  await message({
    groupRow: "A",
    wamid: `false_${WGID}_K3${tag}_${people.rakibLid}@lid`,
    senderPhone: people.rakibLid,
    senderJid: `${people.rakibLid}@lid`,
    direction: "INCOMING",
    at: t(10, 0),
    body: "fixed now",
  });
  // 11:00 a message whose author WhatsApp did not name: the provider fell back to the GROUP id —
  // here one whose digits happen to equal Sara's number.
  await message({
    groupRow: "A",
    wamid: `false_${WGID}_K4${tag}`,
    senderPhone: people.saraPhone,
    senderJid: `${people.saraPhone}@g.us`,
    direction: "INCOMING",
    at: t(11, 0),
    body: "?",
  });
  // 12:00 Sara writes, from her phone-number id: credited to her.
  await message({
    groupRow: "A",
    wamid: `false_${WGID}_K5${tag}_${people.saraPhone}@c.us`,
    senderPhone: people.saraPhone,
    senderJid: `${people.saraPhone}@c.us`,
    direction: "INCOMING",
    at: t(12, 0),
    body: "following up",
  });
}, 60_000);

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

const report = () =>
  runWithProject(project, () => loadTeamReport(parseTeamReportFilters({ period: "day", date: D }, NOW), NOW));

describe("one WhatsApp message, stored by two of our numbers", () => {
  it("is counted once, as the business's reply — never again as a customer message", async () => {
    const data = await report();
    const at905 = data.messages.filter((m) => m.ts === t(9, 5).getTime());
    expect(at905).toEqual([{ groupKey: WGID, ts: t(9, 5).getTime(), kind: "BUSINESS", memberId: null }]);
    // And the customer's 09:00 question, stored twice, is one message too.
    expect(data.messages.filter((m) => m.ts === t(9, 0).getTime())).toHaveLength(1);
  });

  it("leaves the customer one wait, answered by the reply", async () => {
    const data = await report();
    // Before 10:00: the question and our reply. A phantom "customer" copy of the reply used to
    // open a second wait here that nothing could answer.
    const waits = data.result.waits.filter((w) => w.groupKey === WGID && w.askedAt < t(10, 0).getTime());
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({ askedAt: t(9, 0).getTime(), repliedAt: t(9, 5).getTime() });
  });

  it("names the sending account's copy as the group's last activity, not 'Customer · <our id>'", async () => {
    // Only B's copy within the window ending 09:06: B stores the reply as INCOMING from A's LID,
    // and A's own copy has the same timestamp. The tie must go to the sender's copy.
    const ctx = { rangeEnd: t(9, 6).getTime(), filters: { accountId: null } } as unknown as ReportContext;
    const last = await runWithProject(project, () => loadLastActivity(ctx, [WGID]));
    expect(last.get(WGID)?.direction).toBe("OUTGOING");
  });
});

describe("who sent it", () => {
  it("credits nobody when the WhatsApp id and the phone number name different members", async () => {
    const data = await report();
    const conflicted = data.messages.find((m) => m.ts === t(10, 0).getTime());
    // Still a team member's message (it closes nothing as a customer would), credited to nobody.
    expect(conflicted).toMatchObject({ kind: "MEMBER", memberId: null });
  });

  it("never credits a message whose sender is the group's own id", async () => {
    const data = await report();
    expect(data.messages.find((m) => m.ts === t(11, 0).getTime())).toMatchObject({ kind: "CUSTOMER", memberId: null });
  });

  it("credits a clean match to the member, however the number was typed", async () => {
    const data = await report();
    expect(data.messages.find((m) => m.ts === t(12, 0).getTime())).toMatchObject({ kind: "MEMBER", memberId: ids.sara });
  });

  it("describes the sender the same way in the group reports", async () => {
    const ctx = { data: { teams: [] } } as unknown as ReportContext;
    const roster = await runWithProject(project, () => loadRoster(ctx));
    const base = { at: 0, senderName: null, direction: "INCOMING" };
    expect(roster.describeSender({ ...base, senderPhone: people.rakibLid, senderJid: `${people.rakibLid}@lid` })).toBe(
      "Team member (identity needs review)",
    );
    expect(roster.describeSender({ ...base, senderPhone: people.saraPhone, senderJid: `${people.saraPhone}@c.us` })).toBe(`Team member · Sara ${tag}`);
  });
});

describe("first response time (Team Performance) counts one conversation once", () => {
  it("measures the customer's wait once, from the first reply by any of our numbers", async () => {
    // Per account copy, B's copy saw our A-reply as a customer line and measured the 09:00 wait to
    // B's own 09:30 reply: two waits, 5 and 30 minutes. It is one wait, answered at 09:05.
    const stats = await runWithProject(project, () => getFirstResponseStats({ start: t(8, 0), end: t(10, 0) }));
    expect(stats).toMatchObject({ answered: 1, medianSeconds: 300, slowestSeconds: 300 });
  });
});

describe("the SQL message key is the shared rule", () => {
  it("agrees with logicalMessageKey on every id shape", async () => {
    const rows = await runWithProject(project, () =>
      prisma.$queryRaw<Array<{ chatId: string; wamid: string; key: string }>>`
        SELECT m."chatId" AS "chatId", m."whatsappMessageId" AS wamid, ${messageKeySql()} AS key
        FROM "Message" m WHERE m."projectId" = ${project.id}`,
    );
    expect(rows.length).toBeGreaterThan(5);
    for (const row of rows) expect(`${row.chatId}|${row.key}`).toBe(logicalMessageKey(row.chatId, row.wamid));
    // An id not in OpenWA's shape is its own key.
    const odd = await runWithProject(project, () =>
      prisma.$queryRaw<Array<{ key: string }>>`
        SELECT ${messageKeySql("x")} AS key FROM (VALUES ('wamid-1'), ('true_nodomain_ABC'), ('false_g@g.us_')) AS x("whatsappMessageId")`,
    );
    expect(odd.map((r) => r.key)).toEqual(["wamid-1", "true_nodomain_ABC", "false_g@g.us_"]);
    for (const id of ["wamid-1", "true_nodomain_ABC", "false_g@g.us_"]) expect(logicalMessageKey("c", id)).toBe(`c|${id}`);
  });
});

describe("WhatsApp Chat's contact and group panels", () => {
  // A login with no role: it can read the panels the page already let it open, and nothing more.
  const session = () => ({ userId, username: `ident_${tag}`, email: `ident_${tag}@example.test`, name: "Identity" });

  it("describes a LID sender without inventing a phone number, and names the roster conflict", async () => {
    const profile = await runWithProject(project, () => getContactProfile(session(), ids.accountA, `${people.rakibLid}@lid`));
    expect(profile).toMatchObject({ kind: "LID", phone: null, whatsappId: people.rakibLid, messageCount: 1, isOurNumber: false });
    expect(profile!.roster.status).toBe("CONFLICT");
    expect(profile!.roster.member).toBeNull();
    expect(profile!.roster.candidates.map((c) => c.name).sort()).toEqual([`Aaron Rakib ${tag}`, `Bipul ${tag}`]);
    // No whatsapp.view / whatsapp.manage: no roster identifiers, no link form.
    expect(profile).toMatchObject({ canViewRoster: false, canLink: false, linkableMembers: [] });
  });

  it("counts a message two of our numbers stored once", async () => {
    const profile = await runWithProject(project, () => getContactProfile(session(), ids.accountA, `${people.customerLid}@lid`));
    expect(profile!.messageCount).toBe(1);
    expect(profile!.groups).toEqual([expect.objectContaining({ whatsappGroupId: WGID, messages: 1, groupId: ids.groupA })]);
  });

  it("shows a matched phone sender's number and member", async () => {
    const profile = await runWithProject(project, () => getContactProfile(session(), ids.accountA, `${people.saraPhone}@c.us`));
    expect(profile).toMatchObject({ kind: "PHONE", phone: `+${people.saraPhone}` });
    expect(profile!.roster.member).toMatchObject({ id: ids.sara, name: `Sara ${tag}`, phoneNumber: null });
  });

  it("refuses a group id as a contact", async () => {
    expect(await runWithProject(project, () => getContactProfile(session(), ids.accountA, WGID))).toBeNull();
  });

  it("lists people seen in the group from stored messages, our own number marked, never the group itself", async () => {
    const profile = await runWithProject(project, () => getGroupProfile(session(), ids.groupA));
    const byId = new Map(profile!.seen.map((p) => [p.senderId, p]));
    expect(byId.get(`${people.customerLid}@lid`)).toMatchObject({ messages: 1, memberName: null, status: "UNRESOLVED", phone: null });
    expect(byId.get(`${people.accountALid}@lid`)).toMatchObject({ isOurNumber: true });
    expect(byId.get(`${people.rakibLid}@lid`)?.status).toBe("CONFLICT");
    expect(profile!.seen.some((p) => p.senderId.endsWith("@g.us"))).toBe(false);
    expect(profile!.live).toEqual({ state: "NONE" });
    expect(profile!.canRequestLive).toBe(false);
  });
});
