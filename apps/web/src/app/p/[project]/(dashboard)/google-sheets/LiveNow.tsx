import Link from "@/components/ProjectLink";
import { Badge } from "@/components/ui";
import { SHEET_MEMBER_ROLE_LABELS } from "@support-automation/shared";
import { formatTime } from "@/lib/date";
import type { LiveSession } from "@/server/google/sessions";

/**
 * Who has a spreadsheet open in the app right now (GOOGLE_SHEETS.md §7): a signal within the
 * project's inactivity threshold. "Working" means a change or typing within it; otherwise viewing.
 */
export function LiveNow({ sessions, showSheet, inactivityMinutes }: { sessions: LiveSession[]; showSheet: boolean; inactivityMinutes: number }) {
  if (sessions.length === 0) {
    return (
      <p className="text-[13px] text-[color:var(--color-muted-foreground)]">
        Nobody has {showSheet ? "a spreadsheet" : "this spreadsheet"} open in the app right now (no activity in the last {inactivityMinutes} minutes).
      </p>
    );
  }
  return (
    <ul className="divide-y divide-[var(--color-border)]">
      {sessions.map((s) => (
        <li key={s.sessionId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-[13px]">
          <Badge color={s.working ? "green" : "gray"} dot pulse={s.working}>
            {s.working ? "Working" : "Viewing"}
          </Badge>
          <span className="font-medium">{s.name}</span>
          <span className="text-[12px] text-[color:var(--color-muted-foreground)]">
            {s.role ? SHEET_MEMBER_ROLE_LABELS[s.role] : "Not a member"}
            {s.teamMemberName ? ` · team: ${s.teamMemberName}` : ""}
          </span>
          {showSheet ? (
            <Link href={`/google-sheets/${s.spreadsheetId}`} className="text-[12.5px] font-medium hover:underline">
              {s.spreadsheetName}
            </Link>
          ) : null}
          <span className="ml-auto text-[12px] tabular-nums text-[color:var(--color-muted-foreground)]">
            since {formatTime(s.startedAt)} · last {formatTime(s.lastSignalAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}
