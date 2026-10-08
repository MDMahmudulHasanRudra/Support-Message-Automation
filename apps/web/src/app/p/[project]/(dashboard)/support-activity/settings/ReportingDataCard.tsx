"use client";

import { useActionState } from "react";
import { describeGapCause, formatDhakaMoment, formatDhakaSpan } from "@support-automation/shared";
import { Alert, Badge, type BadgeColor, Button, Card, Field, Input, SectionHeader } from "@/components/ui";
import { saveReportingVerifiedFrom, type VerifiedFromState } from "@/server/actions/reportingDataHealth";

const initialState: VerifiedFromState = {};

export interface RecentGap {
  id: string;
  accountLabel: string;
  cause: string;
  startedAt: number;
  endedAt: number | null;
  recoveryStatus: string | null;
  recoveredCount: number;
}

const RECOVERY: Record<string, { label: string; color: BadgeColor }> = {
  RECOVERED: { label: "Recovered", color: "green" },
  PARTIAL: { label: "Partly recovered", color: "yellow" },
  FAILED: { label: "Recovery failed", color: "red" },
  NOT_ATTEMPTED: { label: "Not recoverable", color: "red" },
};

/** The datetime-local value for an instant, in Asia/Dhaka. */
const toDhakaInput = (ms: number) => new Date(ms + 6 * 3_600_000).toISOString().slice(0, 16);

/**
 * Reporting data health: the project's verified-from moment, and the collection gaps recorded since
 * gap recording began — the evidence an admin needs before stating that reporting is trustworthy.
 */
export function ReportingDataCard({
  verifiedFrom,
  firstGapRecordedAt,
  gaps,
  canManage,
}: {
  verifiedFrom: number | null;
  firstGapRecordedAt: number | null;
  gaps: RecentGap[];
  canManage: boolean;
}) {
  const [state, formAction, pending] = useActionState(saveReportingVerifiedFrom, initialState);
  return (
    <Card className="mt-5">
      <SectionHeader
        title="Reporting data health"
        description="Reports are labelled historical / unverified before this moment. After it, a period is verified unless a collection gap overlaps it — then the report says exactly which hours may be incomplete."
      />
      {state.error ? (
        <div className="mb-3">
          <Alert tone="danger">{state.error}</Alert>
        </div>
      ) : null}
      {state.saved && !state.error ? (
        <div className="mb-3">
          <Alert tone="success">{state.saved}</Alert>
        </div>
      ) : null}

      <p className="mb-3 text-[13px] text-[color:var(--color-muted-foreground)]">
        {verifiedFrom ? (
          <>
            Verified from <strong className="text-[color:var(--color-foreground)]">{formatDhakaMoment(verifiedFrom)}</strong> (Asia/Dhaka).
          </>
        ) : (
          <>Not set — every report currently shows its figures as historical / unverified.</>
        )}{" "}
        Collection gaps are recorded from the moment this feature was installed; nothing before that can be reconstructed, which is why
        this date is yours to set rather than assumed.
      </p>

      {canManage ? (
        <form action={formAction} className="mb-4 flex flex-wrap items-end gap-3">
          <Field label="Verified from (Asia/Dhaka)" hint="Choose a moment from which collection health has been recorded and you trust the data.">
            <Input name="verifiedFrom" type="datetime-local" defaultValue={verifiedFrom ? toDhakaInput(verifiedFrom) : ""} />
          </Field>
          <Button type="submit" name="intent" value="save" disabled={pending}>
            Save
          </Button>
          {verifiedFrom ? (
            <Button type="submit" name="intent" value="clear" variant="secondary" disabled={pending}>
              Clear
            </Button>
          ) : null}
        </form>
      ) : null}

      <h3 className="mb-2 text-[13px] font-semibold text-[color:var(--color-foreground)]">Recent collection gaps</h3>
      {gaps.length === 0 ? (
        <p className="text-[13px] text-[color:var(--color-muted-foreground)]">
          {firstGapRecordedAt === null ? "None recorded yet." : "None in the latest records."}
        </p>
      ) : (
        <ul className="divide-y divide-[var(--color-border)] text-[13px]">
          {gaps.map((g) => {
            const recovery = g.endedAt === null ? { label: "Ongoing", color: "red" as BadgeColor } : (RECOVERY[g.recoveryStatus ?? ""] ?? { label: "No recovery recorded", color: "yellow" as BadgeColor });
            return (
              <li key={g.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <strong className="font-medium text-[color:var(--color-foreground)]">{g.accountLabel}</strong>{" "}
                  <span className="text-[color:var(--color-muted-foreground)]">
                    · {describeGapCause(g.cause)} · {g.endedAt === null ? `since ${formatDhakaMoment(g.startedAt)}` : formatDhakaSpan(g.startedAt, g.endedAt)}
                  </span>
                </span>
                <Badge color={recovery.color}>
                  {recovery.label}
                  {g.recoveryStatus === "RECOVERED" && g.recoveredCount ? ` · ${g.recoveredCount}` : ""}
                </Badge>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
