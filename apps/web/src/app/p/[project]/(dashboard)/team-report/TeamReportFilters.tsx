"use client";

import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import Link from "@/components/ProjectLink";
import { Field, Input, Select } from "@/components/ui";
import { GroupFilter } from "./GroupFilter";

export interface PresetLink {
  id: string;
  label: string;
  href: string;
  active: boolean;
}

/** A report's own extra filter (a metric, a status): rendered as one more select in the form. */
export interface ExtraSelect {
  name: string;
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
}

/**
 * The report's filters. A plain GET form, like every other filter in this app, so a report is a URL
 * that can be bookmarked and sent to someone — it just submits itself the moment a choice changes
 * rather than waiting for an Apply press.
 *
 * Team and Team member cascade: picking a Team narrows the member list to the people who were in it
 * during the period, and a member who was not is reset to "all of that Team" before submitting — so
 * the form can never ask for a combination that means nothing.
 *
 * Shared by the Team Report and every report at /reports/<id>. The date presets are links to ordinary
 * period/date URLs, and Groups and WhatsApp account are two more fields; with nothing chosen they add
 * nothing to the URL, so an existing report link means exactly what it meant.
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
  presets = [],
  groupOptions,
  groupKeys = [],
  accounts,
  accountId = null,
  showGranularity = true,
  selects = [],
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
  presets?: PresetLink[];
  /** Offer the Groups filter (omit to hide it). */
  groupOptions?: Array<{ whatsappGroupId: string; name: string; isMonitored: boolean }>;
  groupKeys?: string[];
  /** Offer the WhatsApp account filter (omit, or one account, to hide it). */
  accounts?: Array<{ id: string; label: string; phoneNumber: string | null }>;
  accountId?: string | null;
  showGranularity?: boolean;
  selects?: ExtraSelect[];
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
    <div>
      {presets.length ? (
        <nav aria-label="Quick periods" className="mb-3 flex flex-wrap gap-1.5">
          {presets.map((preset) => (
            <Link
              key={preset.id}
              href={preset.href}
              aria-current={preset.active ? "true" : undefined}
              className={`rounded-full border px-3 py-1 text-[12px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] focus-visible:outline-none ${
                preset.active
                  ? "border-[var(--color-primary)] bg-[var(--color-accent-bg)] text-[color:var(--color-foreground)]"
                  : "border-[var(--color-border)] text-[color:var(--color-muted-foreground)] hover:border-[var(--color-border-strong)] hover:text-[color:var(--color-foreground)]"
              }`}
            >
              {preset.label}
            </Link>
          ))}
        </nav>
      ) : null}
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

      {groupOptions ? (
        <Field label="Groups">
          {/* Keyed on the applied selection, so Back/Forward to another selection starts from it. */}
          <GroupFilter key={groupKeys.join(",")} groups={groupOptions} selected={groupKeys} onApply={submit} />
        </Field>
      ) : null}

      {accounts && (accounts.length > 1 || accountId) ? (
        <Field label="WhatsApp account">
          <Select name="account" defaultValue={accountId ?? ""} className="w-48" onChange={submit}>
            <option value="">All accounts</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.label}
                {account.phoneNumber ? ` (${account.phoneNumber})` : ""}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      {showGranularity ? (
        <Field label="Break down by">
          <Select name="by" defaultValue={granularity} className="w-32" onChange={submit}>
            <option value="day">Day</option>
            <option value="week">Week</option>
            <option value="month">Month</option>
          </Select>
        </Field>
      ) : (
        <input type="hidden" name="by" value={granularity} />
      )}

      {selects.map((select) => (
        <Field key={select.name} label={select.label}>
          <Select name={select.name} defaultValue={select.value} className="w-52" onChange={submit}>
            {select.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
      ))}

      {/* Needed for Custom (two dates, one submit) and as the keyboard path for everything else. */}
      <button
        type="submit"
        className="h-9.5 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3.5 text-[13px] font-medium text-[color:var(--color-foreground)] transition-colors hover:bg-[var(--color-neutral-bg)]"
      >
        Apply
      </button>
    </form>
    </div>
  );
}
