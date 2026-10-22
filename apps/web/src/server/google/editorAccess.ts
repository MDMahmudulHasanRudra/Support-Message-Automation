import { decideEditorAccess, isReadOnlyProjectStatus, roleCanWork, type EditorAccess, type SheetMemberRole } from "@support-automation/shared";
import type { Session } from "@/server/auth";
import { prisma } from "@/server/db";
import { hasPermission } from "@/server/permissions";
import { requireActiveProject } from "@/server/projectContext";

/**
 * What THIS person may do with one sheet's contents in the app — the one reading the page, the editor
 * actions and the signal route all use, so a hidden button and a refused request always agree.
 * Permissions are read after the project's access level (`hasPermission`); the feature and the view
 * key are the caller's own first check.
 */
export interface SheetEditorAccess extends EditorAccess {
  role: SheetMemberRole | null;
  /** Whether a work signal from this person is work (a working role, the edit permission, a writable project). */
  mayWork: boolean;
}

export async function sheetEditorAccess(spreadsheetId: string, session: Session): Promise<SheetEditorAccess | null> {
  const sheet = await prisma.googleSpreadsheet.findUnique({ where: { id: spreadsheetId }, select: { id: true } });
  if (!sheet) return null;
  const [project, hasView, hasEdit, hasManage, membership] = await Promise.all([
    requireActiveProject(),
    hasPermission(session, "google_sheets.view"),
    hasPermission(session, "google_sheets.edit"),
    hasPermission(session, "google_sheets.manage"),
    prisma.googleSpreadsheetMember.findFirst({ where: { spreadsheetId, userId: session.userId, endedAt: null }, select: { role: true } }),
  ]);
  const role = membership?.role ?? null;
  const projectReadOnly = isReadOnlyProjectStatus(project.status);
  const access = decideEditorAccess({ role, hasView, hasEdit, hasManage, projectReadOnly });
  return { ...access, role, mayWork: access.canEdit && roleCanWork(role) };
}
