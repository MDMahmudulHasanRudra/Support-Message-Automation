import {
  decideMemberChange,
  levelAllows,
  roleAt,
  roleCanWork,
  SHEET_MEMBER_ROLE_LABELS,
  type MemberChange,
  type ProjectAccessLevelValue,
  type SheetMemberRole,
} from "@support-automation/shared";
import { isUniqueViolation } from "@/lib/prismaErrors";
import { prisma } from "@/server/db";
import { activeProjectId } from "@/server/projectContext";
import { loginsForProject } from "@/server/projectLogins";

/**
 * Sheet members (GOOGLE_SHEETS.md §5, Phase 5): who works on a spreadsheet through the app (LEAD,
 * EDITOR) and who only monitors it (MONITOR). Every write goes through this file, which applies the
 * shared rules (`decideMemberChange`) itself — so no action can skip them.
 *
 * Membership is HISTORY: a change ends the open period and opens the next at the same instant; nothing
 * is overwritten or deleted. It is the app's own record. Google Drive's sharing never creates,
 * changes or removes a member, and neither does who owns, created or connected the spreadsheet.
 */

/** A refusal worded for the person who asked. */
export class SheetMemberError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SheetMemberError";
  }
}

/** The person asking to change members, with their permissions in THIS project already decided. */
export interface MemberActorInput {
  userId: string;
  hasManage: boolean;
  hasEdit: boolean;
}

export interface SheetMember {
  userId: string;
  name: string;
  username: string;
  role: SheetMemberRole;
  since: Date;
  addedByName: string | null;
  /** The roster member this login is linked to (Team Members → login), or null: never guessed. */
  teamMember: { id: string; name: string } | null;
  /**
   * Whether this person can actually work on the sheet through the app: a working role AND the edit
   * permission in this project (role and access level). Presentation — the edit itself checks again.
   */
  canWorkThroughApp: boolean;
}

export interface SheetMemberHistoryEntry {
  userId: string;
  name: string;
  role: SheetMemberRole;
  startedAt: Date;
  endedAt: Date;
  endReason: "ROLE_CHANGED" | "REMOVED" | null;
  endedByName: string | null;
}

const ROLE_ORDER: Record<SheetMemberRole, number> = { LEAD: 0, EDITOR: 1, MONITOR: 2 };

/** Which of these users hold `key` in this project, after their role AND their own access level. */
async function usersHolding(userIds: string[], key: string): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const projectId = await activeProjectId();
  const users = await prisma.user.findMany({
    where: { id: { in: userIds }, isActive: true },
    select: {
      id: true,
      permissionModule: { select: { permissions: { where: { permission: { key } }, select: { permissionId: true } } } },
      projectAccess: { where: { projectId }, select: { level: true } },
    },
  });
  return new Set(
    users
      .filter((u) => (u.permissionModule?.permissions.length ?? 0) > 0)
      .filter((u) => levelAllows((u.projectAccess[0]?.level ?? null) as ProjectAccessLevelValue | null, key))
      .map((u) => u.id),
  );
}

/** The current members of a sheet and its earlier periods. Null when the sheet is not this project's. */
export async function getSheetMembers(spreadsheetId: string): Promise<{ current: SheetMember[]; history: SheetMemberHistoryEntry[] } | null> {
  const sheet = await prisma.googleSpreadsheet.findUnique({ where: { id: spreadsheetId }, select: { id: true } });
  if (!sheet) return null;
  const rows = await prisma.googleSpreadsheetMember.findMany({
    where: { spreadsheetId },
    orderBy: [{ startedAt: "desc" }],
    select: {
      userId: true,
      role: true,
      startedAt: true,
      endedAt: true,
      endReason: true,
      user: { select: { name: true, username: true } },
      addedBy: { select: { name: true } },
      endedBy: { select: { name: true } },
    },
  });
  const open = rows.filter((r) => r.endedAt === null);
  const userIds = open.map((r) => r.userId);
  const [links, editors] = await Promise.all([
    prisma.internalTeamMember.findMany({ where: { userId: { in: userIds } }, select: { id: true, name: true, userId: true } }),
    usersHolding(userIds, "google_sheets.edit"),
  ]);
  const linkByUser = new Map(links.map((l) => [l.userId, { id: l.id, name: l.name }]));

  const current = open
    .map((r) => ({
      userId: r.userId,
      name: r.user.name,
      username: r.user.username,
      role: r.role,
      since: r.startedAt,
      addedByName: r.addedBy?.name ?? null,
      teamMember: linkByUser.get(r.userId) ?? null,
      canWorkThroughApp: roleCanWork(r.role) && editors.has(r.userId),
    }))
    .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.name.localeCompare(b.name));
  const history = rows
    .filter((r) => r.endedAt !== null)
    .map((r) => ({
      userId: r.userId,
      name: r.user.name,
      role: r.role,
      startedAt: r.startedAt,
      endedAt: r.endedAt as Date,
      endReason: r.endReason,
      endedByName: r.endedBy?.name ?? null,
    }));
  return { current, history };
}

/** The actor's own current role on a sheet, if any. */
async function currentRole(spreadsheetId: string, userId: string): Promise<SheetMemberRole | null> {
  const row = await prisma.googleSpreadsheetMember.findFirst({ where: { spreadsheetId, userId, endedAt: null }, select: { role: true } });
  return row?.role ?? null;
}

async function requireSheet(spreadsheetId: string): Promise<{ id: string; name: string }> {
  const sheet = await prisma.googleSpreadsheet.findUnique({ where: { id: spreadsheetId }, select: { id: true, name: true } });
  if (!sheet) throw new SheetMemberError("That spreadsheet is not in this project.");
  return sheet;
}

async function decide(spreadsheetId: string, actor: MemberActorInput, change: MemberChange): Promise<void> {
  const decision = decideMemberChange({ hasManage: actor.hasManage, hasEdit: actor.hasEdit, actorRole: await currentRole(spreadsheetId, actor.userId) }, change);
  if (!decision.allowed) throw new SheetMemberError(decision.reason);
}

/**
 * Add a person to a sheet in a role. They must be a login that may enter this project and is active;
 * a person already on the sheet gets their role changed instead, never a second membership (the
 * partial unique index holds that even against two simultaneous presses).
 */
export async function addSheetMember(input: { spreadsheetId: string; userId: string; role: SheetMemberRole; actor: MemberActorInput; now?: Date }) {
  const sheet = await requireSheet(input.spreadsheetId);
  await decide(sheet.id, input.actor, { kind: "ADD", role: input.role });
  const login = (await loginsForProject()).find((u) => u.id === input.userId);
  if (!login) throw new SheetMemberError("That login cannot enter this project, or is deactivated. Nothing was changed.");
  const existing = await currentRole(sheet.id, input.userId);
  if (existing) throw new SheetMemberError(`${login.name} is already ${SHEET_MEMBER_ROLE_LABELS[existing].toLowerCase()} on this spreadsheet. Change their role instead.`);
  try {
    await prisma.googleSpreadsheetMember.create({
      data: { spreadsheetId: sheet.id, userId: input.userId, role: input.role, startedAt: input.now ?? new Date(), addedById: input.actor.userId },
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new SheetMemberError(`${login.name} was just added to this spreadsheet by someone else. Reload to see their role.`);
    throw err;
  }
  return { sheet, member: login, role: input.role };
}

/**
 * Change a member's role: the open period ends and the new one starts at the same instant, so the
 * history reads exactly when they stopped editing and started monitoring. Conditional on the period
 * still being open — a change made meanwhile by someone else is reported, never doubled.
 */
export async function changeSheetMemberRole(input: { spreadsheetId: string; userId: string; role: SheetMemberRole; actor: MemberActorInput; now?: Date }) {
  const sheet = await requireSheet(input.spreadsheetId);
  const open = await prisma.googleSpreadsheetMember.findFirst({
    where: { spreadsheetId: sheet.id, userId: input.userId, endedAt: null },
    select: { id: true, role: true, user: { select: { name: true } } },
  });
  if (!open) throw new SheetMemberError("That person is not a member of this spreadsheet.");
  if (open.role === input.role) return { sheet, name: open.user.name, fromRole: open.role, role: input.role, changed: false };
  await decide(sheet.id, input.actor, { kind: "CHANGE_ROLE", fromRole: open.role, toRole: input.role });
  const now = input.now ?? new Date();
  await prisma.$transaction(async (tx) => {
    const ended = await tx.googleSpreadsheetMember.updateMany({
      where: { id: open.id, endedAt: null },
      data: { endedAt: now, endReason: "ROLE_CHANGED", endedById: input.actor.userId },
    });
    if (ended.count !== 1) throw new SheetMemberError("Someone changed this member at the same moment. Reload and try again.");
    await tx.googleSpreadsheetMember.create({
      data: { spreadsheetId: sheet.id, userId: input.userId, role: input.role, startedAt: now, addedById: input.actor.userId },
    });
  });
  return { sheet, name: open.user.name, fromRole: open.role, role: input.role, changed: true };
}

/** Take a person off a sheet. Their period ends; their history and any work recorded stay. */
export async function removeSheetMember(input: { spreadsheetId: string; userId: string; actor: MemberActorInput; now?: Date }) {
  const sheet = await requireSheet(input.spreadsheetId);
  const open = await prisma.googleSpreadsheetMember.findFirst({
    where: { spreadsheetId: sheet.id, userId: input.userId, endedAt: null },
    select: { id: true, role: true, user: { select: { name: true } } },
  });
  if (!open) throw new SheetMemberError("That person is not a member of this spreadsheet.");
  await decide(sheet.id, input.actor, { kind: "REMOVE", fromRole: open.role });
  const ended = await prisma.googleSpreadsheetMember.updateMany({
    where: { id: open.id, endedAt: null },
    data: { endedAt: input.now ?? new Date(), endReason: "REMOVED", endedById: input.actor.userId },
  });
  if (ended.count !== 1) throw new SheetMemberError("Someone changed this member at the same moment. Reload and try again.");
  return { sheet, name: open.user.name, fromRole: open.role };
}

/** Whether this person may staff this sheet (manager, or its Lead with the edit permission). */
export async function canStaffSheet(spreadsheetId: string, actor: MemberActorInput): Promise<boolean> {
  return decideMemberChange({ hasManage: actor.hasManage, hasEdit: actor.hasEdit, actorRole: await currentRole(spreadsheetId, actor.userId) }, { kind: "ADD", role: "EDITOR" }).allowed;
}

/** Who did something on a sheet through the app — the answer every later phase records. */
export interface SheetActor {
  userId: string;
  name: string;
  username: string;
  /** Their roster member through the explicit login link, as it stands now; null when not linked. */
  teamMemberId: string | null;
  teamMemberName: string | null;
  /** Their role on the sheet AT `at`; null when they were not a member then. */
  role: SheetMemberRole | null;
  /** Whether that role works on the sheet. A monitor's time is viewing, never work. */
  canWork: boolean;
}

/**
 * Attribution for anything done through the app: ALWAYS the signed-in user who did it — never the
 * Google account whose token carried the call, the file's owner, its creator, or whoever connected
 * the account. The team member comes only from the explicit login link (Team Members → login); a
 * login with no link stays unlinked rather than being matched by name, email or phone. Later phases
 * store this answer on each activity row at the moment it happens, so relinking never rewrites the
 * past. Null when the user does not exist.
 */
export async function resolveSheetActor(spreadsheetId: string, userId: string, at: Date = new Date()): Promise<SheetActor | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, username: true } });
  if (!user) return null;
  const [periods, link] = await Promise.all([
    prisma.googleSpreadsheetMember.findMany({ where: { spreadsheetId, userId }, select: { userId: true, role: true, startedAt: true, endedAt: true } }),
    prisma.internalTeamMember.findFirst({ where: { userId }, select: { id: true, name: true } }),
  ]);
  const role = roleAt(periods, userId, at);
  return {
    userId: user.id,
    name: user.name,
    username: user.username,
    teamMemberId: link?.id ?? null,
    teamMemberName: link?.name ?? null,
    role,
    canWork: roleCanWork(role),
  };
}
