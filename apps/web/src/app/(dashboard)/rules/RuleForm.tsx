"use client";

import { useActionState } from "react";
import { Button, Card } from "@/components/ui";
import type { RuleFormState } from "@/server/actions/rules";

const RULE_TYPES = ["GENERIC", "DEFAULT_IGNORE", "LAST_SENDER", "EXCEPTION", "SUPPORT_ESCALATION", "AUTO_REPLY", "TEAM_FILTER"];
const MATCH_TYPES = ["ALWAYS", "EXACT", "CONTAINS", "KEYWORDS", "REGEX"];
const STATUSES = ["DRAFT", "ACTIVE", "DISABLED", "ARCHIVED"];
const ACTION_TYPES = ["IGNORE", "TAG", "AUTO_REPLY", "SUPPORT_REQUIRED", "NOTIFY_TEAMS", "NOTIFY_WHATSAPP", "FORWARD", "STOP_PROCESSING"];

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
  const selectedActions = new Set(defaults.actionTypes ?? []);

  return (
    <form action={formAction} className="space-y-6">
      <Card>
        <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Basics</h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Name">
            <input name="name" defaultValue={defaults.name} required className={inputClass} />
          </Field>
          <Field label="Type">
            <select name="type" defaultValue={defaults.type ?? "GENERIC"} className={inputClass}>
              {RULE_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </Field>
          <Field label="Priority (higher runs first)">
            <input name="priority" type="number" defaultValue={defaults.priority ?? 0} className={inputClass} />
          </Field>
          <Field label="Status">
            <select name="status" defaultValue={defaults.status ?? "DRAFT"} className={inputClass}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Description" className="mt-3">
          <textarea name="description" defaultValue={defaults.description} rows={2} className={inputClass} />
        </Field>
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Trigger</h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Match Type">
            <select name="matchType" defaultValue={defaults.matchType ?? "ALWAYS"} className={inputClass}>
              {MATCH_TYPES.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </Field>
          <Field label="Match Value (EXACT / CONTAINS / REGEX)">
            <input name="matchValue" defaultValue={defaults.matchValue} className={inputClass} />
          </Field>
        </div>
        <Field label="Keywords (comma-separated, used when Match Type = KEYWORDS)" className="mt-3">
          <input name="keywords" defaultValue={defaults.keywords?.join(", ")} className={inputClass} />
        </Field>
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Conditions</h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field label="Current Sender">
            <select name="senderType" defaultValue={defaults.senderType ?? "ANY"} className={inputClass}>
              <option value="ANY">Any</option>
              <option value="TEAM_MEMBER">Team Member</option>
              <option value="CLIENT">Client</option>
            </select>
          </Field>
          <Field label="Previous Sender (last-sender rules)">
            <select name="previousSenderType" defaultValue={defaults.previousSenderType ?? "NONE"} className={inputClass}>
              <option value="NONE">Not used</option>
              <option value="ANY">Any</option>
              <option value="TEAM_MEMBER">Team Member</option>
              <option value="CLIENT">Client</option>
            </select>
          </Field>
          <Field label="Group Scope (comma-separated group IDs, blank = all)">
            <input name="groupIds" defaultValue={defaults.groupIds} className={inputClass} />
          </Field>
        </div>
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Actions</h2>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {ACTION_TYPES.map((a) => (
            <label key={a} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name={`action_${a}`} defaultChecked={selectedActions.has(a)} />
              {a}
            </label>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field label="TAG value">
            <input name="actionTag" defaultValue={defaults.actionTag} className={inputClass} />
          </Field>
          <Field label="SUPPORT_REQUIRED category">
            <input name="actionCategory" defaultValue={defaults.actionCategory} className={inputClass} />
          </Field>
          <Field label="FORWARD target chat id">
            <input name="actionForwardChatId" defaultValue={defaults.actionForwardChatId} className={inputClass} />
          </Field>
        </div>
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">
          Auto-Reply Safety (used when the AUTO_REPLY action is checked)
        </h2>
        <Field label="Reply Message">
          <textarea name="replyMessage" defaultValue={defaults.replyMessage} rows={3} className={inputClass} />
        </Field>
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field label="Cooldown (seconds)">
            <input name="cooldownSeconds" type="number" defaultValue={defaults.cooldownSeconds ?? ""} className={inputClass} />
          </Field>
          <Field label="Reply delay min (ms)">
            <input name="replyDelayMinMs" type="number" defaultValue={defaults.replyDelayMinMs ?? ""} className={inputClass} />
          </Field>
          <Field label="Reply delay max (ms)">
            <input name="replyDelayMaxMs" type="number" defaultValue={defaults.replyDelayMaxMs ?? ""} className={inputClass} />
          </Field>
        </div>
      </Card>

      {state.error ? <p className="text-sm text-red-600">{state.error}</p> : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Saving..." : submitLabel}
      </Button>
    </form>
  );
}

const inputClass =
  "w-full rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900";

function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">{label}</label>
      {children}
    </div>
  );
}
