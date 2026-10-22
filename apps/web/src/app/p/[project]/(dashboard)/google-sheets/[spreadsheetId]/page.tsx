import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink } from "lucide-react";
import Link from "@/components/ProjectLink";
import { Badge, ButtonLink, Card, PageHeader, SectionHeader, ViewOnlyNotice } from "@/components/ui";
import { SHEET_MEMBER_ROLE_LABELS, type SheetMemberRole } from "@support-automation/shared";
import { formatDate } from "@/lib/date";
import { pageAccess } from "@/server/authorize";
import { prisma } from "@/server/db";
import { hasPermission } from "@/server/permissions";
import { activeProjectIsReadOnly } from "@/server/projectContext";
import { loginsForProject } from "@/server/projectLogins";
import { activeProjectSlug } from "@/server/projectContext";
import { canStaffSheet, getSheetMembers } from "@/server/google/members";
import { sheetEditorAccess } from "@/server/google/editorAccess";
import { identitiesForUsers } from "@/server/google/identity";
import { listActivity } from "@/server/google/activity";
import { listLiveSessions } from "@/server/google/sessions";
import { getGoogleSheetsSettings } from "@/server/google/settings";
import { SheetMembersPanel, type MemberView } from "./SheetMembersPanel";
import { GoogleSharingPanel } from "./GoogleSharingPanel";
import { SheetEditor } from "./SheetEditor";
import { ActivityTable } from "../ActivityTable";
import { LiveNow } from "../LiveNow";

export const metadata = { title: "Spreadsheet" };

/**
 * One spreadsheet: its contents in the editor (Phase 3) for the people who may open it, who works on
 * it through the app and who monitors it (Phase 5), who has it open now and what was done to it
 * (Phases 6–7, for people who follow others' work) — and, separately, Google Drive's own sharing for
 * reference. Google's sharing and the app's membership are never copied into each other.
 */
export default async function SpreadsheetPage({ params }: { params: Promise<{ spreadsheetId: string }> }) {
  const { session, canManage } = await pageAccess("google_sheets.view", "google_sheets.manage", "GOOGLE_SHEETS");
  const { spreadsheetId } = await params;
  const sheet = await prisma.googleSpreadsheet.findUnique({
    where: { id: spreadsheetId },
    select: {
      id: true,
      name: true,
      googleFileId: true,
      webViewLink: true,
      ownerName: true,
      ownerEmail: true,
      sharedInGoogle: true,
      isMonitored: true,
      removedAt: true,
      externalActivityCheckedAt: true,
      externalActivityError: true,
      access: { where: { removedAt: null }, select: { canEdit: true, googleAccount: { select: { email: true } } } },
    },
  });
  if (!sheet) notFound();

  const [members, hasEdit, hasMonitor, readOnly, editor, slug] = await Promise.all([
    getSheetMembers(sheet.id),
    hasPermission(session, "google_sheets.edit"),
    hasPermission(session, "google_sheets.monitor"),
    activeProjectIsReadOnly(),
    sheetEditorAccess(sheet.id, session),
    activeProjectSlug(),
  ]);
  if (!members || !editor) notFound();
  // Other people's work is for the people who follow it (`google_sheets.monitor`) and managers.
  const followsWork = hasMonitor || canManage;
  const [identities, live, recent, settings] = await Promise.all([
    identitiesForUsers(members.current.map((m) => m.userId)),
    followsWork ? listLiveSessions({ spreadsheetId: sheet.id }) : Promise.resolve([]),
    followsWork ? listActivity({ spreadsheetId: sheet.id }, 1, 25) : Promise.resolve({ rows: [], total: 0 }),
    getGoogleSheetsSettings(),
  ]);
  const canStaff = !readOnly && (await canStaffSheet(sheet.id, { userId: session.userId, hasManage: canManage, hasEdit }));
  const canMakeLeads = canStaff && canManage;
  const candidates = canStaff ? (await loginsForProject()).filter((login) => !members.current.some((m) => m.userId === login.id)) : [];

  const view: MemberView[] = members.current.map((m) => ({
    userId: m.userId,
    name: m.name,
    username: m.username,
    role: m.role,
    sinceLabel: formatDate(m.since),
    addedByName: m.addedByName,
    teamMemberName: m.teamMember?.name ?? null,
    canWorkThroughApp: m.canWorkThroughApp,
    isSelf: m.userId === session.userId,
    googleIdentity: identities.get(m.userId)?.join(", ") ?? null,
  }));

  return (
    <div>
      <Link href="/google-sheets" className="mb-3 inline-flex items-center gap-1 text-[13px] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]">
        <ArrowLeft className="size-3.5" aria-hidden />
        Spreadsheets
      </Link>
      <PageHeader
        title={sheet.name}
        description="Work on it here, see who works on it and who only monitors it. Google Drive's own sharing is separate, and shown below for reference."
        actions={
          sheet.webViewLink ? (
            <ButtonLink href={sheet.webViewLink} target="_blank" rel="noopener noreferrer" variant="secondary" size="md">
              Open in Google Sheets
              <ExternalLink className="size-3.5" aria-hidden />
            </ButtonLink>
          ) : null
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px] text-[color:var(--color-muted-foreground)]">
        {sheet.isMonitored ? (
          <Badge color="green" dot>
            Monitored
          </Badge>
        ) : (
          <Badge color="gray">Not monitored</Badge>
        )}
        {sheet.removedAt ? <Badge color="yellow">No longer reachable since {formatDate(sheet.removedAt)}</Badge> : null}
        {sheet.ownerEmail ? <span>Owner in Google: {sheet.ownerName ?? sheet.ownerEmail}</span> : null}
        {sheet.access.length > 0 ? (
          <span>Reached through {sheet.access.map((a) => `${a.googleAccount.email} (${a.canEdit ? "can edit" : "view only"})`).join(", ")}</span>
        ) : null}
        <span className="font-mono text-[11px] [overflow-wrap:anywhere]">{sheet.googleFileId}</span>
      </div>

      {canStaff || editor.canEdit ? null : <ViewOnlyNotice />}

      <Card className="mb-6">
        <SectionHeader
          title="Spreadsheet"
          description={
            editor.canEdit
              ? "Changes are saved to Google when you press Save, and credited to you — never to the Google account they go through."
              : "Read-only for you here."
          }
        />
        {editor.canOpen ? (
          sheet.removedAt ? (
            <p className="text-[13px] text-[color:var(--color-muted-foreground)]">No connected Google account reaches this spreadsheet any more, so it cannot be opened here.</p>
          ) : (
            <SheetEditor spreadsheetId={sheet.id} canEdit={editor.canEdit} editRefusal={editor.editRefusal} signalUrl={`/p/${slug}/api/google-sheets/signal`} googleUrl={sheet.webViewLink} />
          )
        ) : (
          <p className="text-[13px] text-[color:var(--color-muted-foreground)]">{editor.openRefusal}</p>
        )}
      </Card>

      {followsWork ? (
        <div className="mb-6 grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <Card>
            <SectionHeader title="Open right now" description={`In the app, with activity in the last ${settings.inactivityMinutes} minutes.`} />
            <LiveNow sessions={live} showSheet={false} inactivityMinutes={settings.inactivityMinutes} />
          </Card>
          <Card>
            <SectionHeader
              title="Recent activity"
              description={
                sheet.isMonitored
                  ? `In the app, and changes made in Google directly${sheet.externalActivityCheckedAt ? ` (Google last read ${formatDate(sheet.externalActivityCheckedAt)})` : ""}.`
                  : "In the app. Changes made in Google directly are read only for monitored spreadsheets."
              }
            />
            {sheet.isMonitored && sheet.externalActivityError ? (
              <p className="mb-3 rounded-[var(--radius-md)] bg-[var(--color-warning-bg)] px-3 py-2 text-[12.5px] text-[color:var(--color-warning-fg)]">{sheet.externalActivityError}</p>
            ) : null}
            {recent.rows.length === 0 ? (
              <p className="text-[13px] text-[color:var(--color-muted-foreground)]">Nothing recorded yet.</p>
            ) : (
              <>
                <ActivityTable rows={recent.rows} showSheet={false} />
                {recent.total > recent.rows.length ? (
                  <Link href={`/google-sheets/activity?sheet=${sheet.id}`} className="mt-3 inline-block text-[13px] font-medium text-[color:var(--color-accent)] hover:underline">
                    All {recent.total.toLocaleString("en-US")} entries →
                  </Link>
                ) : null}
              </>
            )}
          </Card>
        </div>
      ) : null}

      <Card className="mb-6">
        <SectionHeader
          title="Members"
          description="The app's own record of who works on this spreadsheet. Work done through the app is credited to the person who did it — never to the spreadsheet's owner, its creator or the connected Google account."
        />
        <ul className="mb-4 grid gap-1 text-[12px] text-[color:var(--color-muted-foreground)] sm:grid-cols-3">
          {(["LEAD", "EDITOR", "MONITOR"] as SheetMemberRole[]).map((role) => (
            <li key={role}>
              <strong className="text-[color:var(--color-foreground)]">{SHEET_MEMBER_ROLE_LABELS[role]}</strong> —{" "}
              {role === "LEAD"
                ? "responsible for the sheet; works on it and staffs its editors and monitors."
                : role === "EDITOR"
                  ? "works on it through the app; their changes count as work."
                  : "follows it read-only; never counted as working on it."}
            </li>
          ))}
        </ul>
        <SheetMembersPanel spreadsheetId={sheet.id} members={view} candidates={candidates} canStaff={canStaff} canMakeLeads={canMakeLeads} />
      </Card>

      {members.history.length > 0 ? (
        <Card className="mb-6">
          <details>
            <summary className="cursor-pointer text-sm font-semibold text-[color:var(--color-foreground)]">Earlier membership ({members.history.length})</summary>
            <ul className="mt-3 space-y-1.5 text-[13px]">
              {members.history.map((h, i) => (
                <li key={`${h.userId}-${i}`} className="text-[color:var(--color-muted-foreground)]">
                  <span className="text-[color:var(--color-foreground)]">{h.name}</span> was {SHEET_MEMBER_ROLE_LABELS[h.role].toLowerCase()} from{" "}
                  {formatDate(h.startedAt)} to {formatDate(h.endedAt)}
                  {h.endReason === "ROLE_CHANGED" ? " (role changed" : " (removed"}
                  {h.endedByName ? ` by ${h.endedByName})` : ")"}
                </li>
              ))}
            </ul>
          </details>
        </Card>
      ) : null}

      {canStaff ? (
        <Card>
          <SectionHeader
            title="Shared in Google Drive"
            description="Who may open this file in Google, as Google reports it. Shown for reference only: it never adds, changes or removes a member above, and a member's role here changes nothing in Google."
          />
          <GoogleSharingPanel spreadsheetId={sheet.id} />
        </Card>
      ) : null}
    </div>
  );
}
