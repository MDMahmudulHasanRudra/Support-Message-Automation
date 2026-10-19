import { createSenderResolver, getDhakaDayRange, normalizePhoneNumber, whatsappIdKey } from "@support-automation/shared";
import { prisma } from "../db.js";
import { recordLoopTick, registerLoop } from "../health/loopLiveness.js";
import { currentProjectId, forEachProject } from "../project/context.js";
import { recomputeAttendanceDay } from "./attendance.js";

/**
 * Bringing stored attribution up to date after a team member's identifiers change (report accuracy
 * audit, 19 Oct 2026).
 *
 * Who sent a message is decided at READ time by every report since Phase 2, so the Team Report and
 * its siblings follow a roster change at once. Three things were still decided once, on arrival, and
 * never revisited — so after a colleague was added late, or their WhatsApp ID linked, their old
 * messages stayed "a customer's" there:
 *   1. `Message.isFromTeamMember` (the chat inbox's "waiting", and anything still reading the stamp);
 *   2. `SupportActivity.teamMemberId` (the Activity Feed and its export);
 *   3. Duty History's `TeamAttendanceDay` rows.
 * The Team Members actions queue an `IdentityReattribution` naming the identifiers whose meaning
 * changed and the members involved; this loop works through them, one at a time per project.
 *
 * The stamp is re-decided with EVERY member on the roster, active or not, honouring each member's
 * "count their messages from" date at the message's own time — "was this a colleague when they
 * wrote it", which is what the stamp has always meant. Deactivating somebody therefore never turns
 * their history into a customer's. Duty History is recomputed for the last ATTENDANCE_LOOKBACK_DAYS:
 * a timesheet older than that is history somebody has already signed off.
 *
 * Response Time episodes are NOT rewritten: an episode is the decision Support made as the wait
 * happened, and replaying a month of waits is not the same thing. The Team Report's Response SLA
 * reads messages at read time and already reflects the corrected roster.
 */

const LOOP_NAME = "identity-reattribution";
export const ATTENDANCE_LOOKBACK_DAYS = 120;
/** A RUNNING request older than this was interrupted (a restart) and is picked up again. */
const STUCK_MS = 30 * 60_000;
const MAX_ATTEMPTS = 3;

export function startIdentityReattributionProcessor(intervalMs = 30_000): NodeJS.Timeout {
  registerLoop(LOOP_NAME, intervalMs);
  let processing = false;
  return setInterval(() => {
    if (processing) return;
    processing = true;
    void forEachProject(LOOP_NAME, () => processNextReattribution())
      .catch((err) => console.error("[reattribution] unexpected error", err))
      .finally(() => {
        processing = false;
        recordLoopTick(LOOP_NAME, intervalMs);
      });
  }, intervalMs);
}

export interface ReattributionResult {
  restampedMessages: number;
  supportActivities: number;
  attendanceDays: number;
}

/** Claims and works the oldest pending request of the current project. False when there was none. */
export async function processNextReattribution(now: Date = new Date()): Promise<boolean> {
  await prisma.identityReattribution.updateMany({
    where: { status: "RUNNING", startedAt: { lt: new Date(now.getTime() - STUCK_MS) } },
    data: { status: "PENDING" },
  });
  const next = await prisma.identityReattribution.findFirst({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" } });
  if (!next) return false;
  const claimed = await prisma.identityReattribution.updateMany({
    where: { id: next.id, status: "PENDING" },
    data: { status: "RUNNING", startedAt: now, attempts: { increment: 1 } },
  });
  if (claimed.count === 0) return true; // another tick took it

  try {
    const result = await reattribute(next.identifiers, next.memberIds, now);
    await prisma.identityReattribution.update({
      where: { id: next.id },
      data: { status: "DONE", finishedAt: new Date(), result: { ...result }, error: null },
    });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    await prisma.identityReattribution.update({
      where: { id: next.id },
      data: next.attempts + 1 >= MAX_ATTEMPTS ? { status: "FAILED", finishedAt: new Date(), error: message.slice(0, 500) } : { status: "PENDING", error: message.slice(0, 500) },
    });
    console.error(`[reattribution] request ${next.id} failed (attempt ${next.attempts + 1})`, err);
  }
  return true;
}

/** Every stored `senderPhone` form an identifier can take: as written, digits only, and the id key. */
function senderForms(identifiers: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const value of identifiers) {
    const trimmed = String(value ?? "").trim();
    if (!trimmed) continue;
    forms.add(trimmed);
    const key = whatsappIdKey(trimmed);
    if (key) forms.add(key);
    const digits = normalizePhoneNumber(trimmed);
    if (digits) forms.add(digits);
    // A stored sender is digits only, so a local number's own digits may be what was stored.
    const raw = trimmed.replace(/\D/g, "");
    if (raw) forms.add(raw);
  }
  return [...forms];
}

export async function reattribute(identifiers: readonly string[], memberIds: readonly string[], now: Date = new Date()): Promise<ReattributionResult> {
  const projectId = currentProjectId();
  const forms = senderForms(identifiers);
  const result: ReattributionResult = { restampedMessages: 0, supportActivities: 0, attendanceDays: 0 };
  const roster = await prisma.internalTeamMember.findMany({ select: { id: true, phoneNumber: true, whatsappId: true, attributeFrom: true, status: true } });
  const resolver = createSenderResolver(roster);
  const attributeFromOf = new Map(roster.map((m) => [m.id, m.attributeFrom]));

  if (forms.length > 0) {
    const senders = await prisma.$queryRaw<Array<{ senderPhone: string; senderJid: string | null }>>`
      SELECT DISTINCT m."senderPhone", m."senderJid"
      FROM "Message" m
      WHERE m."projectId" = ${projectId} AND m."direction" = 'INCOMING' AND m."senderPhone" = ANY(${forms})`;

    for (const sender of senders) {
      const decided = resolver.resolve(sender.senderPhone, sender.senderJid);
      const jidMatch = sender.senderJid;
      // Staff from when: never (a customer), always, or from the earliest "count from" date among the
      // members this sender could be.
      let staffFrom: Date | null | "NEVER" = "NEVER";
      if (decided.isRosterMember) {
        const dates = decided.candidateIds.map((id) => attributeFromOf.get(id) ?? null);
        staffFrom = dates.some((d) => d === null) ? null : new Date(Math.min(...dates.map((d) => d!.getTime())));
      }
      const stamp =
        staffFrom === "NEVER" ? await restamp(projectId, sender.senderPhone, jidMatch, false, null) : await restamp(projectId, sender.senderPhone, jidMatch, true, staffFrom);
      result.restampedMessages += stamp;

      // The member credited on Support Activity rows: the one identity rule, nobody on a conflict.
      result.supportActivities += await prisma.$executeRaw`
        UPDATE "SupportActivity" a
        SET "teamMemberId" = ${decided.memberId}
        FROM "Message" m
        WHERE a."messageId" = m."id" AND a."projectId" = ${projectId} AND m."projectId" = ${projectId}
          AND a."actor" = 'TEAM_MEMBER'
          AND m."senderPhone" = ${sender.senderPhone} AND m."senderJid" IS NOT DISTINCT FROM ${jidMatch}
          AND a."teamMemberId" IS DISTINCT FROM ${decided.memberId}`;
    }
  }

  // Duty History: the days these senders wrote on, and the days the members involved already have,
  // recomputed for every member involved — so a message moved from one person to another leaves the
  // first one's day and joins the second's.
  const since = new Date(now.getTime() - ATTENDANCE_LOOKBACK_DAYS * 86_400_000);
  const dayKeys = new Set<string>();
  if (forms.length > 0) {
    const days = await prisma.$queryRaw<Array<{ day: string }>>`
      SELECT DISTINCT to_char(m."timestampWa" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM-DD') AS day
      FROM "Message" m
      WHERE m."projectId" = ${projectId} AND m."direction" = 'INCOMING' AND m."groupId" IS NOT NULL
        AND m."senderPhone" = ANY(${forms}) AND m."timestampWa" >= ${since}`;
    for (const row of days) dayKeys.add(row.day);
  }
  const ids = [...new Set(memberIds)];
  const existing = ids.length
    ? await prisma.teamAttendanceDay.findMany({ where: { teamMemberId: { in: ids }, activityDate: { gte: since } }, select: { activityDate: true } })
    : [];
  for (const row of existing) dayKeys.add(row.activityDate.toISOString().slice(0, 10));
  for (const memberId of ids) {
    for (const key of dayKeys) {
      // Noon in Dhaka on that day: unambiguously inside it.
      const noon = new Date(`${key}T06:00:00.000Z`);
      if (getDhakaDayRange(noon).start < since) continue;
      await recomputeAttendanceDay(memberId, noon);
      result.attendanceDays += 1;
    }
  }
  return result;
}

/** Sets the stamp for one sender's incoming messages; with `from`, staff only from that moment. Returns rows changed. */
async function restamp(projectId: string, senderPhone: string, senderJid: string | null, staff: boolean, from: Date | null): Promise<number> {
  if (!staff || from === null) {
    return prisma.$executeRaw`
      UPDATE "Message" SET "isFromTeamMember" = ${staff}
      WHERE "projectId" = ${projectId} AND "direction" = 'INCOMING'
        AND "senderPhone" = ${senderPhone} AND "senderJid" IS NOT DISTINCT FROM ${senderJid}
        AND "isFromTeamMember" <> ${staff}`;
  }
  return prisma.$executeRaw`
    UPDATE "Message" SET "isFromTeamMember" = ("timestampWa" >= ${from})
    WHERE "projectId" = ${projectId} AND "direction" = 'INCOMING'
      AND "senderPhone" = ${senderPhone} AND "senderJid" IS NOT DISTINCT FROM ${senderJid}
      AND "isFromTeamMember" <> ("timestampWa" >= ${from})`;
}
