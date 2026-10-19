import { prisma } from "@/server/db";
import {
  clampFallbackMinutes,
  DHAKA_OFFSET_MS,
  resolveRegularDuty,
  toDhakaDateOnly,
  type DutyDayEvidence,
  type ResolvedDuty,
} from "@support-automation/shared";

/**
 * Each member's regular duty for each day of a report (TEAM_OVERTIME.md), from what this app records:
 * the roster (DutyAssignment, its own snapshot of the shift times for that date), Holiday, the weekly
 * pattern (WeeklyScheduleEntry) and the member's default shift.
 *
 * The weekly pattern and the default shift are CURRENT settings with no history, so each is used for
 * a date only when it provably already applied then — the entry, the shift template and (for the
 * default shift) the member record unchanged since before that day ended. Otherwise the day falls to
 * the project's default duty length rather than today's schedule being applied to the past.
 *
 * Read once per report and resolved in memory; nothing here is shown to anyone — the report states
 * overtime only.
 */
export async function loadDutyResolver(range: { start: Date; end: Date }): Promise<(memberId: string, day: string) => ResolvedDuty> {
  // From the day before the period: a shift that started that evening owns its after-midnight hours.
  const firstDay = toDhakaDateOnly(new Date(range.start.getTime() - 86_400_000));
  const lastDay = toDhakaDateOnly(new Date(range.end.getTime() - 1));

  const [settings, assignments, holidays, patterns, members] = await Promise.all([
    prisma.supportActivitySettings.findUnique({ where: { id: "global" }, select: { overtimeFallbackDutyMinutes: true } }),
    prisma.dutyAssignment.findMany({
      where: { dutyDate: { gte: firstDay, lte: lastDay } },
      select: { teamMemberId: true, dutyDate: true, status: true, shiftStartMinute: true, shiftEndMinute: true },
    }),
    prisma.holiday.findMany({ where: { date: { gte: firstDay, lte: lastDay } }, select: { date: true } }),
    prisma.weeklyScheduleEntry.findMany({
      select: {
        teamMemberId: true,
        weekday: true,
        updatedAt: true,
        shiftTemplate: { select: { startMinute: true, endMinute: true, updatedAt: true } },
      },
    }),
    prisma.internalTeamMember.findMany({
      where: { defaultShiftTemplateId: { not: null } },
      select: { id: true, updatedAt: true, defaultShiftChangedAt: true, defaultShiftTemplate: { select: { startMinute: true, endMinute: true, updatedAt: true } } },
    }),
  ]);

  const fallbackMinutes = clampFallbackMinutes(settings?.overtimeFallbackDutyMinutes);
  const key = (memberId: string, day: string) => `${memberId}\u0000${day}`;
  const assignmentByDay = new Map(
    assignments.map((a) => [
      key(a.teamMemberId, a.dutyDate.toISOString().slice(0, 10)),
      { status: a.status as string, startMinute: a.shiftStartMinute, endMinute: a.shiftEndMinute },
    ]),
  );
  const holidayDays = new Set(holidays.map((h) => h.date.toISOString().slice(0, 10)));
  const patternByWeekday = new Map(patterns.map((p) => [key(p.teamMemberId, String(p.weekday)), p]));
  const defaultByMember = new Map(members.map((m) => [m.id, m]));

  /** The instant a Dhaka day ends: a setting changed after it cannot have applied to it. */
  const dayEnd = (day: string) => Date.parse(`${day}T00:00:00Z`) - DHAKA_OFFSET_MS + 86_400_000;

  const cache = new Map<string, ResolvedDuty>();
  return (memberId, day) => {
    const k = key(memberId, day);
    const hit = cache.get(k);
    if (hit) return hit;
    const end = dayEnd(day);
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday, as the roster stores it
    const entry = patternByWeekday.get(key(memberId, String(weekday)));
    let pattern: DutyDayEvidence["pattern"] = null;
    if (entry && entry.updatedAt.getTime() < end) {
      if (!entry.shiftTemplate) pattern = "OFF";
      else if (entry.shiftTemplate.updatedAt.getTime() < end) pattern = { startMinute: entry.shiftTemplate.startMinute, endMinute: entry.shiftTemplate.endMinute };
    }
    const member = defaultByMember.get(memberId);
    const template = member?.defaultShiftTemplate;
    const defaultShift =
      // From when the default shift was set — never the member's last edit of anything else.
      member && template && (member.defaultShiftChangedAt ?? member.updatedAt).getTime() < end && template.updatedAt.getTime() < end
        ? { startMinute: template.startMinute, endMinute: template.endMinute }
        : null;
    const resolved = resolveRegularDuty({
      assignment: assignmentByDay.get(k) ?? null,
      isHoliday: holidayDays.has(day),
      pattern,
      defaultShift,
      fallbackMinutes,
    });
    cache.set(k, resolved);
    return resolved;
  };
}
