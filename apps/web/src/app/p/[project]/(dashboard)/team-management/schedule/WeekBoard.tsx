import Link from "@/components/ProjectLink";
import { Card } from "@/components/ui";

export interface WeekBoardDay {
  key: string;
  label: string;
  isToday: boolean;
}

export interface WeekBoardRow {
  teamMemberId: string;
  name: string;
  cells: Record<string, { status: string; shiftName: string | null } | undefined>;
}

const TONE: Record<string, string> = {
  DUTY: "bg-[var(--color-accent-bg)] text-[color:var(--color-accent)]",
  OFF: "bg-[var(--color-neutral-bg)] text-[color:var(--color-muted-foreground)]",
  LEAVE: "bg-[var(--color-warning-bg)] text-[color:var(--color-warning-fg)]",
  HOLIDAY: "bg-[var(--color-info-bg)] text-[color:var(--color-info-fg)]",
};

function cellText(cell: { status: string; shiftName: string | null }): string {
  if (cell.status === "DUTY") return cell.shiftName ?? "On duty";
  return cell.status.charAt(0) + cell.status.slice(1).toLowerCase().replace("_", " ");
}

/** The coming week at a glance: every person, seven days, what the roster says. A day's heading opens that day. */
export function WeekBoard({ days, rows, selected }: { days: WeekBoardDay[]; rows: WeekBoardRow[]; selected: string }) {
  return (
    <Card className="mb-6 !p-0">
      <div className="max-h-[26rem] overflow-auto">
        <table className="w-full min-w-[46rem] border-separate border-spacing-0 text-[13px]">
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-20 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-left text-xs font-medium text-[color:var(--color-muted-foreground)]">
                Team member
              </th>
              {days.map((day) => (
                <th key={day.key} className="sticky top-0 z-10 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-2 text-left">
                  <Link
                    href={`/team-management/schedule?date=${day.key}`}
                    scroll={false}
                    className={`text-xs ${day.key === selected ? "font-semibold text-[color:var(--color-accent)]" : day.isToday ? "font-semibold text-[color:var(--color-foreground)]" : "font-medium text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"}`}
                  >
                    {day.isToday ? "Today" : day.label}
                  </Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.teamMemberId}>
                <td className="sticky left-0 z-10 max-w-[12rem] truncate border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 font-medium text-[color:var(--color-foreground)]">
                  {row.name}
                </td>
                {days.map((day) => {
                  const cell = row.cells[day.key];
                  return (
                    <td key={day.key} className="border-b border-[var(--color-border)] px-1.5 py-1.5">
                      {cell ? (
                        <span className={`block truncate rounded-[var(--radius-sm)] px-2 py-1 text-xs ${TONE[cell.status] ?? TONE.OFF}`}>{cellText(cell)}</span>
                      ) : (
                        <span className="block rounded-[var(--radius-sm)] border border-dashed border-[var(--color-border)] px-2 py-1 text-xs text-[color:var(--color-subtle-foreground)]">Not set</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
