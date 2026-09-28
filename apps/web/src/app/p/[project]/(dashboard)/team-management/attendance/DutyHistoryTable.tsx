"use client";

import { useState, useTransition } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { formatMinuteOfDay, formatMinutesShort } from "@support-automation/shared";
import { Badge, Table, Td, Th } from "@/components/ui";
import { DUTY_STATE_LABEL, type DerivedDutyState } from "@/lib/dutyState";
import { loadDutyGroupEvidence } from "@/server/actions/teamManagement";
import { DutyStateBadge } from "../DutyStateBadge";
import { AttendanceOverride } from "./AttendanceOverride";

/**
 * Scheduled against observed, one row per person per rostered day.
 *
 * The observed half is new, and was sitting in the database the whole time:
 * `TeamAttendanceDay.firstActivityAt` / `lastActivityAt` have been written on every message since
 * the attendance hook shipped and were read on the Today page only, so the one screen whose job is
 * this comparison printed the shift in full and never said when anybody actually started.
 *
 * A row expands to the per-group evidence behind it — `TeamAttendanceGroup`, which until now was
 * written faithfully and read by nothing at all. Loaded on click rather than joined into the list:
 * one day for one person is a handful of rows, every day for everybody is a fan-out this page
 * deliberately avoids.
 */

export interface DutyHistoryTableRow {
  id: string;
  dutyDateIso: string;
  dutyDateLabel: string;
  teamMemberId: string;
  memberName: string;
  statusLabel: string | null;
  shiftName: string | null;
  shiftRange: string | null;
  messageCount: number;
  uniqueGroupCount: number;
  startedMinute: number | null;
  endedMinute: number | null;
  engagedMinutes: number | null;
  lateByMinutes: number | null;
  leftEarlyByMinutes: number | null;
  isLate: boolean;
  isEarlyFinish: boolean;
  derived: DerivedDutyState;
  override: "WORKED" | "ABSENT" | "EXCUSED" | null;
  overrideReason: string | null;
  overriddenByName: string | null;
  overriddenAtLabel: string | null;
}

interface GroupEvidence {
  groupId: string;
  groupName: string;
  messageCount: number;
  firstAt: string;
  lastAt: string;
}

function timeOfDay(iso: string): string {
  const at = new Date(iso);
  // Dhaka is a fixed UTC+6 with no DST, which is why this is arithmetic rather than a formatter —
  // the same assumption `packages/shared/dhakaDay.ts` is built on and states.
  const shifted = new Date(at.getTime() + 6 * 60 * 60 * 1000);
  return `${String(shifted.getUTCHours()).padStart(2, "0")}:${String(shifted.getUTCMinutes()).padStart(2, "0")}`;
}

/**
 * The worked span, and how it compares to the shift.
 *
 * A delta is shown whenever there is one; the BADGE appears only past the configured grace. That
 * separation is the entire reason a grace period is a setting: "+8m" is a fact worth seeing and is
 * not an accusation, and collapsing the two would make the page either silent or censorious.
 */
function WorkedCell({ row }: { row: DutyHistoryTableRow }) {
  if (row.startedMinute === null || row.endedMinute === null) {
    return <span className="text-[color:var(--color-muted-foreground)]">—</span>;
  }

  return (
    <div className="leading-tight">
      <div className="tabular-nums">
        {formatMinuteOfDay(row.startedMinute)} – {formatMinuteOfDay(row.endedMinute)}
      </div>
      <div className="text-xs text-[color:var(--color-muted-foreground)]">
        {formatMinutesShort(row.engagedMinutes)} engaged
      </div>
    </div>
  );
}

function PunctualityCell({ row }: { row: DutyHistoryTableRow }) {
  if (row.startedMinute === null) return <span className="text-[color:var(--color-muted-foreground)]">—</span>;
  if (!row.shiftName) return <span className="text-[color:var(--color-muted-foreground)]">no shift</span>;

  const chips = [];
  if (row.isLate) {
    chips.push(
      <Badge key="late" color="yellow">
        {formatMinutesShort(row.lateByMinutes)} late
      </Badge>,
    );
  } else if (row.lateByMinutes !== null) {
    chips.push(
      <span key="late-ok" className="text-xs tabular-nums text-[color:var(--color-muted-foreground)]">
        +{formatMinutesShort(row.lateByMinutes)}
      </span>,
    );
  }

  if (row.isEarlyFinish) {
    chips.push(
      <Badge key="early" color="yellow">
        left {formatMinutesShort(row.leftEarlyByMinutes)} early
      </Badge>,
    );
  }

  if (chips.length === 0) {
    return <span className="text-xs text-[color:var(--color-muted-foreground)]">on time</span>;
  }
  return <div className="flex flex-wrap items-center gap-1.5">{chips}</div>;
}

export function DutyHistoryTable({ rows, canManage }: { rows: DutyHistoryTableRow[]; canManage: boolean }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<Record<string, GroupEvidence[] | "error">>({});
  const [, startTransition] = useTransition();

  const columnCount = canManage ? 8 : 7;

  function toggle(row: DutyHistoryTableRow) {
    if (expandedId === row.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(row.id);
    // Cached per row: reopening a row somebody already looked at should not re-query, and the
    // evidence behind a past day does not change while the page is open.
    if (evidence[row.id]) return;
    startTransition(async () => {
      const result = await loadDutyGroupEvidence(row.teamMemberId, row.dutyDateIso);
      setEvidence((current) => ({ ...current, [row.id]: result.rows ?? "error" }));
    });
  }

  return (
    <Table>
      <thead>
        <tr>
          <Th> </Th>
          <Th>Date</Th>
          <Th>Team member</Th>
          <Th>Scheduled</Th>
          <Th>Worked</Th>
          <Th>Punctuality</Th>
          <Th>Activity</Th>
          <Th>Reading</Th>
          {canManage ? <Th> </Th> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const isOpen = expandedId === row.id;
          const loaded = evidence[row.id];
          return [
            <tr key={row.id}>
              <Td className="w-8">
                <button
                  type="button"
                  onClick={() => toggle(row)}
                  aria-expanded={isOpen}
                  aria-label={isOpen ? "Hide groups" : "Show groups"}
                  disabled={row.messageCount === 0}
                  className="rounded p-1 text-[color:var(--color-muted-foreground)] transition-colors hover:text-[color:var(--color-foreground)] disabled:cursor-default disabled:opacity-30"
                >
                  {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>
              </Td>
              <Td className="whitespace-nowrap">{row.dutyDateLabel}</Td>
              <Td className="font-medium">{row.memberName}</Td>
              <Td>
                {row.shiftName ? (
                  <>
                    <div>{row.shiftName}</div>
                    <div className="text-xs tabular-nums text-[color:var(--color-muted-foreground)]">
                      {row.shiftRange}
                    </div>
                  </>
                ) : (
                  <span className="text-[color:var(--color-muted-foreground)]">{row.statusLabel ?? "—"}</span>
                )}
              </Td>
              <Td>
                <WorkedCell row={row} />
              </Td>
              <Td>
                <PunctualityCell row={row} />
              </Td>
              <Td className="tabular-nums">
                <div className="leading-tight">
                  <div>{row.messageCount || "—"}</div>
                  <div className="text-xs text-[color:var(--color-muted-foreground)]">
                    {row.uniqueGroupCount ? `${row.uniqueGroupCount} groups` : ""}
                  </div>
                </div>
              </Td>
              <Td>
                <DutyStateBadge state={row.derived} />
                {row.override ? (
                  // The correction and the evidence it was laid over, side by side. "Marked absent,
                  // and there were forty messages" has to stay readable as exactly that — the
                  // override sits BESIDE the evidence in the schema for this reason, and hiding who
                  // decided it would waste that.
                  <div className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
                    {row.overriddenByName ? `Corrected by ${row.overriddenByName}` : "Corrected"}
                    {row.overriddenAtLabel ? ` · ${row.overriddenAtLabel}` : ""}
                    {row.overrideReason ? ` · “${row.overrideReason}”` : ""}
                  </div>
                ) : null}
              </Td>
              {canManage ? (
                <Td>
                  <div className="flex justify-end">
                    <AttendanceOverride
                      teamMemberId={row.teamMemberId}
                      memberName={row.memberName}
                      date={row.dutyDateIso}
                      current={row.override}
                      currentReason={row.overrideReason}
                    />
                  </div>
                </Td>
              ) : null}
            </tr>,
            isOpen ? (
              <tr key={`${row.id}-groups`}>
                <Td colSpan={columnCount} className="bg-[color:var(--color-surface-subtle)]">
                  {loaded === undefined ? (
                    <p className="py-2 text-sm text-[color:var(--color-muted-foreground)]">Loading groups…</p>
                  ) : loaded === "error" ? (
                    <p className="py-2 text-sm text-[color:var(--color-muted-foreground)]">
                      Those groups could not be loaded.
                    </p>
                  ) : loaded.length === 0 ? (
                    <p className="py-2 text-sm text-[color:var(--color-muted-foreground)]">
                      No per-group evidence was stored for this day.
                    </p>
                  ) : (
                    <div className="py-1">
                      <p className="mb-2 text-xs uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                        Groups worked · {row.dutyDateLabel}
                      </p>
                      <ul className="space-y-1">
                        {loaded.map((group) => (
                          <li key={group.groupId} className="flex flex-wrap items-baseline gap-x-3 text-sm">
                            <span className="font-medium">{group.groupName}</span>
                            <span className="tabular-nums text-[color:var(--color-muted-foreground)]">
                              {group.messageCount} {group.messageCount === 1 ? "message" : "messages"}
                            </span>
                            <span className="tabular-nums text-xs text-[color:var(--color-muted-foreground)]">
                              {timeOfDay(group.firstAt)} – {timeOfDay(group.lastAt)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </Td>
              </tr>
            ) : null,
          ];
        })}
      </tbody>
    </Table>
  );
}

/** The per-person fold of the same range. Sorted by what somebody opens this view to find. */
export interface DutyHistoryMemberTableRow {
  teamMemberId: string;
  memberName: string;
  daysScheduled: number;
  daysWorked: number;
  noActivityDays: number;
  offDayDuties: number;
  lateStarts: number;
  earlyFinishes: number;
  totalMessages: number;
  totalGroups: number;
  medianEngagedMinutes: number | null;
}

export function DutyHistoryByMemberTable({ rows }: { rows: DutyHistoryMemberTableRow[] }) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>Team member</Th>
          <Th>Scheduled</Th>
          <Th>Worked</Th>
          <Th>{DUTY_STATE_LABEL.NO_ACTIVITY}</Th>
          <Th>Off-day duty</Th>
          <Th>Late starts</Th>
          <Th>Early finishes</Th>
          <Th>Typical day</Th>
          <Th>Messages</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.teamMemberId}>
            <Td className="font-medium">{row.memberName}</Td>
            <Td className="tabular-nums">{row.daysScheduled}</Td>
            <Td className="tabular-nums">{row.daysWorked}</Td>
            <Td className="tabular-nums">{row.noActivityDays || "—"}</Td>
            <Td className="tabular-nums">{row.offDayDuties || "—"}</Td>
            <Td className="tabular-nums">
              {row.lateStarts > 0 ? <Badge color="yellow">{row.lateStarts}</Badge> : "—"}
            </Td>
            <Td className="tabular-nums">
              {row.earlyFinishes > 0 ? <Badge color="yellow">{row.earlyFinishes}</Badge> : "—"}
            </Td>
            <Td className="tabular-nums">{formatMinutesShort(row.medianEngagedMinutes)}</Td>
            <Td className="tabular-nums">
              <div className="leading-tight">
                <div>{row.totalMessages}</div>
                <div className="text-xs text-[color:var(--color-muted-foreground)]">
                  {row.totalGroups} group-days
                </div>
              </div>
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
