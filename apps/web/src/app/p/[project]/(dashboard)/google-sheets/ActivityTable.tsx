import Link from "@/components/ProjectLink";
import { Badge, Table, Td, Th } from "@/components/ui";
import { SHEET_MEMBER_ROLE_LABELS } from "@support-automation/shared";
import { formatDateTime } from "@/lib/date";
import type { ActivityRow } from "@/server/google/activity";

/**
 * The activity log as a table (GOOGLE_SHEETS.md §6). Viewing, work and Google's own record are told
 * apart in every row: a badge for where it happened and what kind it was, the person credited — or,
 * for a change made in Google nobody can be credited with, why not.
 */
export function ActivityTable({ rows, showSheet }: { rows: ActivityRow[]; showSheet: boolean }) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>When</Th>
          <Th>Who</Th>
          {showSheet ? <Th>Spreadsheet</Th> : null}
          <Th>What</Th>
          <Th>Where</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <Td className="whitespace-nowrap text-[12px] tabular-nums text-[color:var(--color-muted-foreground)]">{formatDateTime(row.occurredAt)}</Td>
            <Td className="min-w-[10rem]">
              {row.who ? (
                <>
                  <span className="font-medium">{row.who.name}</span>
                  <span className="block text-[11.5px] text-[color:var(--color-muted-foreground)]">
                    {[row.who.role ? SHEET_MEMBER_ROLE_LABELS[row.who.role] : "Not a member then", row.who.teamMemberName ? `team: ${row.who.teamMemberName}` : null].filter(Boolean).join(" · ")}
                  </span>
                </>
              ) : row.attribution === "APPLICATION_ECHO" ? (
                <span className="text-[12px] text-[color:var(--color-muted-foreground)]">Google&apos;s record of a change made in the app</span>
              ) : (
                <>
                  <span className="font-medium text-[color:var(--color-muted-foreground)]">Unattributed</span>
                  <span className="block text-[11.5px] text-[color:var(--color-muted-foreground)]">{row.unattributedReason}</span>
                </>
              )}
            </Td>
            {showSheet ? (
              <Td className="min-w-[10rem]">
                <Link href={`/google-sheets/${row.spreadsheetId}`} className="font-medium hover:underline">
                  {row.spreadsheetName}
                </Link>
              </Td>
            ) : null}
            <Td className="min-w-[12rem]">
              <span className="mr-1.5">{row.detail ?? row.actionLabel}</span>
              <span className="inline-flex flex-wrap gap-1 align-middle">
                {row.source === "APPLICATION" ? <Badge color="blue">In the app</Badge> : <Badge color="cyan">In Google</Badge>}
                {row.kind === "WORK" ? <Badge color="green">Work</Badge> : row.kind === "VIEW" ? <Badge color="gray">Viewing</Badge> : null}
                {row.itemCount && row.actionType === "CELLS_EDITED" ? <Badge color="gray">{row.itemCount} cells</Badge> : null}
              </span>
            </Td>
            <Td className="text-[12px] text-[color:var(--color-muted-foreground)]">
              {row.range ? <span className="font-mono text-[11.5px] [overflow-wrap:anywhere]">{row.range}</span> : row.tabTitle ? <span>{row.tabTitle}</span> : "—"}
              {row.viaEmail ? <span className="block text-[11px]">via {row.viaEmail}</span> : null}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
