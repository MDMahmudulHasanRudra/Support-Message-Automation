import { PrismaClient, Prisma } from "@prisma/client";
import {
  createSenderResolver,
  parseWhatsAppId,
  recoverSenderJid,
  SENDER_MATCH_LABELS,
  type SenderMatchStatus,
} from "@support-automation/shared";

/**
 * WhatsApp message reconciliation (WHATSAPP_IDENTITY.md §6). Hand-run, never scheduled.
 *
 *   pnpm --filter @support-automation/db reconcile:messages               # dry run: reads, changes nothing
 *   pnpm --filter @support-automation/db reconcile:messages --apply       # also backfills Message.senderJid
 *   ... --project <slug>   one project only        ... --json   machine-readable summary
 *
 * What it REPORTS, per project (nothing here is ever deleted, merged or rewritten):
 *  - stored rows that are copies of one WhatsApp message held by two of our accounts (expected —
 *    reports collapse them on the logical key), and copies inside ONE account (would be a real
 *    duplicate; the unique constraint should make it impossible);
 *  - rows whose `senderJid` is missing and can / cannot be recovered from the row itself;
 *  - timestamps outside any plausible range; group messages with no group row; messages whose
 *    sender is the group's own id (an unnamed author);
 *  - the identity status of every distinct incoming sender against TODAY's roster, with each
 *    CONFLICT / AMBIGUOUS sender named, so a person can fix the roster;
 *  - the roster's own collisions (two members sharing an identifier).
 *
 * What `--apply` CHANGES: only `Message.senderJid`, only where it is NULL, only to a value the row
 * itself proves (`recoverSenderJid`: an incoming group message's key names its author; an incoming
 * one-to-one message's chat is its sender). Idempotent and restartable — a second run finds nothing
 * left to fill. It never touches `senderPhone`, `isFromTeamMember` or any other column: the stamped
 * flag is the pipeline's record of what it decided at the time, and reports resolve identity at
 * read time instead (a stored attribution drifts the moment the roster is corrected).
 *
 * Reverting an apply: before the migration that added the column, no row had a value, so
 *   UPDATE "Message" SET "senderJid" = NULL WHERE "createdAt" < '<time the migration was deployed>';
 * restores the pre-apply state exactly. Each apply also writes one SystemLog row per project.
 */

const prisma = new PrismaClient();

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const JSON_OUT = args.includes("--json");
const projectSlug = (() => {
  const i = args.indexOf("--project");
  return i >= 0 ? (args[i + 1] ?? null) : null;
})();
const BATCH = 2000;
/** Older than WhatsApp itself, or more than a day after the row was stored: not a real send time. */
const EARLIEST_PLAUSIBLE = new Date("2009-01-01T00:00:00Z");
const FUTURE_TOLERANCE_MS = 24 * 3_600_000;

interface Row {
  id: string;
  chatId: string;
  whatsappMessageId: string;
  direction: "INCOMING" | "OUTGOING" | "SYSTEM";
  senderPhone: string;
  senderJid: string | null;
  groupId: string | null;
  timestampWa: Date;
  createdAt: Date;
}

interface ProjectSummary {
  project: string;
  messages: number;
  byDirection: Record<string, number>;
  senderJid: { present: number; recoverable: number; unrecoverable: number; filled: number };
  crossAccountCopies: { logicalMessages: number; extraRows: number };
  sameAccountDuplicates: number;
  invalidTimestamps: number;
  groupMessagesWithoutGroupRow: number;
  senderIsGroupItself: number;
  identity: {
    distinctIncomingSenders: number;
    messagesByStatus: Partial<Record<SenderMatchStatus, number>>;
    needsReview: Array<{ sender: string; status: SenderMatchStatus; members: string[]; messages: number }>;
    stampedFalseNowMember: number;
    stampedTrueNowUnresolved: number;
  };
  rosterCollisions: Array<{ identifier: string; status: SenderMatchStatus; members: string[] }>;
}

async function reconcileProject(project: { id: string; slug: string; name: string }, apply: boolean): Promise<ProjectSummary> {
  // Every member, deactivated ones included: history keeps its owner, exactly as the reports read it.
  const roster = await prisma.internalTeamMember.findMany({
    where: { projectId: project.id },
    select: { id: true, name: true, phoneNumber: true, whatsappId: true },
  });
  const resolver = createSenderResolver(roster);
  const nameOf = new Map(roster.map((m) => [m.id, m.name]));

  const summary: ProjectSummary = {
    project: `${project.name} (${project.slug})`,
    messages: 0,
    byDirection: {},
    senderJid: { present: 0, recoverable: 0, unrecoverable: 0, filled: 0 },
    crossAccountCopies: { logicalMessages: 0, extraRows: 0 },
    sameAccountDuplicates: 0,
    invalidTimestamps: 0,
    groupMessagesWithoutGroupRow: 0,
    senderIsGroupItself: 0,
    identity: { distinctIncomingSenders: 0, messagesByStatus: {}, needsReview: [], stampedFalseNowMember: 0, stampedTrueNowUnresolved: 0 },
    rosterCollisions: [],
  };

  // Roster collisions: every identifier a member holds, read through the rule.
  const seenCollision = new Set<string>();
  for (const member of roster) {
    for (const identifier of [member.whatsappId, member.phoneNumber]) {
      if (!identifier) continue;
      const result = resolver.resolve(identifier);
      if ((result.status === "CONFLICT" || result.status === "AMBIGUOUS") && !seenCollision.has(result.candidateIds.join(","))) {
        seenCollision.add(result.candidateIds.join(","));
        summary.rosterCollisions.push({ identifier, status: result.status, members: result.candidateIds.map((id) => nameOf.get(id) ?? id) });
      }
    }
  }

  // Copies of one logical message, in SQL (the same key as the reports). Keyed per chat.
  const keySql = Prisma.raw(
    `(CASE WHEN m."whatsappMessageId" ~ '^(true|false)_[^_]*@[^_]*_[^_]+' THEN split_part(m."whatsappMessageId", '_', 3) ELSE m."whatsappMessageId" END)`,
  );
  const [copies] = await prisma.$queryRaw<Array<{ logical: bigint; extra: bigint }>>`
    SELECT COUNT(*) AS logical, COALESCE(SUM(n - 1), 0) AS extra FROM (
      SELECT COUNT(*) AS n FROM "Message" m WHERE m."projectId" = ${project.id}
      GROUP BY m."chatId", ${keySql} HAVING COUNT(*) > 1
    ) c`;
  summary.crossAccountCopies = { logicalMessages: Number(copies?.logical ?? 0), extraRows: Number(copies?.extra ?? 0) };
  const [dups] = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(*) AS n FROM (
      SELECT 1 FROM "Message" m WHERE m."projectId" = ${project.id}
      GROUP BY m."accountId", m."chatId", ${keySql} HAVING COUNT(*) > 1
    ) d`;
  summary.sameAccountDuplicates = Number(dups?.n ?? 0);

  // Everything else in keyset batches, so a large table is never held in memory.
  const senders = new Map<string, { phone: string; jid: string | null; messages: number }>();
  let stampedRows: Array<{ senderKey: string; stamped: boolean }> = [];
  let cursor = "";
  for (;;) {
    const rows = await prisma.$queryRaw<Array<Row & { isFromTeamMember: boolean }>>`
      SELECT m."id", m."chatId", m."whatsappMessageId", m."direction"::text AS direction, m."senderPhone", m."senderJid",
             m."groupId", m."timestampWa", m."createdAt", m."isFromTeamMember"
      FROM "Message" m
      WHERE m."projectId" = ${project.id} AND m."id" > ${cursor}
      ORDER BY m."id"
      LIMIT ${BATCH}`;
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;

    const fills: Array<{ id: string; jid: string }> = [];
    for (const row of rows) {
      summary.messages += 1;
      summary.byDirection[row.direction] = (summary.byDirection[row.direction] ?? 0) + 1;

      let jid = row.senderJid;
      if (jid) summary.senderJid.present += 1;
      else {
        const recovered = recoverSenderJid(row);
        if (recovered) {
          summary.senderJid.recoverable += 1;
          fills.push({ id: row.id, jid: recovered });
          jid = recovered;
        } else summary.senderJid.unrecoverable += 1;
      }

      const ts = row.timestampWa.getTime();
      if (!Number.isFinite(ts) || ts < EARLIEST_PLAUSIBLE.getTime() || ts > row.createdAt.getTime() + FUTURE_TOLERANCE_MS) {
        summary.invalidTimestamps += 1;
      }
      const chat = parseWhatsAppId(row.chatId);
      if (chat?.kind === "GROUP" && !row.groupId) summary.groupMessagesWithoutGroupRow += 1;
      if (row.direction === "INCOMING" && chat?.kind === "GROUP") {
        const author = parseWhatsAppId(jid);
        if (author?.kind === "GROUP" || (!author && row.senderPhone === chat.user)) summary.senderIsGroupItself += 1;
      }

      if (row.direction === "INCOMING") {
        const key = `${row.senderPhone}\u0000${jid ?? ""}`;
        const entry = senders.get(key);
        if (entry) entry.messages += 1;
        else senders.set(key, { phone: row.senderPhone, jid, messages: 1 });
        stampedRows.push({ senderKey: key, stamped: row.isFromTeamMember });
      }
    }

    if (apply && fills.length) {
      // Only NULL is ever filled, so a re-run, or a row the live worker wrote meanwhile, is untouched.
      const values = Prisma.join(fills.map((f) => Prisma.sql`(${f.id}, ${f.jid})`));
      const updated = await prisma.$executeRaw`
        UPDATE "Message" AS m SET "senderJid" = v.jid
        FROM (VALUES ${values}) AS v(id, jid)
        WHERE m."id" = v.id AND m."projectId" = ${project.id} AND m."senderJid" IS NULL`;
      summary.senderJid.filled += updated;
    }

    // Fold the per-row stamps into counts now, so memory stays bounded by distinct senders.
    for (const s of stampedRows) {
      const sender = senders.get(s.senderKey)!;
      const result = resolver.resolve(sender.phone, sender.jid);
      if (!s.stamped && result.memberId) summary.identity.stampedFalseNowMember += 1;
      if (s.stamped && !result.isRosterMember) summary.identity.stampedTrueNowUnresolved += 1;
    }
    stampedRows = [];
  }

  summary.identity.distinctIncomingSenders = senders.size;
  for (const sender of senders.values()) {
    const result = resolver.resolve(sender.phone, sender.jid);
    summary.identity.messagesByStatus[result.status] = (summary.identity.messagesByStatus[result.status] ?? 0) + sender.messages;
    if (result.status === "CONFLICT" || result.status === "AMBIGUOUS") {
      summary.identity.needsReview.push({
        sender: sender.jid ?? sender.phone,
        status: result.status,
        members: result.candidateIds.map((id) => nameOf.get(id) ?? id),
        messages: sender.messages,
      });
    }
  }
  summary.identity.needsReview.sort((a, b) => b.messages - a.messages);

  if (apply) {
    await prisma.systemLog.create({
      data: {
        projectId: project.id,
        level: "INFO",
        scope: "reconcile-messages",
        message: `Message reconciliation: filled senderJid on ${summary.senderJid.filled} row(s) from what each row proves.`,
        metadata: { filled: summary.senderJid.filled, scanned: summary.messages } as Prisma.InputJsonValue,
      },
    });
  }
  return summary;
}

function print(summary: ProjectSummary) {
  const line = (label: string, value: unknown) => console.log(`  ${label.padEnd(46)} ${value}`);
  console.log(`\n=== ${summary.project}`);
  line("Stored messages", summary.messages);
  line("  by direction", JSON.stringify(summary.byDirection));
  line("Copies held by two of our accounts", `${summary.crossAccountCopies.logicalMessages} messages, ${summary.crossAccountCopies.extraRows} extra rows (expected; reports count once)`);
  line("Duplicates inside one account", summary.sameAccountDuplicates);
  line("senderJid present / recoverable / unknown", `${summary.senderJid.present} / ${summary.senderJid.recoverable} / ${summary.senderJid.unrecoverable}`);
  if (APPLY) line("senderJid filled now", summary.senderJid.filled);
  line("Implausible timestamps", summary.invalidTimestamps);
  line("Group messages with no group row", summary.groupMessagesWithoutGroupRow);
  line("Incoming with the group as sender", summary.senderIsGroupItself);
  line("Distinct incoming senders", summary.identity.distinctIncomingSenders);
  for (const [status, n] of Object.entries(summary.identity.messagesByStatus)) {
    line(`  ${SENDER_MATCH_LABELS[status as SenderMatchStatus]}`, `${n} messages`);
  }
  line("Stamped customer, now on the roster", `${summary.identity.stampedFalseNowMember} (sent before they were added — reports already count them)`);
  line("Stamped team member, now unresolved", `${summary.identity.stampedTrueNowUnresolved} (left the roster or changed identifiers)`);
  if (summary.rosterCollisions.length) {
    console.log("  Roster collisions — fix on Team Members:");
    for (const c of summary.rosterCollisions) console.log(`    ${c.status.padEnd(9)} ${c.identifier}: ${c.members.join(" / ")}`);
  }
  if (summary.identity.needsReview.length) {
    console.log("  Senders credited to nobody until the roster is fixed:");
    for (const s of summary.identity.needsReview.slice(0, 50)) {
      console.log(`    ${s.status.padEnd(9)} ${s.sender} (${s.messages} msgs): ${s.members.join(" / ")}`);
    }
  }
}

async function main() {
  const projects = await prisma.project.findMany({
    where: projectSlug ? { slug: projectSlug } : {},
    select: { id: true, slug: true, name: true },
    orderBy: { createdAt: "asc" },
  });
  if (projectSlug && projects.length === 0) throw new Error(`No project with slug "${projectSlug}".`);
  if (!JSON_OUT) console.log(APPLY ? "Reconciling (APPLY: fills Message.senderJid only)." : "Dry run: nothing will be changed. Pass --apply to backfill Message.senderJid.");

  const summaries: ProjectSummary[] = [];
  for (const project of projects) {
    const summary = await reconcileProject(project, APPLY);
    summaries.push(summary);
    if (!JSON_OUT) print(summary);
  }
  if (JSON_OUT) console.log(JSON.stringify({ apply: APPLY, projects: summaries }, null, 2));
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
