/**
 * Google Sheets, Phase 5 — sheet members (GOOGLE_SHEETS.md §5). The app's OWN record of who works on
 * a spreadsheet and who only watches it — deliberately separate from Google Drive's sharing, which
 * says who may open the file in Google. One never becomes the other automatically.
 *
 *   LEAD     responsible for the sheet; works on it like an editor, and may staff it (add, re-role and
 *            remove EDITOR / MONITOR members) while holding `google_sheets.edit`.
 *   EDITOR   works on the sheet through the app (with `google_sheets.edit`). Their changes are work.
 *   MONITOR  follows the sheet read-only. Never produces work time, whatever their permissions.
 *
 * Members are app USERS (the CTO need not be on the support roster); the team member is resolved
 * through the existing `InternalTeamMember.userId` link, never by matching names or emails.
 *
 * These are pure rules — the server calls them rather than restating them.
 */

export const SHEET_MEMBER_ROLES = ["LEAD", "EDITOR", "MONITOR"] as const;
export type SheetMemberRole = (typeof SHEET_MEMBER_ROLES)[number];

export const SHEET_MEMBER_ROLE_LABELS: Record<SheetMemberRole, string> = {
  LEAD: "Lead",
  EDITOR: "Editor",
  MONITOR: "Monitor",
};

export const SHEET_MEMBER_ROLE_DESCRIPTIONS: Record<SheetMemberRole, string> = {
  LEAD: "Responsible for the sheet. Works on it, and can add, change and remove its editors and monitors.",
  EDITOR: "Works on the sheet through the app. Their changes count as work.",
  MONITOR: "Follows the sheet read-only. Never counted as working on it.",
};

export function isSheetMemberRole(value: unknown): value is SheetMemberRole {
  return typeof value === "string" && (SHEET_MEMBER_ROLES as readonly string[]).includes(value);
}

/** Whether a role works on the sheet (its changes are work). A monitor never does. */
export function roleCanWork(role: SheetMemberRole | null | undefined): boolean {
  return role === "LEAD" || role === "EDITOR";
}

/** Who is asking to change a sheet's members. */
export interface MemberChangeActor {
  /** `google_sheets.manage` in this project (after the project's access level and status). */
  hasManage: boolean;
  /** `google_sheets.edit` in this project (after the project's access level and status). */
  hasEdit: boolean;
  /** The actor's own current role on THIS sheet, if any. */
  actorRole: SheetMemberRole | null;
}

export type MemberChange =
  | { kind: "ADD"; role: SheetMemberRole }
  | { kind: "CHANGE_ROLE"; fromRole: SheetMemberRole; toRole: SheetMemberRole }
  | { kind: "REMOVE"; fromRole: SheetMemberRole };

export type MemberChangeDecision = { allowed: true } | { allowed: false; reason: string };

export const NOT_ALLOWED_TO_STAFF =
  "Changing a spreadsheet's members needs the “Manage Google Sheets Accounts & Assignments” permission, or being this spreadsheet's Lead with the “Edit Google Sheets” permission.";
export const ONLY_MANAGER_FOR_LEADS = "Only someone with the “Manage Google Sheets Accounts & Assignments” permission can make, change or remove a Lead.";

/**
 * May this actor make this change? A manager may make any change. A Lead (who also holds the edit
 * permission) staffs the sheet — EDITOR and MONITOR members — but cannot create, re-role or remove a
 * Lead, themselves included: who is responsible for a sheet is a manager's decision, and a Lead can
 * neither hand themselves away by accident nor appoint more Leads.
 */
export function decideMemberChange(actor: MemberChangeActor, change: MemberChange): MemberChangeDecision {
  if (actor.hasManage) return { allowed: true };
  if (actor.actorRole !== "LEAD" || !actor.hasEdit) return { allowed: false, reason: NOT_ALLOWED_TO_STAFF };
  const touchesLead =
    (change.kind === "ADD" && change.role === "LEAD") ||
    (change.kind === "CHANGE_ROLE" && (change.fromRole === "LEAD" || change.toRole === "LEAD")) ||
    (change.kind === "REMOVE" && change.fromRole === "LEAD");
  return touchesLead ? { allowed: false, reason: ONLY_MANAGER_FOR_LEADS } : { allowed: true };
}

/** One membership period: [startedAt, endedAt). An open period has no end. */
export interface MemberPeriod {
  userId: string;
  role: SheetMemberRole;
  startedAt: Date;
  endedAt: Date | null;
}

function covers(period: MemberPeriod, at: Date): boolean {
  return period.startedAt.getTime() <= at.getTime() && (period.endedAt === null || at.getTime() < period.endedAt.getTime());
}

/**
 * A person's role on the sheet AT a moment — what a report must use, so that someone moved from
 * Editor to Monitor at noon is an editor for the morning and a monitor for the afternoon. Periods
 * are half-open, so a role change (one period ends exactly when the next starts) has no gap and no
 * overlap. Null: not a member then.
 */
export function roleAt(periods: readonly MemberPeriod[], userId: string, at: Date): SheetMemberRole | null {
  for (const period of periods) {
    if (period.userId === userId && covers(period, at)) return period.role;
  }
  return null;
}

/** Everyone who was a member at a moment, with their role then. */
export function membersAt(periods: readonly MemberPeriod[], at: Date): Map<string, SheetMemberRole> {
  const out = new Map<string, SheetMemberRole>();
  for (const period of periods) if (covers(period, at)) out.set(period.userId, period.role);
  return out;
}
