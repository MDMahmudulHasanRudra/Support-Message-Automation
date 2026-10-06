"use client";

import { Search, X } from "lucide-react";
import { useActionState, useMemo, useState } from "react";
import { hasReachablePhoneNumber, normalizeSenderKey } from "@support-automation/shared";
import Link from "@/components/ProjectLink";
import { Alert, Button, Card, Checkbox, Field, GroupPicker, Input, SectionHeader, SwitchField, Textarea } from "@/components/ui";
import { saveSupportAssignmentSettings, type SettingsState } from "@/server/actions/supportAssignment";

interface Props {
  canManage: boolean;
  supportTeamConfigured: boolean;
  settings: {
    enabled: boolean;
    ignoredKeywords: string[];
    ignoredSenders: string[];
    assignableTeamIds: string[];
    slaMinutes: number;
    escalationEnabled: boolean;
    escalationAfterMinutes: number;
    managerGroupIds: string[];
    adminMemberIds: string[];
    notifyEmployeeOnAssign: boolean;
    notifyEmployeeOnReassign: boolean;
    notifyManagerOnOverdue: boolean;
    notifyAdminOnOverdue: boolean;
    notifyAdminOnEscalation: boolean;
    notifyAdminOnCompletion: boolean;
  };
  teams: { id: string; name: string; memberCount: number }[];
  members: { id: string; name: string; role: string; phoneNumber: string; whatsappId: string | null; status: string }[];
  groups: { whatsappGroupId: string; name: string; isMonitored: boolean }[];
  recentSenders: { key: string; name: string | null; messages: number }[];
}

const initialState: SettingsState = {};
const SENDER_RENDER_LIMIT = 100;

/**
 * Ignored senders: picked from the customers who actually wrote recently, or typed. Chosen ones are
 * pinned on top; the list is searchable by name or number and draws at most a hundred rows.
 */
function IgnoredSenderPicker({ recent, initial, disabled }: { recent: Props["recentSenders"]; initial: string[]; disabled: boolean }) {
  const [selected, setSelected] = useState<string[]>(initial);
  const [query, setQuery] = useState("");
  const [typed, setTyped] = useState("");
  const names = useMemo(() => new Map(recent.map((r) => [r.key, r.name])), [recent]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return recent.filter((r) => !selected.includes(r.key) && (!q || r.key.includes(q) || (r.name ?? "").toLowerCase().includes(q)));
  }, [recent, selected, query]);
  const add = (key: string) => setSelected((prev) => (prev.includes(key) ? prev : [...prev, key]));
  const remove = (key: string) => setSelected((prev) => prev.filter((k) => k !== key));
  const typedKey = normalizeSenderKey(typed);

  return (
    <div>
      {selected.map((key) => (
        <input key={key} type="hidden" name="ignoredSenders" value={key} />
      ))}
      {selected.length ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {selected.map((key) => (
            <span key={key} className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--color-neutral-bg)] px-2 py-1 text-[12px]">
              {names.get(key) ? `${names.get(key)} · ` : ""}
              <span className="tabular">{key}</span>
              {disabled ? null : (
                <button type="button" onClick={() => remove(key)} aria-label={`Stop ignoring ${key}`} className="text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]">
                  <X className="size-3.5" />
                </button>
              )}
            </span>
          ))}
        </div>
      ) : (
        <p className="mb-2 text-[12px] text-[color:var(--color-muted-foreground)]">Nobody is ignored.</p>
      )}
      {disabled ? null : (
        <>
          <div className="relative mb-1.5">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-[color:var(--color-muted-foreground)]" aria-hidden />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search recent customers by name or number" className="pl-8" />
          </div>
          <div className="max-h-56 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border)]">
            {filtered.length === 0 ? (
              <p className="px-3 py-3 text-[12px] text-[color:var(--color-muted-foreground)]">No recent customer matches.</p>
            ) : (
              filtered.slice(0, SENDER_RENDER_LIMIT).map((r) => (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => add(r.key)}
                  className="flex w-full items-center gap-2 border-b border-[var(--color-border)] px-3 py-1.5 text-left text-[13px] last:border-b-0 hover:bg-[var(--color-neutral-bg)]"
                >
                  <span className="min-w-0 flex-1 truncate">{r.name ?? "Unknown name"}</span>
                  <span className="tabular text-[12px] text-[color:var(--color-muted-foreground)]">{r.key}</span>
                  <span className="tabular w-16 text-right text-[11px] text-[color:var(--color-muted-foreground)]">{r.messages} msg</span>
                </button>
              ))
            )}
          </div>
          {filtered.length > SENDER_RENDER_LIMIT ? (
            <p className="mt-1 text-[11px] text-[color:var(--color-muted-foreground)]">Showing {SENDER_RENDER_LIMIT} of {filtered.length} — search to narrow.</p>
          ) : null}
          <div className="mt-2 flex gap-2">
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Or type a number / WhatsApp id" className="max-w-xs" />
            <Button
              type="button"
              variant="secondary"
              disabled={typedKey.length < 6}
              onClick={() => {
                add(typedKey);
                setTyped("");
              }}
            >
              Add
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

export function SupportAssignmentSettingsForm({ canManage, supportTeamConfigured, settings, teams, members, groups, recentSenders }: Props) {
  const [state, formAction, pending] = useActionState(saveSupportAssignmentSettings, initialState);
  const disabled = !canManage;

  return (
    <form action={formAction} className="space-y-5">
      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
      {state.saved && !state.error ? (
        <Alert tone="success">
          Settings saved.
          {state.imported ? ` ${state.imported} customer(s) already waiting were brought in as cases.` : ""}
        </Alert>
      ) : null}
      {!supportTeamConfigured ? (
        <Alert tone="warning" title="Choose the Support Team first">
          Cases are built on the waits Messages → Unanswered groups tracks, and that tracks nothing until the Support Team is chosen under{" "}
          <Link href="/support-activity/settings" className="underline">
            Settings → Support Activity Setup
          </Link>
          . Until then this module stays empty even when switched on.
        </Alert>
      ) : null}

      <fieldset disabled={disabled} className="space-y-5">
        <Card>
          <SectionHeader title="General" />
          <SwitchField
            name="enabled"
            defaultChecked={settings.enabled}
            label="Enable Support Assignment"
            description="Opens a case for every customer waiting for a reply, follows each assignment, and runs the SLA alerts. Switching it on brings in the customers already waiting. Off, nothing is opened and no alert is sent; cases already recorded stay."
          />
        </Card>

        <Card>
          <SectionHeader
            title="Qualification"
            description="What is NOT a support case. These rules only exclude: a customer message with any other word in it is a case, whatever it says."
          />
          <div className="grid gap-5 lg:grid-cols-2">
            <Field
              label="Ignored keywords"
              hint={'One per line. A message made only of these words (plus "bhai", "sir", "ভাই" and the like) is filtered out. Matched as whole words: "ok" never matches "book".'}
            >
              <Textarea name="ignoredKeywords" rows={9} defaultValue={settings.ignoredKeywords.join("\n")} />
            </Field>
            <Field label="Ignored senders" hint="Customers whose messages never become a case — an owner's announcements, a reseller's staff. Team members never need listing: their messages are never cases.">
              <IgnoredSenderPicker recent={recentSenders} initial={settings.ignoredSenders} disabled={disabled} />
            </Field>
          </div>
          <p className="mt-3 text-[12px] text-[color:var(--color-muted-foreground)]">
            Filtered messages are not lost: they stay in the chat, and each filtered wait is kept under Support Assignment → Completed → Ignored.
          </p>
        </Card>

        <Card>
          <SectionHeader title="Assignment" description="Who can be given a case. Nobody chosen = every active team member." />
          {teams.length === 0 ? (
            <p className="text-[13px] text-[color:var(--color-muted-foreground)]">No Teams exist yet, so every active team member can be assigned.</p>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {teams.map((team) => (
                <label key={team.id} className="flex cursor-pointer items-center gap-2.5 rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2 text-[13px]">
                  <Checkbox name="assignableTeamIds" value={team.id} defaultChecked={settings.assignableTeamIds.includes(team.id)} />
                  <span className="font-medium">{team.name}</span>
                  <span className="ml-auto text-[11px] text-[color:var(--color-muted-foreground)]">{team.memberCount} active</span>
                </label>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <SectionHeader title="SLA & escalation" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Response time (minutes)" hint="How long the assignee has to reply in the group. A change applies to the next assignment; a running deadline never moves.">
              <Input name="slaMinutes" type="number" min={1} max={1440} defaultValue={settings.slaMinutes} className="w-32" />
            </Field>
            <Field label="Escalate after (minutes past overdue)" hint="With escalation on, admins are told once more if the case is still unanswered this long after it went overdue.">
              <Input name="escalationAfterMinutes" type="number" min={1} max={1440} defaultValue={settings.escalationAfterMinutes} className="w-32" />
            </Field>
          </div>
          <div className="mt-3">
            <SwitchField
              name="escalationEnabled"
              defaultChecked={settings.escalationEnabled}
              label="Escalate overdue cases"
              description="Once per assignment. A reply from the assignee — or anyone answering the customer — stops it."
            />
          </div>
        </Card>

        <Card>
          <SectionHeader title="Notifications" description="Every notification goes out on WhatsApp through the ordinary notification queue. Muting Support Assignment in the Notification Center stops all of them." />
          <div className="grid gap-3 lg:grid-cols-2">
            <SwitchField name="notifyEmployeeOnAssign" defaultChecked={settings.notifyEmployeeOnAssign} label="Message the employee when a case is assigned" />
            <SwitchField name="notifyEmployeeOnReassign" defaultChecked={settings.notifyEmployeeOnReassign} label="Message the new employee when a case is reassigned" />
            <SwitchField name="notifyManagerOnOverdue" defaultChecked={settings.notifyManagerOnOverdue} label="Tell the manager group when a case goes overdue" />
            <SwitchField name="notifyAdminOnOverdue" defaultChecked={settings.notifyAdminOnOverdue} label="Message the admins when a case goes overdue" />
            <SwitchField
              name="notifyAdminOnEscalation"
              defaultChecked={settings.notifyAdminOnEscalation}
              label="Message the admins on escalation"
              description="With no admin chosen, the escalation goes to the manager group instead, so it is never silent."
            />
            <SwitchField name="notifyAdminOnCompletion" defaultChecked={settings.notifyAdminOnCompletion} label="Message the admins when a case is completed" />
          </div>

          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            <Field label="Manager notification group" hint="Overdue alerts go here. Left empty, they use the Notification Center's groups for Support Assignment, then the global notification groups.">
              <GroupPicker name="managerGroupIds" groups={groups} defaultSelected={settings.managerGroupIds} emptyMeaning="Inherit the Notification Center's destination" />
            </Field>
            <Field label="Admins (personal WhatsApp)" hint="Team members messaged directly. Someone with only a WhatsApp id and no phone number cannot receive a direct message.">
              <div className="max-h-64 space-y-1 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border)] p-2">
                {members.length === 0 ? (
                  <p className="text-[12px] text-[color:var(--color-muted-foreground)]">No active team member.</p>
                ) : (
                  members.map((m) => {
                    const reachable = hasReachablePhoneNumber(m);
                    return (
                      <label key={m.id} className="flex cursor-pointer items-center gap-2.5 rounded-[var(--radius-sm)] px-2 py-1 text-[13px] hover:bg-[var(--color-neutral-bg)]">
                        <Checkbox name="adminMemberIds" value={m.id} defaultChecked={settings.adminMemberIds.includes(m.id)} />
                        <span className="font-medium">{m.name}</span>
                        <span className="truncate text-[11px] text-[color:var(--color-muted-foreground)]">
                          {m.role}
                          {m.status !== "ACTIVE" ? " · inactive" : ""}
                          {reachable ? "" : " · no phone number"}
                        </span>
                      </label>
                    );
                  })
                )}
              </div>
            </Field>
          </div>
        </Card>

        <Card>
          <SectionHeader title="Message templates" />
          <p className="text-[13px] text-[color:var(--color-muted-foreground)]">
            The wording of the five messages (assigned, reassigned, overdue, escalated, completed) is edited with every other alert under{" "}
            <Link href="/notifications/templates" className="underline">
              Notifications → Templates
            </Link>
            , where each can be previewed and test-sent.
          </p>
        </Card>
      </fieldset>

      {canManage ? (
        <div className="flex justify-end">
          <Button type="submit" loading={pending}>
            Save settings
          </Button>
        </div>
      ) : null}
    </form>
  );
}
