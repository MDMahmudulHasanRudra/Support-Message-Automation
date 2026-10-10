import Link from "@/components/ProjectLink";
import { Table, Td, Th } from "@/components/ui";
import { formatHoursMinutes } from "@support-automation/shared";
import type { ReportDrill, ReportTable } from "@/server/google/reportTables";

/** A report table exactly as built for the exports, with durations shown as "2h 14m". */
export function ReportTableView({ table, drillHref, empty }: { table: ReportTable; drillHref: ((drill: ReportDrill) => string) | null; empty: string }) {
  const body = table.rows.filter((r) => r.emphasis !== "total");
  if (body.length === 0) return <p className="text-[13px] text-[color:var(--color-muted-foreground)]">{empty}</p>;
  const format = (kind: string, value: string | number) =>
    kind === "duration" ? formatHoursMinutes(Number(value) / 1000) : kind === "count" ? Number(value).toLocaleString("en-US") : String(value);
  return (
    <Table>
      <thead>
        <tr>
          {table.columns.map((c) => (
            <Th key={c.key}>{c.label}</Th>
          ))}
        </tr>
      </thead>
      <tbody>
        {table.rows.map((row) => (
          <tr
            key={row.id}
            className={row.emphasis === "total" ? "bg-[var(--color-surface-sunken)] font-semibold" : row.emphasis === "muted" ? "text-[color:var(--color-muted-foreground)]" : undefined}
          >
            {table.columns.map((c, i) => {
              const text = format(c.kind, row.cells[c.key] ?? "");
              return (
                <Td key={c.key} className={`${c.kind === "text" ? (i === 0 ? "min-w-[12rem]" : "") : "whitespace-nowrap text-right tabular-nums"}`}>
                  {i === 0 && row.drill && drillHref ? (
                    <Link href={drillHref(row.drill)} className="font-medium hover:underline">
                      {text}
                    </Link>
                  ) : (
                    text
                  )}
                </Td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
