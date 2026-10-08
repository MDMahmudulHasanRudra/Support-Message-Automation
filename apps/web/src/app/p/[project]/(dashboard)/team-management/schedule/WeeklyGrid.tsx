"use client";

import { useTransition } from "react";
import { Card, Select, Table, Td, Th, useToast } from "@/components/ui";
import { setWeeklyScheduleEntry } from "@/server/actions/teamManagement";
import type { WeeklyScheduleRow } from "@/server/teamManagementReports";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * The recurring pattern.
 *
 * Three values per cell, and the third one is the point: **"Not set" is not "Off".** A blank rota
 * and a rota where everybody has been deliberately given the day off look identical if you collapse
 * them, and they mean opposite things to whoever has to fill the gap — so "Not set" deletes the row
 * and "Off" writes one with no shift.
 *
 * This is a template for future dates. It never reaches back into a date that already has a roster
 * row, including tomorrow's.
 */
export function WeeklyGrid({
  rows,
  templates,
}: {
  rows: WeeklyScheduleRow[];
  templates: { id: string; name: string }[];
}) {
  const [pending, startTransition] = useTransition();
  const { showToast } = useToast();

  function handleChange(teamMemberId: string, weekday: number, value: string) {
    startTransition(async () => {
      const result = await setWeeklyScheduleEntry(teamMemberId, weekday, value);
      if (result.error) showToast({ tone: "danger", title: result.error });
    });
  }

  return (
    <Card>
      <Table>
        <thead>
          <tr>
            <Th>Team member</Th>
            {WEEKDAYS.map((day) => (
              <Th key={day}>{day}</Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.teamMemberId}>
              <Td>
                <div className="font-medium">{row.name}</div>
                <div className="text-xs text-[color:var(--color-muted-foreground)]">{row.role}</div>
              </Td>
              {row.days.map((cell) => (
                <Td key={cell.weekday}>
                  <Select
                    aria-label={`${WEEKDAYS[cell.weekday]} for ${row.name}`}
                    defaultValue={!cell.decided ? "CLEAR" : (cell.shiftTemplateId ?? "OFF")}
                    disabled={pending}
                    onChange={(event) => handleChange(row.teamMemberId, cell.weekday, event.target.value)}
                    className="min-w-32"
                  >
                    <option value="CLEAR">Not set</option>
                    <option value="OFF">Off</option>
                    {templates.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.name}
                      </option>
                    ))}
                  </Select>
                </Td>
              ))}
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}
