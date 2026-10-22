import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Prisma } from "@prisma/client";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { runWithProject, type ActiveProject } from "@/server/projectContext";
import { messageKeySql, preferSenderCopySql } from "@/server/messageIdentity";
import { loadTeamReport, parseTeamReportFilters } from "@/server/teamReport";
import { loadPersonalReport } from "@/server/personalReport";
import {
  computeTeamReport,
  createSenderResolver,
  INTELLIGENCE_SQL_PREFILTER,
  outgoingActorFor,
  type ReportMessage,
} from "@support-automation/shared";

/**
 * Phase 2, Stage 9 (PHASE2.md; Workstream M): the Team Report at production scale, before and after
 * Stage 7. Skipped unless PHASE2_BENCHMARK=1; throwaway database only (requireTestDatabase).
 *
 * Seeds one project like the live one: 1,800 groups on two of our numbers, a month of traffic
 * (~150,000 stored rows, a fifth of the customer lines stored by both numbers), 20 team members, and
 * an OutboundMessage behind half of the business replies. Then times the loader's SQL as it was at
 * HEAD (spelled out inline, because it no longer exists in the code) against the three queries it
 * runs now, and the whole loader for a day, a week, a month, and five months at once.
 */
const RUN = process.env.PHASE2_BENCHMARK === "1";
const results: Record<string, unknown> = {};
const tag = randomUUID().replace(/-/g, "").slice(0, 8);
let project: ActiveProject;
let userId = "";
const GROUPS = 1800;
const DAYS = 30;
/** 1 Sep 2025 00:00 Asia/Dhaka. */
const START = Date.UTC(2025, 7, 31, 18, 0, 0);
const DAY_MS = 86_400_000;

async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await work();
  return { value, ms: Math.round(performance.now() - started) };
}

beforeAll(async () => {
  if (!RUN) return;
  const user = await rawPrisma.user.create({ data: { username: `bench_${tag}`, email: `bench_${tag}@example.test`, name: "Bench", passwordHash: "x" } });
  userId = user.id;
  const created = await createProjectWithDefaults({ name: `Bench ${tag}`, slug: `bench-${tag}`, status: "ACTIVE", creatorUserId: user.id }, rawPrisma);
  project = { id: created.id, slug: created.slug, name: `Bench ${tag}`, status: "ACTIVE" };
  const pid = project.id;
  const a = await rawPrisma.whatsAppAccount.create({ data: { projectId: pid, label: "Bench A", status: "CONNECTED", phoneNumber: "8801500000001" } });
  const b = await rawPrisma.whatsAppAccount.create({ data: { projectId: pid, label: "Bench B", status: "CONNECTED", phoneNumber: "8801500000002" } });
  const wgids = Array.from({ length: GROUPS }, (_, i) => `1203630${tag}${String(i).padStart(5, "0")}@g.us`);
  await rawPrisma.whatsAppGroup.createMany({ data: wgids.map((w, i) => ({ projectId: pid, accountId: a.id, whatsappGroupId: w, name: `Bench ${i}`, isActive: true })) });
  await rawPrisma.whatsAppGroup.createMany({ data: wgids.map((w, i) => ({ projectId: pid, accountId: b.id, whatsappGroupId: w, name: `Bench ${i}`, isActive: true })) });
  const groupIdA = new Map((await rawPrisma.whatsAppGroup.findMany({ where: { accountId: a.id }, select: { id: true, whatsappGroupId: true } })).map((g) => [g.whatsappGroupId, g.id]));
  const groupIdB = new Map((await rawPrisma.whatsAppGroup.findMany({ where: { accountId: b.id }, select: { id: true, whatsappGroupId: true } })).map((g) => [g.whatsappGroupId, g.id]));
  const members = Array.from({ length: 20 }, (_, i) => `88017${String(10_000_000 + i)}`);
  await rawPrisma.internalTeamMember.createMany({ data: members.map((phone, i) => ({ projectId: pid, name: `Member ${i}`, phoneNumber: `+${phone}`, role: "Support" })) });

  // A deterministic month: each active group gets conversations of customer lines, then a reply.
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2_147_483_648) / 2_147_483_648);
  const messages: Prisma.MessageCreateManyInput[] = [];
  const outbound: Prisma.OutboundMessageCreateManyInput[] = [];
  let n = 0;
  const flush = async () => {
    if (messages.length) await rawPrisma.message.createMany({ data: messages.splice(0) });
    if (outbound.length) await rawPrisma.outboundMessage.createMany({ data: outbound.splice(0) });
  };
  for (let day = 0; day < DAYS; day++) {
    for (let c = 0; c < 1700; c++) {
      const w = wgids[Math.floor(rand() * GROUPS)]!;
      let at = START + day * DAY_MS + Math.floor(rand() * DAY_MS * 0.9);
      const customer = `88019${String(Math.floor(rand() * 1e8)).padStart(8, "0")}`;
      const lines = 1 + Math.floor(rand() * 3);
      for (let l = 0; l < lines; l++) {
        const key = `C${n++}`;
        const both = rand() < 0.2;
        for (const [acct, gid] of both ? [[a.id, groupIdA.get(w)!], [b.id, groupIdB.get(w)!]] : [[a.id, groupIdA.get(w)!]]) {
          messages.push({ projectId: pid, accountId: acct as string, groupId: gid as string, chatId: w, whatsappMessageId: `false_${w}_${key}_${customer}@c.us`, senderPhone: customer, senderJid: `${customer}@c.us`, direction: "INCOMING", body: "my connection is slow", normalizedBody: "my connection is slow", timestampWa: new Date(at), processingStatus: "PROCESSED" });
        }
        at += 30_000 + Math.floor(rand() * 120_000);
      }
      at += Math.floor(rand() * 3_600_000);
      const key = `R${n++}`;
      if (rand() < 0.55) {
        const member = members[Math.floor(rand() * members.length)]!;
        messages.push({ projectId: pid, accountId: a.id, groupId: groupIdA.get(w)!, chatId: w, whatsappMessageId: `false_${w}_${key}_${member}@c.us`, senderPhone: member, senderJid: `${member}@c.us`, direction: "INCOMING", body: "checking now", normalizedBody: "checking now", timestampWa: new Date(at), processingStatus: "PROCESSED" });
      } else {
        const wamid = `true_${w}_${key}`;
        messages.push({ projectId: pid, accountId: a.id, groupId: groupIdA.get(w)!, chatId: w, whatsappMessageId: wamid, senderPhone: "8801500000001", senderJid: "8801500000001@c.us", direction: "OUTGOING", body: "we are on it", normalizedBody: "we are on it", timestampWa: new Date(at), processingStatus: "PROCESSED" });
        if (rand() < 0.5) {
          outbound.push({ projectId: pid, accountId: a.id, chatId: w, toPhone: w, body: "we are on it", actionType: rand() < 0.5 ? "AUTO_REPLY" : "MANUAL_REPLY", idempotencyKey: `bench-${tag}-${key}`, status: "SENT", sentAt: new Date(at), scheduledAt: new Date(at), providerMessageId: wamid });
        }
      }
      if (messages.length >= 5000) await flush();
    }
  }
  // Personal chats (unified reporting WP6): 2,000 one-to-one chats on the first number over the same month, a
  // customer line and, for most, a reply from the phone — about 8,000 rows beside the 150,000 group ones.
  for (let c = 0; c < 2000; c++) {
    const chat = `88018${String(10_000_000 + c)}@c.us`;
    let at = START + Math.floor(rand() * DAY_MS * 0.9 * DAYS);
    for (let l = 0; l < 4; l++) {
      const key = `P${n++}`;
      const fromMe = l % 2 === 1 && rand() < 0.8;
      messages.push({ projectId: pid, accountId: a.id, groupId: null, chatId: chat, whatsappMessageId: `${fromMe ? "true" : "false"}_${chat}_${key}`, senderPhone: fromMe ? "8801500000001" : chat.split("@")[0]!, senderJid: fromMe ? "8801500000001@c.us" : chat, direction: fromMe ? "OUTGOING" : "INCOMING", body: "ok", normalizedBody: "ok", timestampWa: new Date(at), processingStatus: "PROCESSED" });
      at += 60_000 + Math.floor(rand() * 3_600_000);
    }
    if (messages.length >= 5000) await flush();
  }
  await flush();
  await rawPrisma.$executeRawUnsafe(`ANALYZE "Message"`);
  await rawPrisma.$executeRawUnsafe(`ANALYZE "OutboundMessage"`);
  results.seeded = {
    storedRows: await rawPrisma.message.count({ where: { projectId: pid } }),
    outboundRows: await rawPrisma.outboundMessage.count({ where: { projectId: pid } }),
    groups: GROUPS,
    accounts: 2,
    days: DAYS,
  };
}, 900_000);

afterAll(async () => {
  if (!RUN) return;
  if (process.env.PHASE2_BENCHMARK_OUT) writeFileSync(process.env.PHASE2_BENCHMARK_OUT, JSON.stringify(results, null, 2));
  console.log(`[benchmark] ${JSON.stringify(results, null, 2)}`);
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((row) => row.table_name);
  for (let pass = 0; pass < 6; pass++) {
    for (const name of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${name}" WHERE "projectId" = $1`, project.id).catch(() => undefined);
  }
  await rawPrisma.project.deleteMany({ where: { id: project.id } });
  await rawPrisma.user.deleteMany({ where: { id: userId } });
  await rawPrisma.$disconnect();
}, 600_000);

const report = (params: Record<string, string>) => runWithProject(project, () => loadTeamReport(parseTeamReportFilters(params, new Date(START + 40 * DAY_MS)), new Date(START + 40 * DAY_MS)));

describe.skipIf(!RUN)("Team Report at production scale", () => {
  it("SQL before (HEAD) and after Stage 7, for the month", async () => {
    const start = new Date(START);
    const lookaheadEnd = new Date(START + DAYS * DAY_MS + DAY_MS);
    // HEAD's query, verbatim apart from the inlined project — the baseline.
    const before = await timed(() =>
      rawPrisma.$queryRaw<unknown[]>`
        SELECT DISTINCT ON (g."whatsappGroupId", ${messageKeySql()})
          g."whatsappGroupId" AS wgid, m."timestampWa" AS ts, m."direction"::text AS direction,
          m."isFromTeamMember" AS "fromTeam", m."senderPhone" AS sender, m."senderJid" AS "senderJid"
        FROM "Message" m
        JOIN "WhatsAppGroup" g ON g."id" = m."groupId"
        WHERE m."timestampWa" >= ${start} AND m."timestampWa" < ${lookaheadEnd}
          AND m."projectId" = ${project.id}
        ORDER BY g."whatsappGroupId", ${messageKeySql()}, ${preferSenderCopySql()}, m."timestampWa", m."id"`,
    );
    // The whole loader now (three queries + classification + both wait models), for comparison.
    const after = await timed(() => report({ period: "month", date: "2025-09-15" }));
    expect(after.value.result.summary.waits).toBeGreaterThan(0);
    results.monthSql = { headMainQueryMs: before.ms, headRows: before.value.length, newLoaderTotalMs: after.ms };
  }, 600_000);

  it("where the time goes: HEAD's loader against the new one, the same harness for both", async () => {
    const start = new Date(START);
    const end = new Date(START + DAYS * DAY_MS);
    const lookaheadEnd = new Date(end.getTime() + DAY_MS);
    const contextStart = new Date(START - 4 * 3_600_000);
    const members = await rawPrisma.internalTeamMember.findMany({ where: { projectId: project.id }, select: { id: true, phoneNumber: true, whatsappId: true } });
    const options = {
      rangeStart: start.getTime(),
      rangeEnd: end.getTime(),
      now: START + 40 * DAY_MS,
      idleGapMs: 120 * 60_000,
      missedAfterMs: () => 30 * 60_000,
      assignedMemberFor: () => null,
      memberId: null,
      granularity: "day" as const,
    };
    type Row = { wgid: string; ts: Date; direction: string; fromTeam: boolean; sender: string; senderJid: string | null; actionType?: string | null; ruleId?: string | null };
    const classify = (rows: Row[], withActor: boolean) => {
      const resolver = createSenderResolver(members);
      const out: ReportMessage[] = [];
      for (const row of rows) {
        if (row.direction === "SYSTEM") continue;
        if (row.direction === "OUTGOING") {
          out.push({ groupKey: row.wgid, ts: row.ts.getTime(), kind: "BUSINESS", memberId: null, ...(withActor ? { actor: outgoingActorFor(row.actionType ?? null, row.ruleId ?? null) } : {}) });
          continue;
        }
        const sender = resolver.resolve(row.sender, row.senderJid, withActor ? row.ts.getTime() : undefined);
        out.push({ groupKey: row.wgid, ts: row.ts.getTime(), kind: sender.memberId || sender.isRosterMember || row.fromTeam ? "MEMBER" : "CUSTOMER", memberId: sender.memberId });
      }
      return out;
    };

    const headSql = await timed(() =>
      rawPrisma.$queryRaw<Row[]>`
        SELECT DISTINCT ON (g."whatsappGroupId", ${messageKeySql()})
          g."whatsappGroupId" AS wgid, m."timestampWa" AS ts, m."direction"::text AS direction,
          m."isFromTeamMember" AS "fromTeam", m."senderPhone" AS sender, m."senderJid" AS "senderJid"
        FROM "Message" m
        JOIN "WhatsAppGroup" g ON g."id" = m."groupId"
        WHERE m."timestampWa" >= ${start} AND m."timestampWa" < ${lookaheadEnd}
          AND m."projectId" = ${project.id}
        ORDER BY g."whatsappGroupId", ${messageKeySql()}, ${preferSenderCopySql()}, m."timestampWa", m."id"`,
    );
    const headJs = await timed(async () => computeTeamReport(classify(headSql.value, false), options));

    // The per-row definition of provenance (Support Intelligence's form) — the reference.
    const newSql = await timed(() =>
      rawPrisma.$queryRaw<Row[]>`
        SELECT DISTINCT ON (g."whatsappGroupId", ${messageKeySql()})
          g."whatsappGroupId" AS wgid, m."whatsappMessageId" AS wamid, m."timestampWa" AS ts, m."direction"::text AS direction,
          m."isFromTeamMember" AS "fromTeam", m."senderPhone" AS sender, m."senderJid" AS "senderJid",
          CASE WHEN length(m."body") BETWEEN 1 AND 24 OR m."body" ~* ${INTELLIGENCE_SQL_PREFILTER} THEN left(m."body", 400) END AS body,
          o."actionType"::text AS "actionType", o."ruleId" AS "ruleId", o."createdById" AS "createdById"
        FROM "Message" m
        JOIN "WhatsAppGroup" g ON g."id" = m."groupId"
        LEFT JOIN LATERAL (
          SELECT ob."actionType", ob."ruleId", ob."createdById" FROM "OutboundMessage" ob
          WHERE m."direction" = 'OUTGOING' AND ob."providerMessageId" = m."whatsappMessageId" AND ob."projectId" = ${project.id}
          ORDER BY ob."createdAt" DESC LIMIT 1
        ) o ON true
        WHERE m."timestampWa" >= ${contextStart} AND m."timestampWa" < ${lookaheadEnd}
          AND m."projectId" = ${project.id}
        ORDER BY g."whatsappGroupId", ${messageKeySql()}, ${preferSenderCopySql()}, m."timestampWa", m."id"`,
    );
    // What the loader ships: the sends joined once (hash) instead of probed per row, and the text read
    // only where a CUSTOMER can be (incoming, not stamped as staff).
    const hashJoin = await timed(() =>
      rawPrisma.$queryRaw<Row[]>`
        SELECT DISTINCT ON (g."whatsappGroupId", ${messageKeySql()})
          g."whatsappGroupId" AS wgid, m."whatsappMessageId" AS wamid, m."timestampWa" AS ts, m."direction"::text AS direction,
          m."isFromTeamMember" AS "fromTeam", m."senderPhone" AS sender, m."senderJid" AS "senderJid",
          CASE WHEN m."direction" = 'INCOMING' AND NOT m."isFromTeamMember" AND (length(m."body") BETWEEN 1 AND 24 OR m."body" ~* ${INTELLIGENCE_SQL_PREFILTER}) THEN left(m."body", 400) END AS body,
          o."actionType"::text AS "actionType", o."ruleId" AS "ruleId", o."createdById" AS "createdById"
        FROM "Message" m
        JOIN "WhatsAppGroup" g ON g."id" = m."groupId"
        LEFT JOIN (
          SELECT DISTINCT ON (ob."providerMessageId") ob."providerMessageId", ob."actionType", ob."ruleId", ob."createdById"
          FROM "OutboundMessage" ob
          WHERE ob."projectId" = ${project.id} AND ob."providerMessageId" IS NOT NULL
          ORDER BY ob."providerMessageId", ob."createdAt" DESC
        ) o ON m."direction" = 'OUTGOING' AND o."providerMessageId" = m."whatsappMessageId"
        WHERE m."timestampWa" >= ${contextStart} AND m."timestampWa" < ${lookaheadEnd}
          AND m."projectId" = ${project.id}
        ORDER BY g."whatsappGroupId", ${messageKeySql()}, ${preferSenderCopySql()}, m."timestampWa", m."id"`,
    );
    // Same answer as the shipped query, row for row, on everything a report reads.
    const key = (r: Row & { body?: string | null }) => `${r.wgid}|${r.ts.getTime()}|${r.direction}|${r.actionType ?? ""}|${r.ruleId ?? ""}`;
    expect(hashJoin.value.map(key)).toEqual(newSql.value.map(key));
    const newJs = await timed(async () => computeTeamReport(classify(hashJoin.value, true), options));
    results.breakdown = {
      headSqlMs: headSql.ms,
      headComputeMs: headJs.ms,
      headTotalMs: headSql.ms + headJs.ms,
      perRowProvenanceSqlMs: newSql.ms,
      shippedSqlMs: hashJoin.ms,
      shippedComputeMs: newJs.ms,
      shippedTotalMs: hashJoin.ms + newJs.ms,
      rows: hashJoin.value.length,
    };
  }, 900_000);

  it("the earlier-message context and provenance use their indexes", async () => {
    const start = new Date(START + 10 * DAY_MS);
    const plan = await rawPrisma.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(
      `EXPLAIN (ANALYZE, BUFFERS) SELECT p."timestampWa" FROM (SELECT DISTINCT m."groupId" FROM "Message" m WHERE m."projectId" = $1 AND m."timestampWa" >= $2 AND m."timestampWa" < $3) r
       CROSS JOIN LATERAL (SELECT x."timestampWa" FROM "Message" x WHERE x."groupId" = r."groupId" AND x."projectId" = $1 AND x."timestampWa" < $2 AND x."direction" <> 'SYSTEM' ORDER BY x."timestampWa" DESC LIMIT 1) p`,
      project.id,
      start,
      new Date(start.getTime() + DAY_MS),
    );
    const text = plan.map((row) => row["QUERY PLAN"]).join("\n");
    expect(text).toMatch(/Index Scan Backward using "Message_groupId_timestampWa_idx"/);
    const outboundPlan = await rawPrisma.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(
      `EXPLAIN SELECT 1 FROM "OutboundMessage" ob WHERE ob."providerMessageId" = $1 AND ob."projectId" = $2`,
      "x",
      project.id,
    );
    expect(outboundPlan.map((row) => row["QUERY PLAN"]).join("\n")).toMatch(/OutboundMessage_providerMessageId_idx/);
    results.contextPlan = text.split("\n").filter((line) => /Index|Execution Time|Planning Time/.test(line)).map((line) => line.trim());
  }, 120_000);

  it("the personal report over 31 days, and the plan of its earlier-message probe", async () => {
    const now = new Date(START + 40 * DAY_MS);
    const personal = await timed(() => runWithProject(project, () => loadPersonalReport(parseTeamReportFilters({ period: "month", date: "2025-09-15", scope: "personal" }, now), now)));
    expect(personal.value.result.summary.conversations).toBeGreaterThan(0);
    const start = new Date(START + 10 * DAY_MS);
    const plan = await rawPrisma.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(
      `EXPLAIN (ANALYZE, BUFFERS) SELECT p."timestampWa" FROM (SELECT DISTINCT m."accountId" AS aid, m."chatId" AS chat FROM "Message" m WHERE m."projectId" = $1 AND m."groupId" IS NULL AND (m."chatId" LIKE '%@c.us' OR m."chatId" LIKE '%@lid') AND m."timestampWa" >= $2 AND m."timestampWa" < $3) r
       CROSS JOIN LATERAL (SELECT x."timestampWa" FROM "Message" x WHERE x."projectId" = $1 AND x."accountId" = r.aid AND x."groupId" IS NULL AND x."chatId" = r.chat AND x."timestampWa" < $2 AND x."direction" <> 'SYSTEM' ORDER BY x."timestampWa" DESC LIMIT 1) p`,
      project.id,
      start,
      new Date(start.getTime() + DAY_MS),
    );
    const text = plan.map((row) => row["QUERY PLAN"]).join("\n");
    // Generous: this guards against a scan that grows with the whole table, not against a slow laptop.
    expect(personal.ms).toBeLessThan(60_000);
    results.personal = {
      monthMs: personal.ms,
      conversations: personal.value.result.summary.conversations,
      customerMessages: personal.value.result.summary.customerMessages,
      storedCopies: personal.value.reliabilityCounts.storedCopies,
      earlierProbePlan: text.split("\n").filter((line) => /Index|Seq Scan|Execution Time|Planning Time/.test(line)).map((line) => line.trim()),
    };
  }, 600_000);

  it("the whole loader: a day, a week, a month, and five months at once", async () => {
    const day = await timed(() => report({ period: "day", date: "2025-09-15" }));
    const week = await timed(() => report({ period: "week", date: "2025-09-15" }));
    const heapBefore = process.memoryUsage().heapUsed;
    const month = await timed(() => report({ period: "month", date: "2025-09-15" }));
    const heapMb = Math.round((process.memoryUsage().heapUsed - heapBefore) / 1_048_576);
    const parallel = await timed(() => Promise.all(Array.from({ length: 5 }, () => report({ period: "month", date: "2025-09-15" }))));
    // Days add up to the month, at scale.
    const days = await Promise.all(Array.from({ length: DAYS }, (_, i) => report({ period: "day", date: `2025-09-${String(i + 1).padStart(2, "0")}` })));
    const sum = days.reduce((total, d) => total + d.result.summary.waits, 0);
    expect(sum).toBe(month.value.result.summary.waits);
    results.loader = {
      dayMs: day.ms,
      weekMs: week.ms,
      monthMs: month.ms,
      monthHeapGrowthMb: heapMb,
      fiveMonthsInParallelMs: parallel.ms,
      monthLogicalMessages: month.value.reliabilityCounts.logicalMessages,
      monthStoredCopies: month.value.reliabilityCounts.storedCopies,
      monthWaits: month.value.result.summary.waits,
      sumOfDailyWaits: sum,
      firstReplyBy: month.value.response.firstReplyBy,
    };
  }, 900_000);
});
