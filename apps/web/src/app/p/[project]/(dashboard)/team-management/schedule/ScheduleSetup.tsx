"use client";

import { CalendarCheck2 } from "lucide-react";
import { useState, useTransition } from "react";
import { Button, Card, Checkbox, Field, Select, SwitchField, useToast } from "@/components/ui";
import { applyWeeklySchedule, setTeamAutomation } from "@/server/actions/teamAutomation";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Setting the team's week once. Choose a shift and the weekly days off, and the roster fills itself from then on.
 * Opens by itself while anybody has no schedule; afterwards it is there for changes.
 */
export function ScheduleSetup({
  templates,
  members,
  autoRoster,
}: {
  templates: Array<{ id: string; name: string }>;
  members: Array<{ id: string; name: string; scheduled: boolean }>;
  autoRoster: boolean;
}) {
  const { showToast } = useToast();
  const [pending, start] = useTransition();
  const unscheduled = members.filter((m) => !m.scheduled);
  const [shift, setShift] = useState(templates[0]?.id ?? "");
  // Friday off is the common week in Bangladesh; one click changes it.
  const [daysOff, setDaysOff] = useState(new Set([5]));
  const [chosen, setChosen] = useState(new Set((unscheduled.length ? unscheduled : members).map((m) => m.id)));

  const toggle = <T,>(set: Set<T>, value: T, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(value);
    else next.delete(value);
    return next;
  };

  return (
    <Card className="mb-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[15px] font-semibold text-[color:var(--color-foreground)]">
            <CalendarCheck2 className="size-4 text-[color:var(--color-accent)]" aria-hidden />
            {unscheduled.length ? `${unscheduled.length} of ${members.length} people have no schedule yet` : "The roster fills itself"}
          </div>
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
            Set the week once. Every day after that is written for you, two weeks ahead. Moving somebody on one day, leave and holidays are
            always respected.
          </p>
        </div>
        <SwitchField
          label="Fill the roster automatically"
          defaultChecked={autoRoster}
          onChange={(event) => {
            const on = event.currentTarget.checked;
            start(async () => {
              await setTeamAutomation("autoRoster", on);
            });
          }}
        />
      </div>

      <details className="mt-4" open={unscheduled.length > 0}>
        <summary className="cursor-pointer text-[13px] font-medium text-[color:var(--color-foreground)]">Set the week for several people</summary>
        <div className="mt-3 flex flex-wrap items-end gap-4">
          <Field label="Shift">
            <Select value={shift} onChange={(event) => setShift(event.currentTarget.value)}>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </Select>
          </Field>
          <div>
            <div className="mb-1.5 text-[13px] font-medium text-[color:var(--color-foreground)]">Days off every week</div>
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAYS.map((day, weekday) => (
                <button
                  key={day}
                  type="button"
                  aria-pressed={daysOff.has(weekday)}
                  onClick={() => setDaysOff(toggle(daysOff, weekday, !daysOff.has(weekday)))}
                  className={`h-9 rounded-[var(--radius-md)] border px-3 text-[13px] transition-colors ${
                    daysOff.has(weekday)
                      ? "border-[var(--color-accent)] bg-[var(--color-accent-bg)] font-medium text-[color:var(--color-accent)]"
                      : "border-[var(--color-border)] text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)]"
                  }`}
                >
                  {day}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-4">
          <div className="mb-1.5 flex flex-wrap items-center gap-3 text-[13px] font-medium text-[color:var(--color-foreground)]">
            For
            <button type="button" className="link text-xs font-normal" onClick={() => setChosen(new Set(members.map((m) => m.id)))}>
              Everyone
            </button>
            <button type="button" className="link text-xs font-normal" onClick={() => setChosen(new Set())}>
              Nobody
            </button>
          </div>
          <div className="grid max-h-48 gap-1.5 overflow-y-auto sm:grid-cols-2 lg:grid-cols-4">
            {members.map((member) => (
              <label key={member.id} className="flex items-center gap-2 text-[13px]">
                <Checkbox checked={chosen.has(member.id)} onChange={(event) => setChosen(toggle(chosen, member.id, event.currentTarget.checked))} />
                <span className="truncate">{member.name}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="mt-4">
          <Button
            size="sm"
            loading={pending}
            disabled={!shift || chosen.size === 0}
            onClick={() =>
              start(async () => {
                const result = await applyWeeklySchedule({ shiftTemplateId: shift, daysOff: [...daysOff], memberIds: [...chosen] });
                showToast(result.error ? { tone: "danger", title: result.error } : { tone: "success", title: result.message ?? "Saved" });
              })
            }
          >
            Apply to {chosen.size} {chosen.size === 1 ? "person" : "people"}
          </Button>
        </div>
      </details>
    </Card>
  );
}
