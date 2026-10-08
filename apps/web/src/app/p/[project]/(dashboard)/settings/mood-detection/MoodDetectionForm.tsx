"use client";

import { useActionState, useState } from "react";
import {
  ALERT_PRIORITIES,
  CONVERSATION_BEHAVIOURS,
  CONVERSATION_BEHAVIOUR_LABELS,
  DEFAULT_MOOD_POLICIES,
  MOOD_EMOJI,
  MOOD_LABELS,
  SENSITIVITY_THRESHOLDS,
  TRIGGERABLE_MOODS,
  type MoodPolicies,
  type MoodPolicy,
  type TriggerableMood,
} from "@support-automation/shared";
import { Alert, Badge, Button, Card, Checkbox, Field, GroupPicker, Input, SectionHeader, Select, SwitchField, type PickableGroup } from "@/components/ui";
import { MOOD_COOLDOWN_PRESETS, policyField } from "@/lib/moodDetectionForm";
import { saveMoodDetectionSettings, type MoodSettingsState } from "@/server/actions/moodDetection";
import type { MoodSettingsView } from "@/server/moodDetectionReports";

const initialState: MoodSettingsState = {};

const POLICY_CHECKS: Array<{ field: keyof MoodPolicy; label: string; hint: string }> = [
  { field: "notifyTeam", label: "Notify the team", hint: "Through Notification Center: its alert groups, Teams, and anyone who opted in personally." },
  { field: "internalAlert", label: "Alert the internal group", hint: "A WhatsApp alert to the internal escalation group chosen below." },
  { field: "mentionMember", label: "Mention the responsible member", hint: "Tags the group's assigned member in that internal alert." },
  { field: "needsAttention", label: "Mark as needing attention", hint: "Puts the conversation back on WhatsApp Chat's Waiting list." },
  { field: "customerMessage", label: "Send a message to the customer", hint: "A professional holding message in their group. Wording: Message Templates." },
];

const SENSITIVITY_OPTIONS = [
  { value: "LOW", label: `Low — only clear cases (${SENSITIVITY_THRESHOLDS.LOW}%)` },
  { value: "BALANCED", label: `Balanced — recommended (${SENSITIVITY_THRESHOLDS.BALANCED}%)` },
  { value: "HIGH", label: `High — catches more, more false alarms (${SENSITIVITY_THRESHOLDS.HIGH}%)` },
  { value: "CUSTOM", label: "Custom threshold…" },
];

function PolicyCard({ mood, policy, canManage }: { mood: TriggerableMood; policy: MoodPolicy; canManage: boolean }) {
  const [trigger, setTrigger] = useState(policy.trigger);
  const [internal, setInternal] = useState(policy.internalAlert);
  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <label className="flex cursor-pointer items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-[14px] font-semibold text-[color:var(--color-foreground)]">
          <span aria-hidden>{MOOD_EMOJI[mood]}</span>
          {MOOD_LABELS[mood]}
        </span>
        <span className="flex items-center gap-2 text-[12px] text-[color:var(--color-muted-foreground)]">
          {trigger ? <Badge color="blue">Triggers</Badge> : <Badge color="gray">Recorded only</Badge>}
          <Checkbox
            name={policyField(mood, "trigger")}
            checked={trigger}
            onChange={(e) => setTrigger(e.target.checked)}
            disabled={!canManage}
            aria-label={`${MOOD_LABELS[mood]} triggers actions`}
          />
        </span>
      </label>
      <fieldset disabled={!canManage || !trigger} className="mt-3 space-y-2 disabled:opacity-60">
        {POLICY_CHECKS.map((check) => {
          const isMention = check.field === "mentionMember";
          const disabled = isMention && !internal;
          return (
            <label key={check.field} className={`flex items-start gap-2.5 text-[13px] ${disabled ? "opacity-50" : "cursor-pointer"}`}>
              <Checkbox
                name={policyField(mood, check.field)}
                defaultChecked={Boolean(policy[check.field])}
                disabled={disabled}
                onChange={check.field === "internalAlert" ? (e) => setInternal(e.target.checked) : undefined}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium text-[color:var(--color-foreground)]">{check.label}</span>
                <span className="block text-xs text-[color:var(--color-muted-foreground)]">{check.hint}</span>
              </span>
            </label>
          );
        })}
        <div className="grid grid-cols-1 gap-3 pt-1 sm:grid-cols-2">
          <Field label="Conversation">
            <Select name={policyField(mood, "conversation")} defaultValue={policy.conversation}>
              {CONVERSATION_BEHAVIOURS.map((b) => (
                <option key={b} value={b}>
                  {CONVERSATION_BEHAVIOUR_LABELS[b]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Alert priority">
            <Select name={policyField(mood, "priority")} defaultValue={policy.priority}>
              {ALERT_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p.charAt(0) + p.slice(1).toLowerCase()}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </fieldset>
      {/* A disabled fieldset submits nothing; keep the values so switching a mood off loses no choices. */}
      {!trigger ? <HiddenPolicy mood={mood} policy={policy} /> : null}
    </div>
  );
}

function HiddenPolicy({ mood, policy }: { mood: TriggerableMood; policy: MoodPolicy }) {
  return (
    <>
      {POLICY_CHECKS.filter((c) => policy[c.field]).map((c) => (
        <input key={c.field} type="hidden" name={policyField(mood, c.field)} value="on" />
      ))}
      <input type="hidden" name={policyField(mood, "conversation")} value={policy.conversation} />
      <input type="hidden" name={policyField(mood, "priority")} value={policy.priority} />
    </>
  );
}

export function MoodDetectionForm({ settings, groups, canManage }: { settings: MoodSettingsView; groups: PickableGroup[]; canManage: boolean }) {
  const [state, formAction, pending] = useActionState(saveMoodDetectionSettings, initialState);
  const [sensitivity, setSensitivity] = useState<string>(settings.sensitivity);
  const presetCooldown = (MOOD_COOLDOWN_PRESETS as readonly number[]).includes(settings.cooldownMinutes);
  const [cooldown, setCooldown] = useState(presetCooldown ? String(settings.cooldownMinutes) : "custom");
  const [policies, setPolicies] = useState<MoodPolicies>(settings.policies);
  const [policyKey, setPolicyKey] = useState(0);

  const restoreDefaults = () => {
    setPolicies(DEFAULT_MOOD_POLICIES);
    setPolicyKey((k) => k + 1);
  };

  return (
    <form action={formAction} className="space-y-5">
      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
      {state.saved && !state.error ? (
        <Alert tone="success">{state.changed ? `Mood Detection settings saved — ${state.changed} change${state.changed === 1 ? "" : "s"} recorded in System Logs.` : "Saved. Nothing had changed."}</Alert>
      ) : null}

      <Card>
        <SectionHeader title="Mood Detection" description="Reads each customer's messages for anger, frustration and urgency, and acts on it the way you choose below. Off by default." />
        <SwitchField
          name="enabled"
          label="Enable Mood Detection"
          description="When off, nothing is read and nothing happens. Team members' messages are never read for mood."
          defaultChecked={settings.enabled}
          disabled={!canManage}
        />
      </Card>

      <Card>
        <SectionHeader title="What is read" description="Detection is cheap and rule-based first; nothing is sent to an AI unless you allow it below." />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <SwitchField name="analyzeText" label="Text" description="Words and phrases in English, Bangla and Banglish." defaultChecked={settings.analyzeText} disabled={!canManage} />
          <SwitchField name="analyzeEmoji" label="Emoji" description="😡 🤬 👎 and similar, alone or inside a message." defaultChecked={settings.analyzeEmoji} disabled={!canManage} />
          <SwitchField
            name="analyzeStickers"
            label="Stickers"
            description="Recorded as a sticker whose meaning cannot be identified — never guessed. It never triggers on its own."
            defaultChecked={settings.analyzeStickers}
            disabled={!canManage}
          />
          <div className="rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border)] p-4 text-xs leading-relaxed text-[color:var(--color-muted-foreground)]">
            <span className="block text-[13px] font-medium text-[color:var(--color-foreground)]">Reactions and images — not available</span>
            WhatsApp reactions need an OpenWA licence this deployment does not have, and the AI used here reads text only, so sticker
            and image pictures cannot be looked at.
          </div>
          <SwitchField
            name="useAiClassification"
            label="Ask AI about unclear messages"
            description="Only for mixed, sarcastic or borderline readings. Uses the AI Response model; names and numbers are never sent."
            defaultChecked={settings.useAiClassification}
            disabled={!canManage}
          />
        </div>
      </Card>

      <Card>
        <SectionHeader title="How sure it must be" description="A reading below the threshold is recorded in history but does nothing." />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Sensitivity">
            <Select name="sensitivity" value={sensitivity} onChange={(e) => setSensitivity(e.target.value)} disabled={!canManage}>
              {SENSITIVITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          {sensitivity === "CUSTOM" ? (
            <Field label="Minimum confidence (%)" hint="Between 50 and 99.">
              <Input name="minConfidence" type="number" min={50} max={99} defaultValue={settings.minConfidence} disabled={!canManage} />
            </Field>
          ) : null}
        </div>
      </Card>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <SectionHeader title="What each mood does" description="Detection never acts by itself: a mood must be a trigger, pass the threshold, and then only the actions ticked here run." />
          {canManage ? (
            <Button type="button" variant="ghost" onClick={restoreDefaults}>
              Restore recommended
            </Button>
          ) : null}
        </div>
        <div key={policyKey} className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {TRIGGERABLE_MOODS.map((mood) => (
            <PolicyCard key={mood} mood={mood} policy={policies[mood]} canManage={canManage} />
          ))}
        </div>
        <p className="mt-3 text-xs leading-relaxed text-[color:var(--color-muted-foreground)]">
          &ldquo;Pause AI replies&rdquo; holds AI back for the cooldown; &ldquo;Require human takeover&rdquo; holds it back until a team member replies
          (or the time below runs out). Rules keep running in both cases. Neutral and satisfied are recorded, never acted on.
        </p>
      </Card>

      <Card>
        <SectionHeader title="Alerts" description="Exactly one alert per escalation. A rise to a worse mood inside the cooldown alerts again, at the new priority." />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Cooldown" hint="Per customer, per group.">
            <Select name="cooldown" value={cooldown} onChange={(e) => setCooldown(e.target.value)} disabled={!canManage}>
              {MOOD_COOLDOWN_PRESETS.map((m) => (
                <option key={m} value={m}>
                  {m} minutes{m === 30 ? " (recommended)" : ""}
                </option>
              ))}
              <option value="custom">Custom…</option>
            </Select>
          </Field>
          {cooldown === "custom" ? (
            <Field label="Cooldown (minutes)" hint="1 to 1440.">
              <Input name="cooldownCustomMinutes" type="number" min={1} max={1440} defaultValue={settings.cooldownMinutes} disabled={!canManage} />
            </Field>
          ) : null}
          <Field label="Hold AI back for (hours)" hint="How long 'Require human takeover' lasts if nobody replies. 1 to 168.">
            <Input name="requireHumanHours" type="number" min={1} max={168} defaultValue={settings.requireHumanHours} disabled={!canManage} />
          </Field>
          <Field label="When nobody is assigned to the group, mention">
            <Select name="unassignedMention" defaultValue={settings.unassignedMention} disabled={!canManage}>
              <option value="OPTED_IN">Members who opted in to Mood alerts (up to 3)</option>
              <option value="NONE">Nobody — send the alert without a mention</option>
            </Select>
          </Field>
        </div>
        <div className="mt-4">
          <SwitchField
            name="skipCustomerMessageWhenUnassigned"
            label="Skip the customer message when nobody is assigned"
            description="So a holding message never promises a person who has not been named."
            defaultChecked={settings.skipCustomerMessageWhenUnassigned}
            disabled={!canManage}
          />
        </div>
        <div className="mt-5">
          <span className="mb-1.5 block text-[13px] font-medium text-[color:var(--color-foreground)]">Internal escalation group</span>
          {canManage ? (
            <GroupPicker name="internalGroupIds" groups={groups} defaultSelected={settings.internalGroupIds} emptyMeaning="No internal alert is sent." />
          ) : (
            <p className="text-[13px] text-[color:var(--color-muted-foreground)]">
              {settings.internalGroupIds.length
                ? settings.internalGroupIds.map((id) => groups.find((g) => g.whatsappGroupId === id)?.name ?? id).join(", ")
                : "None chosen."}
            </p>
          )}
        </div>
      </Card>

      {canManage ? (
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save settings"}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
