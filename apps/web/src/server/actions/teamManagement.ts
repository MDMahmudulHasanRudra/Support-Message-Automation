"use server";

import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { prisma } from "@support-automation/db";
import type { DutyStatus, Prisma } from "@prisma/client";
import { parseDhakaDayFromInput, toDhakaDateOnly } from "@support-automation/shared";
import { requireSession } from "@/server/auth";
import { hasPermission } from "@/server/permissions";
import { logSystemEvent } from "@/server/logSystemEvent";
import { getDutyGroupEvidence } from "@/server/teamManagementReports";

/**
 * Every write in Team Management: shift templates, the weekly pattern, the daily roster, leave, and
 * the coverage/shift-change workflow.
 *
 * Three rules hold across the whole file and are the reason it reads the way it does.
 *
 * **Nothing rewrites history.** A `DutyAssignment` carries a snapshot of the shift's name and times,
 * so editing a template changes what that shift means from now on and never what somebody worked
 * last Tuesday. Nothing here back-fills, re-materialises or "corrects" a date that already has a
 * row.
 *
 * **Nothing moves a person silently.** One assignment per member per date is a database constraint,
 * and the coverage path CREATES rather than upserts precisely so a clash surfaces as a question for
 * the manager instead of quietly overwriting the shift somebody already had.
 *
 * **Approving leave preserves the plan.** The `DutyAssignment` that existed is left exactly where it
 * was; coverage is computed by subtracting people who cannot work from the people assigned. Deleting
 * the row would destroy the evidence that the shift is now short.
 *
 * Results follow `chatOrganisation.ts`'s `{ error?, updated?, unchanged? }` shape so a form reports
 * what actually happened rather than "Done".
 */

export interface TeamManagementResult {
  error?: string;
  updated?: number;
  unchanged?: number;
  /** Set by the flows a caller has to react to — a created id, a change-group id. */
  id?: string;
  message?: string;
}

const MINUTES_IN_DAY = 24 * 60;

function revalidateModule() {
  revalidatePath("/team-management");
  revalidatePath("/team-management/schedule");
  revalidatePath("/team-management/shifts");
  revalidatePath("/team-management/leave");
  revalidatePath("/team-management/attendance");
  revalidatePath("/team-management/settings");
}

/** `.manage` or nothing. Actions return a typed error rather than redirecting — a form needs a reason. */
async function requireManage(): Promise<{ userId: string } | { error: string }> {
  const session = await requireSession();
  if (!(await hasPermission(session, "team_management.manage"))) {
    return { error: "You do not have permission to change the schedule." };
  }
  return { userId: session.userId };
}

/**
 * `HH:MM` → minutes from midnight, or null.
 *
 * No CHECK constraint exists anywhere in this schema (see the standards), so every bound is enforced
 * here. A shift that ends at or before it starts is not rejected: that is how a night shift is
 * expressed, and refusing it would make the late shift unrepresentable.
 */
function parseTimeToMinutes(value: unknown): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  const total = hours * 60 + minutes;
  return total >= 0 && total < MINUTES_IN_DAY ? total : null;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function text(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? "").trim();
  return value.length > 0 ? value : null;
}

// ------------------------------------------------------------------- shift templates (phase 2)

export async function saveShiftTemplate(formData: FormData): Promise<TeamManagementResult> {
  const auth = await requireManage();
  if ("error" in auth) return auth;

  const id = text(formData, "id");
  const name = text(formData, "name");
  if (!name) return { error: "Give the shift a name." };
  if (name.length > 60) return { error: "Shift names are limited to 60 characters." };

  const startMinute = parseTimeToMinutes(formData.get("startTime"));
  const endMinute = parseTimeToMinutes(formData.get("endTime"));
  if (startMinute === null || endMinute === null) {
    return { error: "Enter both times as HH:MM, e.g. 10:00 and 19:00." };
  }

  const requiredHeadcount = clampInt(formData.get("requiredHeadcount"), 0, 200, 1);
  const colourSlot = clampInt(formData.get("colourSlot"), 1, 6, 1);
  const position = clampInt(formData.get("position"), 0, 999, 0);
  const description = text(formData, "description");
  const isActive = formData.get("isActive") !== null;

  const data = { name, startMinute, endMinute, requiredHeadcount, colourSlot, position, description, isActive };

  try {
    if (id) {
      // Only the template is updated. Existing `DutyAssignment` rows keep their snapshot, which is
      // the entire point of snapshotting — see the model comment.
      await prisma.shiftTemplate.update({ where: { id }, data });
      await logSystemEvent("INFO", "team-management", "SHIFT_TEMPLATE_UPDATED", {
        userId: auth.userId,
        shiftTemplateId: id,
        name,
        startMinute,
        endMinute,
        requiredHeadcount,
        isActive,
      });
    } else {
      const created = await prisma.shiftTemplate.create({ data, select: { id: true } });
      await logSystemEvent("INFO", "team-management", "SHIFT_TEMPLATE_CREATED", {
        userId: auth.userId,
        shiftTemplateId: created.id,
        name,
      });
    }
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002") {
      return { error: `A shift called "${name}" already exists.` };
    }
    throw err;
  }

  revalidateModule();
  return { updated: 1 };
}

/**
 * Disabling, never deleting.
 *
 * `DutyAssignment.shiftTemplateId` is `Restrict`, so a template anybody has ever been assigned to
 * cannot be deleted at all — and should not be: coverage reporting groups by it. Disabling takes it
 * out of every picker while leaving history readable.
 */
export async function setShiftTemplateActive(id: string, isActive: boolean): Promise<TeamManagementResult> {
  const auth = await requireManage();
  if ("error" in auth) return auth;

  const existing = await prisma.shiftTemplate.findUnique({ where: { id }, select: { isActive: true } });
  if (!existing) return { error: "That shift no longer exists." };
  if (existing.isActive === isActive) return { unchanged: 1 };

  await prisma.shiftTemplate.update({ where: { id }, data: { isActive } });
  await logSystemEvent("INFO", "team-management", isActive ? "SHIFT_TEMPLATE_ENABLED" : "SHIFT_TEMPLATE_DISABLED", {
    userId: auth.userId,
    shiftTemplateId: id,
  });
  revalidateModule();
  return { updated: 1 };
}

/** A member's default shift — the starting point for a new weekly pattern, never a rule about a date. */
export async function setMemberDefaultShift(
  teamMemberId: string,
  shiftTemplateId: string | null,
): Promise<TeamManagementResult> {
  const auth = await requireManage();
  if ("error" in auth) return auth;

  const member = await prisma.internalTeamMember.findUnique({
    where: { id: teamMemberId },
    select: { defaultShiftTemplateId: true },
  });
  if (!member) return { error: "That team member no longer exists." };
  if (member.defaultShiftTemplateId === shiftTemplateId) return { unchanged: 1 };

  await prisma.internalTeamMember.update({ where: { id: teamMemberId }, data: { defaultShiftTemplateId: shiftTemplateId } });
  revalidateModule();
  return { updated: 1 };
}

// ------------------------------------------------------------------ weekly schedule (phase 3)

/**
 * One cell of the recurring grid.
 *
 * Three distinct meanings, and collapsing any two would make an unfilled rota look complete:
 * `"OFF"` writes a row with a null template (decided: this person is off), a template id writes that
 * shift, and `"CLEAR"` deletes the row (nobody has decided yet).
 *
 * Changing the pattern affects FUTURE materialisation only. It never touches a `DutyAssignment` that
 * already exists, including tomorrow's — once a date has a row, that row is the authority.
 */
export async function setWeeklyScheduleEntry(
  teamMemberId: string,
  weekday: number,
  value: string,
): Promise<TeamManagementResult> {
  const auth = await requireManage();
  if ("error" in auth) return auth;

  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return { error: "Invalid weekday." };

  if (value === "CLEAR") {
    const deleted = await prisma.weeklyScheduleEntry.deleteMany({ where: { teamMemberId, weekday } });
    revalidateModule();
    return deleted.count > 0 ? { updated: 1 } : { unchanged: 1 };
  }

  const shiftTemplateId = value === "OFF" ? null : value;
  if (shiftTemplateId) {
    const template = await prisma.shiftTemplate.findUnique({ where: { id: shiftTemplateId }, select: { id: true } });
    if (!template) return { error: "That shift no longer exists." };
  }

  await prisma.weeklyScheduleEntry.upsert({
    where: { teamMemberId_weekday: { teamMemberId, weekday } },
    create: { teamMemberId, weekday, shiftTemplateId },
    update: { shiftTemplateId },
  });

  revalidateModule();
  return { updated: 1 };
}

// ---------------------------------------------------------------------- daily roster (phase 3)

const EMPTY_SHIFT = { shiftTemplateId: null, shiftName: null, shiftStartMinute: null, shiftEndMinute: null };

type ShiftSnapshot = typeof EMPTY_SHIFT | {
  shiftTemplateId: string;
  shiftName: string;
  shiftStartMinute: number;
  shiftEndMinute: number;
};

/**
 * The snapshot a `DutyAssignment` carries, resolved from a template id.
 *
 * `null` means "refuse this" and the caller turns it into a message. A DISABLED template is refused
 * unless it is the one already on this assignment: keeping it is how a historical row survives
 * somebody retiring a shift, while newly assigning one would put people on a shift the business has
 * withdrawn. Both halves matter — refusing outright would make a disabled shift impossible to edit
 * the reason on, and allowing it outright would let a stale tab roster somebody onto it tomorrow.
 */
async function resolveShiftSnapshot(
  shiftTemplateId: string | null,
  allowInactiveId: string | null = null,
): Promise<ShiftSnapshot | null> {
  if (!shiftTemplateId) return EMPTY_SHIFT;
  const template = await prisma.shiftTemplate.findUnique({ where: { id: shiftTemplateId } });
  if (!template) return null;
  if (!template.isActive && template.id !== allowInactiveId) return null;
  return {
    shiftTemplateId: template.id,
    shiftName: template.name,
    shiftStartMinute: template.startMinute,
    shiftEndMinute: template.endMinute,
  };
}

/** One message for both refusal reasons, since the operator's next move is the same either way. */
const SHIFT_UNAVAILABLE = "That shift is no longer available. Enable it on the Shifts page, or pick another.";

/** Writes the immutable before/after row. Every roster write goes through this — no exceptions. */
async function recordChange(
  tx: Prisma.TransactionClient,
  input: {
    teamMemberId: string;
    dutyDate: Date;
    previous: { status: DutyStatus; shiftName: string | null } | null;
    newStatus: DutyStatus;
    newShiftName: string | null;
    reason: string | null;
    changedByUserId: string;
    changeGroupId?: string | null;
  },
): Promise<void> {
  await tx.dutyAssignmentChange.create({
    data: {
      teamMemberId: input.teamMemberId,
      dutyDate: input.dutyDate,
      previousStatus: input.previous?.status ?? null,
      previousShiftName: input.previous?.shiftName ?? null,
      newStatus: input.newStatus,
      newShiftName: input.newShiftName,
      reason: input.reason,
      changeGroupId: input.changeGroupId ?? null,
      changedByUserId: input.changedByUserId,
    },
  });
}

/**
 * Set (or change) what one person is doing on one date.
 *
 * An upsert is correct HERE and wrong in the coverage path, and the difference is who asked. A
 * manager editing Rakib's Tuesday means to replace whatever Rakib had on Tuesday. A manager filling
 * a vacancy means to add somebody, and silently replacing that person's existing shift would be a
 * second, unasked-for change — so `assignCoverage` creates and lets the unique constraint object.
 */
export async function setDutyAssignment(formData: FormData): Promise<TeamManagementResult> {
  const auth = await requireManage();
  if ("error" in auth) return auth;

  const teamMemberId = text(formData, "teamMemberId");
  const dateValue = text(formData, "dutyDate");
  const statusValue = String(formData.get("status") ?? "");
  if (!teamMemberId || !dateValue) return { error: "Pick a team member and a date." };

  const day = parseDhakaDayFromInput(dateValue);
  if (!day) return { error: "That is not a valid date." };
  const dutyDate = toDhakaDateOnly(day.start);

  const allowed: DutyStatus[] = ["DUTY", "OFF", "HOLIDAY", "COVERAGE", "EXTRA_DUTY", "UNASSIGNED"];
  if (!allowed.includes(statusValue as DutyStatus)) {
    // LEAVE is deliberately excluded: it is written by the leave workflow, and letting the roster
    // form set it would put a day on leave with no approved request behind it.
    return { error: "Pick a duty status. Leave is set by approving a leave request." };
  }
  const status = statusValue as DutyStatus;

  // Read what they hold first: it decides both the history row and whether a now-disabled shift
  // they are ALREADY on may be kept. Read outside the transaction only to resolve the snapshot; the
  // write below re-reads it inside, so the history row can never describe a stale "before".
  const held = await prisma.dutyAssignment.findUnique({
    where: { teamMemberId_dutyDate: { teamMemberId, dutyDate } },
    select: { shiftTemplateId: true },
  });

  // Only a working status carries a shift. OFF with a shift attached would read as both.
  const wantsShift = status === "DUTY" || status === "COVERAGE" || status === "EXTRA_DUTY";
  const snapshot = await resolveShiftSnapshot(
    wantsShift ? text(formData, "shiftTemplateId") : null,
    held?.shiftTemplateId ?? null,
  );
  if (!snapshot) return { error: SHIFT_UNAVAILABLE };
  if (wantsShift && !snapshot.shiftTemplateId) return { error: "Pick which shift they are working." };

  const reason = text(formData, "reason");

  await prisma.$transaction(async (tx) => {
    const previous = await tx.dutyAssignment.findUnique({
      where: { teamMemberId_dutyDate: { teamMemberId, dutyDate } },
      select: { status: true, shiftName: true },
    });

    await tx.dutyAssignment.upsert({
      where: { teamMemberId_dutyDate: { teamMemberId, dutyDate } },
      create: {
        teamMemberId,
        dutyDate,
        status,
        ...snapshot,
        source: "MANUAL",
        reason,
        assignedByUserId: auth.userId,
      },
      update: { status, ...snapshot, source: "MANUAL", reason, assignedByUserId: auth.userId },
    });

    await recordChange(tx, {
      teamMemberId,
      dutyDate,
      previous,
      newStatus: status,
      newShiftName: snapshot.shiftName,
      reason,
      changedByUserId: auth.userId,
    });
  });

  revalidateModule();
  return { updated: 1 };
}

/**
 * Fill a date's roster from the weekly pattern.
 *
 * **Skips every date that already has an assignment**, which is what makes it safe to press twice
 * and safe to press on a day somebody has already been moved. A member with no pattern row for that
 * weekday is left alone entirely rather than written as OFF — "not decided" must not become
 * "decided to be off" as a side effect of pressing a button.
 */
export async function materialiseRosterForDate(dateValue: string): Promise<TeamManagementResult> {
  const auth = await requireManage();
  if ("error" in auth) return auth;

  const day = parseDhakaDayFromInput(dateValue);
  if (!day) return { error: "That is not a valid date." };
  const dutyDate = toDhakaDateOnly(day.start);
  const weekday = dutyDate.getUTCDay(); // toDhakaDateOnly already shifted; this is the Dhaka weekday

  const [members, entries, existing, holiday, templates] = await Promise.all([
    prisma.internalTeamMember.findMany({ where: { status: "ACTIVE" }, select: { id: true } }),
    prisma.weeklyScheduleEntry.findMany({ where: { weekday } }),
    prisma.dutyAssignment.findMany({ where: { dutyDate }, select: { teamMemberId: true } }),
    prisma.holiday.findUnique({ where: { date: dutyDate }, select: { name: true } }),
    // Fetched once rather than per member. This used to resolve the snapshot inside the loop, which
    // was one extra round trip for every person on the roster to re-read the same handful of rows.
    prisma.shiftTemplate.findMany({ where: { isActive: true } }),
  ]);

  const entryByMember = new Map(entries.map((entry) => [entry.teamMemberId, entry]));
  const alreadyAssigned = new Set(existing.map((row) => row.teamMemberId));
  const templateById = new Map(templates.map((template) => [template.id, template]));

  let updated = 0;
  let unchanged = 0;

  for (const member of members) {
    if (alreadyAssigned.has(member.id)) {
      unchanged += 1; // a date that already has a row is that row's business, not this button's
      continue;
    }
    const entry = entryByMember.get(member.id);
    if (!entry) {
      unchanged += 1; // no pattern — deliberately left undecided rather than written as OFF
      continue;
    }

    // A declared holiday outranks the pattern, and says so on the row rather than looking like an
    // ordinary day off somebody chose.
    const holidayName = holiday?.name ?? null;
    const template = entry.shiftTemplateId ? templateById.get(entry.shiftTemplateId) : undefined;

    // Their pattern names a shift that has since been disabled. Skipped rather than assigned: this
    // is a NEW row, and rostering somebody onto a shift the business has withdrawn is worse than
    // leaving the day visibly undecided for a human to settle.
    if (entry.shiftTemplateId && !template && !holidayName) {
      unchanged += 1;
      continue;
    }

    const status: DutyStatus = holidayName ? "HOLIDAY" : template ? "DUTY" : "OFF";
    const snapshot = holidayName || !template ? null : template;

    try {
      await prisma.$transaction(async (tx) => {
        await tx.dutyAssignment.create({
          data: {
            teamMemberId: member.id,
            dutyDate,
            status,
            shiftTemplateId: snapshot?.id ?? null,
            shiftName: snapshot?.name ?? null,
            shiftStartMinute: snapshot?.startMinute ?? null,
            shiftEndMinute: snapshot?.endMinute ?? null,
            source: "WEEKLY_SCHEDULE",
            reason: holidayName,
            assignedByUserId: auth.userId,
          },
        });
        await recordChange(tx, {
          teamMemberId: member.id,
          dutyDate,
          previous: null,
          newStatus: status,
          newShiftName: snapshot?.name ?? null,
          reason: holidayName ?? "From the weekly schedule",
          changedByUserId: auth.userId,
        });
      });
      updated += 1;
    } catch (err) {
      // Somebody else assigned this person between the read above and this write. The unique
      // constraint is the guard, and their row wins — this button only ever fills blanks, so a
      // collision is "already done", not a failure worth abandoning the rest of the roster for.
      if (typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002") {
        unchanged += 1;
        continue;
      }
      throw err;
    }
  }

  revalidateModule();
  return { updated, unchanged };
}

// ------------------------------------------------------------------------- leave (phase 6)

function countInclusiveDays(start: Date, end: Date): number {
  return Math.floor((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;
}

export async function createLeaveRequest(formData: FormData): Promise<TeamManagementResult> {
  const auth = await requireManage();
  if ("error" in auth) return auth;

  const teamMemberId = text(formData, "teamMemberId");
  const leaveTypeId = text(formData, "leaveTypeId");
  const fromDay = parseDhakaDayFromInput(text(formData, "startDate"));
  const toDay = parseDhakaDayFromInput(text(formData, "endDate"));

  if (!teamMemberId || !leaveTypeId) return { error: "Pick a team member and a leave type." };
  if (!fromDay || !toDay) return { error: "Enter both dates." };

  const startDate = toDhakaDateOnly(fromDay.start);
  const endDate = toDhakaDateOnly(toDay.start);
  if (endDate < startDate) return { error: "The end date is before the start date." };

  const dayCount = countInclusiveDays(startDate, endDate);
  if (dayCount > 365) return { error: "A single request cannot span more than a year." };

  // Overlapping requests are refused rather than merged: two approved requests covering the same
  // day would each subtract from coverage and report a shift as twice as short as it is.
  const clash = await prisma.leaveRequest.findFirst({
    where: {
      teamMemberId,
      status: { in: ["REQUESTED", "APPROVED"] },
      startDate: { lte: endDate },
      endDate: { gte: startDate },
    },
    select: { id: true, startDate: true, endDate: true },
  });
  if (clash) return { error: "This person already has leave requested or approved across those dates." };

  const created = await prisma.leaveRequest.create({
    data: {
      teamMemberId,
      leaveTypeId,
      startDate,
      endDate,
      // Counted once, now. A holiday declared later must not change the size of a decided request.
      dayCount,
      reason: text(formData, "reason"),
      status: "REQUESTED",
      requestedByUserId: auth.userId,
    },
    select: { id: true },
  });

  revalidateModule();
  return { updated: 1, id: created.id };
}

/**
 * Approve or reject.
 *
 * On approval the existing `DutyAssignment` rows are **updated in place to LEAVE, keeping their
 * shift snapshot**, and the change row records what they were. Nothing is deleted. That is what
 * lets the coverage report say "Morning needs 2, has 2 assigned, 1 on leave, 1 effective, short by
 * 1" — delete the row and the shift simply looks understaffed with no explanation, and the audit
 * trail loses the fact that somebody was supposed to be there.
 */
export async function decideLeaveRequest(
  requestId: string,
  decision: "APPROVED" | "REJECTED",
  managerNote: string | null,
): Promise<TeamManagementResult> {
  const auth = await requireManage();
  if ("error" in auth) return auth;

  const request = await prisma.leaveRequest.findUnique({
    where: { id: requestId },
    select: { id: true, teamMemberId: true, startDate: true, endDate: true, status: true },
  });
  if (!request) return { error: "That request no longer exists." };
  if (request.status !== "REQUESTED") return { error: `That request was already ${request.status.toLowerCase()}.` };

  await prisma.$transaction(async (tx) => {
    await tx.leaveRequest.update({
      where: { id: requestId },
      data: { status: decision, decidedByUserId: auth.userId, decidedAt: new Date(), managerNote },
    });

    if (decision !== "APPROVED") return;

    const affected = await tx.dutyAssignment.findMany({
      where: {
        teamMemberId: request.teamMemberId,
        dutyDate: { gte: request.startDate, lte: request.endDate },
        status: { in: ["DUTY", "COVERAGE", "EXTRA_DUTY", "UNASSIGNED"] },
      },
      select: { id: true, dutyDate: true, status: true, shiftName: true },
    });

    for (const assignment of affected) {
      await tx.dutyAssignment.update({
        where: { id: assignment.id },
        // `shiftTemplateId` and the snapshot are deliberately untouched — the plan survives.
        data: { status: "LEAVE", source: "LEAVE" },
      });
      await recordChange(tx, {
        teamMemberId: request.teamMemberId,
        dutyDate: assignment.dutyDate,
        previous: { status: assignment.status, shiftName: assignment.shiftName },
        newStatus: "LEAVE",
        newShiftName: assignment.shiftName,
        reason: "Approved leave",
        changedByUserId: auth.userId,
      });
    }
  });

  await logSystemEvent("INFO", "team-management", `LEAVE_${decision}`, {
    userId: auth.userId,
    requestId,
    teamMemberId: request.teamMemberId,
  });

  revalidateModule();
  return { updated: 1 };
}

export async function cancelLeaveRequest(requestId: string): Promise<TeamManagementResult> {
  const auth = await requireManage();
  if ("error" in auth) return auth;

  const request = await prisma.leaveRequest.findUnique({
    where: { id: requestId },
    select: { status: true, managerNote: true },
  });
  if (!request) return { error: "That request no longer exists." };
  if (request.status === "CANCELLED") return { unchanged: 1 };
  if (request.status === "REJECTED") return { error: "That request was already rejected." };

  // Cancelling does NOT put the duty rows back. Once leave was approved a manager very likely
  // arranged cover, and silently restoring the original shift would double-staff the day and
  // contradict the coverage row somebody else is now holding. The roster is edited deliberately.
  //
  // `decidedByUserId` / `decidedAt` are deliberately NOT overwritten. They record who APPROVED the
  // leave, which is the decision the roster was changed on the strength of; overwriting them with
  // the canceller would erase that and leave a cancelled request claiming it was decided by
  // somebody who only undid it. The cancellation is appended to the note instead, so both are
  // readable without a schema change.
  const note = [request.managerNote, `Cancelled by ${auth.userId} on ${new Date().toISOString().slice(0, 10)}.`]
    .filter(Boolean)
    .join(" ");

  await prisma.leaveRequest.update({
    where: { id: requestId },
    data: { status: "CANCELLED", managerNote: note },
  });

  await logSystemEvent("INFO", "team-management", "LEAVE_CANCELLED", { userId: auth.userId, requestId });

  revalidateModule();
  return {
    updated: 1,
    message: "Leave cancelled. Their duty rows still read LEAVE — set them back on the roster if they are working.",
  };
}

// --------------------------------------------------------------- coverage + shift change (7)

export interface ShiftChangePreview {
  error?: string;
  memberName?: string;
  /** What they currently hold on that date, if anything. */
  currentShiftName?: string | null;
  currentStatus?: DutyStatus | null;
  /** True when moving them takes their current shift below its required headcount. */
  leavesGap?: boolean;
  vacatedShiftName?: string | null;
  vacatedRequired?: number;
  vacatedEffectiveAfter?: number;
  /** The shift they would move to. */
  targetShiftName?: string;
}

/**
 * What would happen, before anything is written.
 *
 * Shown to the manager rather than acted on automatically. Moving somebody off a shift that is
 * already at its minimum is a legitimate decision — it just must not be an invisible one.
 */
export async function previewShiftChange(
  teamMemberId: string,
  dateValue: string,
  newShiftTemplateId: string,
): Promise<ShiftChangePreview> {
  const session = await requireSession();
  if (!(await hasPermission(session, "team_management.view"))) {
    return { error: "You do not have permission to view the schedule." };
  }

  const day = parseDhakaDayFromInput(dateValue);
  if (!day) return { error: "That is not a valid date." };
  const dutyDate = toDhakaDateOnly(day.start);

  const [member, target, current] = await Promise.all([
    prisma.internalTeamMember.findUnique({ where: { id: teamMemberId }, select: { name: true } }),
    prisma.shiftTemplate.findUnique({ where: { id: newShiftTemplateId } }),
    prisma.dutyAssignment.findUnique({
      where: { teamMemberId_dutyDate: { teamMemberId, dutyDate } },
      select: { status: true, shiftName: true, shiftTemplateId: true },
    }),
  ]);
  if (!member) return { error: "That team member no longer exists." };
  if (!target) return { error: "That shift no longer exists." };

  const preview: ShiftChangePreview = {
    memberName: member.name,
    currentShiftName: current?.shiftName ?? null,
    currentStatus: current?.status ?? null,
    targetShiftName: target.name,
    leavesGap: false,
    vacatedShiftName: current?.shiftName ?? null,
  };

  if (!current?.shiftTemplateId || current.shiftTemplateId === newShiftTemplateId) return preview;

  const vacated = await prisma.shiftTemplate.findUnique({
    where: { id: current.shiftTemplateId },
    select: { requiredHeadcount: true },
  });
  if (!vacated) return preview;

  // Effective, not assigned — anyone on approved leave was never really covering it.
  const others = await prisma.dutyAssignment.findMany({
    where: {
      dutyDate,
      shiftTemplateId: current.shiftTemplateId,
      status: { in: ["DUTY", "COVERAGE", "EXTRA_DUTY"] },
      teamMemberId: { not: teamMemberId },
    },
    select: { teamMemberId: true },
  });
  const onLeave = await prisma.leaveRequest.count({
    where: {
      status: "APPROVED",
      startDate: { lte: dutyDate },
      endDate: { gte: dutyDate },
      teamMemberId: { in: others.map((row) => row.teamMemberId) },
    },
  });

  const effectiveAfter = others.length - onLeave;
  preview.vacatedRequired = vacated.requiredHeadcount;
  preview.vacatedEffectiveAfter = effectiveAfter;
  preview.leavesGap = effectiveAfter < vacated.requiredHeadcount;
  return preview;
}

/**
 * Move somebody to a different shift, optionally putting a named replacement on the one they left,
 * as ONE recorded decision.
 *
 * Both halves share a `changeGroupId`, which is what makes the history readable afterwards: two
 * unrelated rows would not say that Bipul is on Late *because* Rakib moved to Morning.
 *
 * The replacement is **created, never upserted**. If they already hold that date the unique
 * constraint rejects it, the whole transaction rolls back, and the manager is told who is already
 * assigned — rather than the software quietly overwriting somebody's shift or moving a third person
 * to make room.
 */
export async function applyShiftChange(input: {
  teamMemberId: string;
  dateValue: string;
  newShiftTemplateId: string;
  reason: string | null;
  replacementTeamMemberId?: string | null;
}): Promise<TeamManagementResult> {
  const auth = await requireManage();
  if ("error" in auth) return auth;

  const day = parseDhakaDayFromInput(input.dateValue);
  if (!day) return { error: "That is not a valid date." };
  const dutyDate = toDhakaDateOnly(day.start);

  // No `allowInactiveId`: moving somebody ONTO a shift is a new assignment, so a withdrawn shift is
  // refused here even though the same helper preserves one already held.
  const snapshot = await resolveShiftSnapshot(input.newShiftTemplateId);
  if (!snapshot?.shiftTemplateId) return { error: SHIFT_UNAVAILABLE };

  const changeGroupId = randomUUID();

  if (input.replacementTeamMemberId) {
    const onLeave = await prisma.leaveRequest.findFirst({
      where: {
        teamMemberId: input.replacementTeamMemberId,
        status: "APPROVED",
        startDate: { lte: dutyDate },
        endDate: { gte: dutyDate },
      },
      select: { id: true },
    });
    // Excluded outright, never merely greyed out — assigning somebody whose leave is approved is
    // the one mistake this workflow exists to prevent.
    if (onLeave) return { error: "That person is on approved leave that day and cannot cover the shift." };
  }

  try {
    await prisma.$transaction(async (tx) => {
      const previous = await tx.dutyAssignment.findUnique({
        where: { teamMemberId_dutyDate: { teamMemberId: input.teamMemberId, dutyDate } },
        select: { status: true, shiftName: true, shiftTemplateId: true },
      });

      await tx.dutyAssignment.upsert({
        where: { teamMemberId_dutyDate: { teamMemberId: input.teamMemberId, dutyDate } },
        create: {
          teamMemberId: input.teamMemberId,
          dutyDate,
          status: "DUTY",
          ...snapshot,
          source: "MANUAL",
          reason: input.reason,
          assignedByUserId: auth.userId,
        },
        update: { status: "DUTY", ...snapshot, source: "MANUAL", reason: input.reason, assignedByUserId: auth.userId },
      });

      await recordChange(tx, {
        teamMemberId: input.teamMemberId,
        dutyDate,
        previous,
        newStatus: "DUTY",
        newShiftName: snapshot.shiftName,
        reason: input.reason,
        changedByUserId: auth.userId,
        changeGroupId,
      });

      if (!input.replacementTeamMemberId || !previous?.shiftTemplateId) return;

      // The vacated shift is passed as its own `allowInactiveId`. Without that, covering a shift
      // that has since been disabled resolved to null and the replacement was SILENTLY not
      // assigned — the manager would see "shift change recorded" with nobody actually covering.
      const vacated = await resolveShiftSnapshot(previous.shiftTemplateId, previous.shiftTemplateId);
      if (!vacated?.shiftTemplateId) return;

      await tx.dutyAssignment.create({
        data: {
          teamMemberId: input.replacementTeamMemberId,
          dutyDate,
          status: "COVERAGE",
          ...vacated,
          source: "COVERAGE",
          reason: input.reason ?? `Covering ${previous.shiftName ?? "a vacated shift"}`,
          assignedByUserId: auth.userId,
        },
      });

      await recordChange(tx, {
        teamMemberId: input.replacementTeamMemberId,
        dutyDate,
        previous: null,
        newStatus: "COVERAGE",
        newShiftName: vacated.shiftName,
        reason: input.reason ?? "Covering a vacated shift",
        changedByUserId: auth.userId,
        changeGroupId,
      });
    });
  } catch (err) {
    // The only create in that transaction is the replacement's, so a unique violation can only mean
    // the person chosen to cover already holds that date. Guarded on `replacementTeamMemberId`
    // anyway: without it, a P2002 from anywhere else would be reported as a candidate clash and
    // send the operator looking for a conflict that does not exist.
    const code = typeof err === "object" && err !== null ? (err as { code?: string }).code : undefined;
    if (code === "P2002" && input.replacementTeamMemberId) {
      const held = await prisma.dutyAssignment.findUnique({
        where: { teamMemberId_dutyDate: { teamMemberId: input.replacementTeamMemberId, dutyDate } },
        select: { shiftName: true },
      });
      return {
        error: held?.shiftName
          ? `They are already on ${held.shiftName} that day. Move them first, or pick somebody else.`
          : "They already have an assignment that day. Move it first, or pick somebody else.",
      };
    }
    throw err;
  }

  revalidateModule();
  return { updated: input.replacementTeamMemberId ? 2 : 1, id: changeGroupId };
}

// ------------------------------------------------------------ attendance override (phase 5)

/**
 * A manager's verdict on a day, recorded BESIDE the evidence rather than replacing it.
 *
 * This is the only way a day ever reads as ABSENT. The message counts stay exactly as observed, so
 * "he was marked absent and there were forty messages" remains readable as precisely that — which
 * is the case somebody needs to look at, and the case an overwrite would erase.
 */
export async function setAttendanceOverride(
  teamMemberId: string,
  dateValue: string,
  override: "WORKED" | "ABSENT" | "EXCUSED" | null,
  reason: string | null,
): Promise<TeamManagementResult> {
  const auth = await requireManage();
  if ("error" in auth) return auth;

  const day = parseDhakaDayFromInput(dateValue);
  if (!day) return { error: "That is not a valid date." };
  const activityDate = toDhakaDateOnly(day.start);

  if (override === "ABSENT" && !reason) return { error: "Marking somebody absent needs a reason." };

  const data = {
    override,
    overrideReason: override ? reason : null,
    overriddenByUserId: override ? auth.userId : null,
    overriddenAt: override ? new Date() : null,
  };

  // A day with no evidence row at all is exactly when WORKED matters most — field duty, phone
  // support — so the row is created with zero counts rather than the override being refused.
  await prisma.teamAttendanceDay.upsert({
    where: { teamMemberId_activityDate: { teamMemberId, activityDate } },
    create: { teamMemberId, activityDate, source: "MANUAL", ...data },
    update: data,
  });

  await logSystemEvent("INFO", "team-management", "ATTENDANCE_OVERRIDE", {
    userId: auth.userId,
    teamMemberId,
    activityDate: activityDate.toISOString().slice(0, 10),
    override,
  });

  revalidateModule();
  return { updated: 1 };
}

// --------------------------------------------------------------- leave types + holidays (7)

export async function saveLeaveType(formData: FormData): Promise<TeamManagementResult> {
  const auth = await requireManage();
  if ("error" in auth) return auth;

  const id = text(formData, "id");
  const name = text(formData, "name");
  if (!name) return { error: "Give the leave type a name." };

  const allowanceRaw = text(formData, "annualAllowanceDays");
  // Null and 0 are different answers: "we do not track an allowance" versus "the allowance is none".
  const annualAllowanceDays = allowanceRaw === null ? null : clampInt(allowanceRaw, 0, 366, 0);

  const data = {
    name,
    annualAllowanceDays,
    isPaid: formData.get("isPaid") !== null,
    isActive: formData.get("isActive") !== null,
    position: clampInt(formData.get("position"), 0, 999, 0),
  };

  try {
    if (id) await prisma.leaveType.update({ where: { id }, data });
    else await prisma.leaveType.create({ data });
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002") {
      return { error: `A leave type called "${name}" already exists.` };
    }
    throw err;
  }

  revalidateModule();
  return { updated: 1 };
}

export async function saveHoliday(formData: FormData): Promise<TeamManagementResult> {
  const auth = await requireManage();
  if ("error" in auth) return auth;

  const name = text(formData, "name");
  const day = parseDhakaDayFromInput(text(formData, "date"));
  if (!name) return { error: "Give the holiday a name." };
  if (!day) return { error: "Pick a date." };

  const date = toDhakaDateOnly(day.start);
  const description = text(formData, "description");

  // Declaring a holiday does NOT rewrite dates already on the roster. It changes what
  // `materialiseRosterForDate` produces from here on; a date somebody already scheduled is theirs.
  await prisma.holiday.upsert({
    where: { date },
    create: { name, date, description },
    update: { name, description },
  });

  revalidateModule();
  return { updated: 1 };
}

export async function deleteHoliday(id: string): Promise<TeamManagementResult> {
  const auth = await requireManage();
  if ("error" in auth) return auth;

  // Deleted by somebody else already is the expected outcome, not an error worth an error boundary.
  const removed = await prisma.holiday.deleteMany({ where: { id } });
  revalidateModule();
  return removed.count > 0 ? { updated: 1 } : { unchanged: 1 };
}

/**
 * The grace periods Duty History judges lateness against.
 *
 * Clamped to a day rather than validated with an error: a tolerance longer than a shift is
 * meaningless but it is not dangerous, and refusing the save would be a dialog about a number
 * somebody can simply retype. Zero is honoured — it means "the shift start is the shift start" —
 * so the empty-field case has to be handled separately from it, which is the bug this app has
 * already shipped once on the AI confidence threshold: `Number("")` is 0 and `Number.isFinite(0)`
 * is true, so an unguarded parse turns a cleared box into a deliberate zero.
 */
export async function saveTeamManagementSettings(formData: FormData): Promise<TeamManagementResult> {
  const auth = await requireManage();
  if ("error" in auth) return auth;

  const current = await prisma.teamManagementSettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });

  const minutes = (key: string, fallback: number) => {
    const raw = formData.get(key);
    if (raw === null || String(raw).trim() === "") return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(MINUTES_IN_DAY, Math.max(0, Math.round(parsed)));
  };

  const latenessGraceMinutes = minutes("latenessGraceMinutes", current.latenessGraceMinutes);
  const earlyDepartureGraceMinutes = minutes("earlyDepartureGraceMinutes", current.earlyDepartureGraceMinutes);

  if (
    latenessGraceMinutes === current.latenessGraceMinutes &&
    earlyDepartureGraceMinutes === current.earlyDepartureGraceMinutes
  ) {
    return { unchanged: 1 };
  }

  await prisma.teamManagementSettings.update({
    where: { id: "global" },
    data: { latenessGraceMinutes, earlyDepartureGraceMinutes },
  });
  revalidateModule();
  return { updated: 1 };
}

/**
 * The per-group evidence behind one person's day, fetched when somebody expands the row.
 *
 * A thin authorised wrapper over the report function — the read itself belongs with the other
 * reports, and this exists only because `teamManagementReports.ts` carries no `"use server"`
 * directive (it is read by server components, never by a client event handler) and a row that
 * expands on click is exactly that handler.
 *
 * `.view`, not `.manage`: this is the same evidence the row above it already summarises, shown in
 * more detail. Nothing here changes anything.
 */
export async function loadDutyGroupEvidence(
  teamMemberId: string,
  dutyDateIso: string,
): Promise<{ error?: string; rows?: Array<{ groupId: string; groupName: string; messageCount: number; firstAt: string; lastAt: string }> }> {
  const session = await requireSession();
  if (!(await hasPermission(session, "team_management.view"))) {
    return { error: "You do not have permission to view duty history." };
  }

  const dutyDate = new Date(dutyDateIso);
  if (Number.isNaN(dutyDate.getTime())) return { error: "That date could not be read." };

  const rows = await getDutyGroupEvidence(teamMemberId, dutyDate);
  return {
    // Serialised, because a Server Action's return value crosses to the client and a Date arrives
    // there as whatever the serialiser made of it. The caller formats; this states the instant.
    rows: rows.map((row) => ({
      groupId: row.groupId,
      groupName: row.groupName,
      messageCount: row.messageCount,
      firstAt: row.firstAt.toISOString(),
      lastAt: row.lastAt.toISOString(),
    })),
  };
}
