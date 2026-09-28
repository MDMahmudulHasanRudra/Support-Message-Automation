"use client";

import { useActionState, useState } from "react";
import { Alert, Button, Card, Checkbox, Field, Input, Label, Select, SectionHeader, Switch, Textarea } from "@/components/ui";
import type { RuleFormState } from "@/server/actions/rules";

const RULE_TYPES = [
  "GENERIC",
  "DEFAULT_IGNORE",
  "LAST_SENDER",
  "EXCEPTION",
  "SUPPORT_ESCALATION",
  "AUTO_REPLY",
  "TEAM_FILTER",
];
const MATCH_TYPES = ["ALWAYS", "EXACT", "CONTAINS", "KEYWORDS", "REGEX"];
const STATUSES = ["DRAFT", "ACTIVE", "DISABLED", "ARCHIVED"];
const ACTION_TYPES = [
  "IGNORE",
  "TAG",
  "AUTO_REPLY",
  "SUPPORT_REQUIRED",
  "NOTIFY_TEAMS",
  "NOTIFY_WHATSAPP",
  "FORWARD",
  "STOP_PROCESSING",
];

export interface RuleFormDefaults {
  name?: string;
  description?: string;
  type?: string;
  matchType?: string;
  matchValue?: string;
  keywords?: string[];
  priority?: number;
  status?: string;
  cooldownSeconds?: number | null;
  replyMessage?: string;
  replyDelayMinMs?: number | null;
  replyDelayMaxMs?: number | null;
  senderType?: string;
  previousSenderType?: string;
  groupIds?: string;
  actionTypes?: string[];
  actionTag?: string;
  actionCategory?: string;
  actionForwardChatId?: string;
  timeWindowEnabled?: boolean;
  timeWindowStartHour?: number;
  timeWindowEndHour?: number;
  timeWindowDays?: number[];
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function hourToTimeValue(hour: number | undefined): string {
  return `${String(hour ?? 0).padStart(2, "0")}:00`;
}

export function RuleForm({
  action,
  defaults = {},
  submitLabel = "Save",
}: {
  action: (prevState: RuleFormState, formData: FormData) => Promise<RuleFormState>;
  defaults?: RuleFormDefaults;
  submitLabel?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const [matchType, setMatchType] = useState(defaults.matchType ?? "ALWAYS");
  const [selectedActions, setSelectedActions] = useState<Set<string>>(new Set(defaults.actionTypes ?? []));
  const [scheduleEnabled, setScheduleEnabled] = useState(Boolean(defaults.timeWindowEnabled));
  const [startTime, setStartTime] = useState(hourToTimeValue(defaults.timeWindowStartHour));
  const [endTime, setEndTime] = useState(hourToTimeValue(defaults.timeWindowEndHour));
  const isOvernightWindow = Number(startTime.split(":")[0]) >= Number(endTime.split(":")[0]);

  function toggleAction(type: string, checked: boolean) {
    setSelectedActions((prev) => {
      const next = new Set(prev);
      if (checked) next.add(type);
      else next.delete(type);
      return next;
    });
  }

  return (
    <form action={formAction} className="space-y-4">
      <Card>
        <SectionHeader title="Basics" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Name" required>
            <Input name="name" defaultValue={defaults.name} required />
          </Field>
          <Field label="Type">
            <Select name="type" defaultValue={defaults.type ?? "GENERIC"}>
              {RULE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Priority" hint="Higher numbers are evaluated first.">
            <Input name="priority" type="number" defaultValue={defaults.priority ?? 0} />
          </Field>
          <Field label="Status">
            <Select name="status" defaultValue={defaults.status ?? "DRAFT"}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="mt-4">
          <Field label="Description">
            <Textarea name="description" defaultValue={defaults.description} rows={2} />
          </Field>
        </div>
      </Card>

      <Card>
        <SectionHeader title="Trigger" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Match Type">
            <Select name="matchType" value={matchType} onChange={(e) => setMatchType(e.target.value)}>
              {MATCH_TYPES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Match Value"
            hint={matchType === "REGEX" ? "Validated server-side before saving (length, quantifiers, ReDoS shapes)." : undefined}
            className={matchType === "EXACT" || matchType === "CONTAINS" || matchType === "REGEX" ? "" : "hidden"}
          >
            <Input name="matchValue" defaultValue={defaults.matchValue} />
          </Field>
          <Field label="Keywords" hint="Comma-separated." className={matchType === "KEYWORDS" ? "" : "hidden"}>
            <Input name="keywords" defaultValue={defaults.keywords?.join(", ")} />
          </Field>
        </div>
      </Card>

      <Card>
        <SectionHeader title="Conditions" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Current Sender">
            <Select name="senderType" defaultValue={defaults.senderType ?? "ANY"}>
              <option value="ANY">Any</option>
              <option value="TEAM_MEMBER">Team Member</option>
              <option value="CLIENT">Client</option>
            </Select>
          </Field>
          <Field label="Previous Sender" hint="Used by last-sender rules.">
            <Select name="previousSenderType" defaultValue={defaults.previousSenderType ?? "NONE"}>
              <option value="NONE">Not used</option>
              <option value="ANY">Any</option>
              <option value="TEAM_MEMBER">Team Member</option>
              <option value="CLIENT">Client</option>
            </Select>
          </Field>
          <Field label="Group Scope" hint="Comma-separated group IDs, blank = all.">
            <Input name="groupIds" defaultValue={defaults.groupIds} />
          </Field>
        </div>

        <label className="mt-4 flex items-center gap-2 text-sm text-[color:var(--color-foreground)]">
          <Switch
            name="timeWindowEnabled"
            defaultChecked={scheduleEnabled}
            onChange={(e) => setScheduleEnabled(e.target.checked)}
          />
          Only active during specific hours
        </label>

        <div
          className={
            scheduleEnabled
              ? "mt-3 space-y-4 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-neutral-bg)]/40 p-4"
              : "hidden"
          }
        >
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field
              label="Active from"
              hint="Minutes are ignored — only the hour is used. Supports overnight windows, e.g. 22:00 to 06:00."
            >
              <Input
                type="time"
                step={3600}
                name="timeWindowStartHour"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value || "00:00")}
              />
            </Field>
            <Field label="Active until">
              <Input
                type="time"
                step={3600}
                name="timeWindowEndHour"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value || "00:00")}
              />
            </Field>
          </div>
          <div>
            <Label>Days</Label>
            <div className="flex flex-wrap gap-3">
              {DAY_LABELS.map((label, day) => (
                <label key={day} className="flex items-center gap-1.5 text-sm text-[color:var(--color-foreground)]">
                  <Checkbox name={`timeWindowDay_${day}`} defaultChecked={defaults.timeWindowDays?.includes(day)} />
                  {label}
                </label>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-[color:var(--color-muted-foreground)]">
              Leave all unchecked to apply every day.
              {isOvernightWindow
                ? " Overnight window: the day filter matches the day a message arrives on — a message after midnight counts as the next day, so select both days for full overnight coverage."
                : ""}
            </p>
          </div>
        </div>
      </Card>

      <Card>
        <SectionHeader title="Actions" />
        <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
          {ACTION_TYPES.map((a) => (
            <label
              key={a}
              className={`flex items-center gap-2 rounded-[var(--radius-sm)] border px-3 py-2 text-sm transition-colors duration-150 ${
                selectedActions.has(a)
                  ? "border-[var(--color-primary)]/40 bg-[var(--color-primary-soft)] text-[color:var(--color-foreground)]"
                  : "border-[var(--color-border)] text-[color:var(--color-foreground)] hover:border-[var(--color-border-strong)]"
              }`}
            >
              <Checkbox
                name={`action_${a}`}
                defaultChecked={selectedActions.has(a)}
                onChange={(e) => toggleAction(a, e.target.checked)}
              />
              {a}
            </label>
          ))}
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="TAG value" className={selectedActions.has("TAG") ? "" : "hidden"}>
            <Input name="actionTag" defaultValue={defaults.actionTag} />
          </Field>
          <Field
            label="SUPPORT_REQUIRED category"
            className={selectedActions.has("SUPPORT_REQUIRED") ? "" : "hidden"}
          >
            <Input name="actionCategory" defaultValue={defaults.actionCategory} />
          </Field>
          <Field label="FORWARD target chat id" className={selectedActions.has("FORWARD") ? "" : "hidden"}>
            <Input name="actionForwardChatId" defaultValue={defaults.actionForwardChatId} />
          </Field>
        </div>
      </Card>

      <Card className={selectedActions.has("AUTO_REPLY") ? "" : "hidden"}>
        <SectionHeader title="Auto-Reply Safety" description="Used when the AUTO_REPLY action is checked." />
        <Field label="Reply Message">
          <Textarea name="replyMessage" defaultValue={defaults.replyMessage} rows={3} />
        </Field>
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Cooldown (seconds)">
            <Input name="cooldownSeconds" type="number" defaultValue={defaults.cooldownSeconds ?? ""} />
          </Field>
          <Field label="Reply delay min (ms)">
            <Input name="replyDelayMinMs" type="number" defaultValue={defaults.replyDelayMinMs ?? ""} />
          </Field>
          <Field label="Reply delay max (ms)">
            <Input name="replyDelayMaxMs" type="number" defaultValue={defaults.replyDelayMaxMs ?? ""} />
          </Field>
        </div>
      </Card>

      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}

      <Button type="submit" loading={pending}>
        {submitLabel}
      </Button>
    </form>
  );
}
