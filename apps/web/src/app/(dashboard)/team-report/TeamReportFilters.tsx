"use client";

import { useRef, useState } from "react";
import { Field, Input, Select } from "@/components/ui";

/**
 * The report's filters. A plain GET form, like every other filter in this app, so a report is a URL
 * that can be bookmarked and sent to someone — it just submits itself the moment a choice changes
 * rather than waiting for an Apply press.
 */
export function TeamReportFilters({
  period,
  date,
  from,
  to,
  memberId,
  granularity,
  members,
}: {
  period: string;
  date: string;
  from: string;
  to: string;
  memberId: string | null;
  granularity: string;
  members: Array<{ id: string; name: string; status: string }>;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [chosenPeriod, setChosenPeriod] = useState(period);
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

      <Field label="Team member">
        <Select name="member" defaultValue={memberId ?? ""} className="w-56" onChange={submit}>
          <option value="">All team members</option>
          {members.map((member) => (
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
