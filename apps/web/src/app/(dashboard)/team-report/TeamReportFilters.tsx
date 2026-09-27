"use client";

import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Field, Input, Select } from "@/components/ui";

/**
 * The report's filters. A plain GET form, like every other filter in this app, so a report is a URL
 * that can be bookmarked and sent to someone — it just submits itself the moment a choice changes
 * rather than waiting for an Apply press.
 *
 * Team and Team member cascade: picking a Team narrows the member list to the people who were in it
 * during the period, and a member who was not is reset to "all of that Team" before submitting — so
 * the form can never ask for a combination that means nothing.
 */
export function TeamReportFilters({
  period,
  date,
  from,
  to,
  memberId,
  teamId,
  granularity,
  members,
  teams,
  teamMemberIds,
}: {
  period: string;
  date: string;
  from: string;
  to: string;
  memberId: string | null;
  granularity: string;
  members: Array<{ id: string; name: string; status: string }>;
  teamId: string | null;
  teams: Array<{ id: string; name: string; status: string }>;
  teamMemberIds: Record<string, string[]>;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [chosenPeriod, setChosenPeriod] = useState(period);
  const [chosenTeam, setChosenTeam] = useState(teamId ?? "");
  const [chosenMember, setChosenMember] = useState(memberId ?? "");
  const inTeam = chosenTeam ? new Set(teamMemberIds[chosenTeam] ?? []) : null;
  const memberOptions = inTeam ? members.filter((member) => inTeam.has(member.id)) : members;
  const allLabel =
    chosenTeam === "none"
      ? "All members without a team"
      : chosenTeam
        ? `All ${teams.find((team) => team.id === chosenTeam)?.name ?? "team"} members`
        : "All team members";
  const submit = () => formRef.current?.requestSubmit();

  return (
    <form ref={formRef} method="GET" className="flex flex-wrap items-end gap-3">
      <Field label="Period">
        <Select
          name="period"
          value={chosenPeriod}
          className="w-36"
          onChange={(event) => {
            setChosenPeriod(event.target.value);
            // Custom needs dates filled in first; the others are complete as soon as they are picked.
            if (event.target.value !== "custom") queueMicrotask(submit);
          }}
        >
          <option value="day">Daily</option>
          <option value="week">Weekly</option>
          <option value="month">Monthly</option>
          <option value="custom">Custom range</option>
        </Select>
      </Field>

      {chosenPeriod === "custom" ? (
        <>
          <Field label="From">
            <Input type="date" name="from" defaultValue={from} className="w-40" onChange={submit} />
          </Field>
          <Field label="To">
            <Input type="date" name="to" defaultValue={to} className="w-40" onChange={submit} />
          </Field>
        </>
      ) : (
        <Field label={chosenPeriod === "day" ? "Day" : chosenPeriod === "week" ? "Any day in the week" : "Any day in the month"}>
          <Input type="date" name="date" defaultValue={date} className="w-44" onChange={submit} />
        </Field>
      )}

      <Field label="Team">
        <Select
          name="team"
          value={chosenTeam}
          className="w-48"
          onChange={(event) => {
            const next = event.target.value;
            // Rendered synchronously so the submitted form already carries the reset member.
            flushSync(() => {
              setChosenTeam(next);
              // A member who was not in the new Team would narrow it to nothing: fall back to all of it.
              if (next && chosenMember && !(teamMemberIds[next] ?? []).includes(chosenMember)) setChosenMember("");
            });
            submit();
          }}
        >
          <option value="">All teams</option>
          {teams.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
              {team.status === "ACTIVE" ? "" : " (disabled)"}
            </option>
          ))}
          <option value="none">No team</option>
        </Select>
      </Field>

      <Field label="Team member">
        <Select
          name="member"
          value={chosenMember}
          className="w-56"
          onChange={(event) => {
            flushSync(() => setChosenMember(event.target.value));
            submit();
          }}
        >
          <option value="">{allLabel}</option>
          {memberOptions.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name}
              {member.status === "ACTIVE" ? "" : " (inactive)"}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Break down by">
        <Select name="by" defaultValue={granularity} className="w-32" onChange={submit}>
          <option value="day">Day</option>
          <option value="week">Week</option>
          <option value="month">Month</option>
        </Select>
      </Field>

      {/* Needed for Custom (two dates, one submit) and as the keyboard path for everything else. */}
      <button
        type="submit"
        className="h-9.5 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3.5 text-[13px] font-medium text-[color:var(--color-foreground)] transition-colors hover:bg-[var(--color-neutral-bg)]"
      >
        Apply
      </button>
    </form>
  );
}
