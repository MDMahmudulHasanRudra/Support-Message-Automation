"use client";

import { useActionState, useEffect } from "react";
import type { LearningSettings } from "@prisma/client";
import { Alert, Button, Card, Field, Input, SectionHeader, Switch, SwitchField, useToast } from "@/components/ui";
import { updateLearningSettings, type LearningSettingsFormState } from "@/server/actions/learning";

const WEIGHT_FIELDS: Array<{ key: keyof LearningSettings; label: string }> = [
  { key: "weightFrequency", label: "Frequency" },
  { key: "weightDiversity", label: "Diversity" },
  { key: "weightConsistency", label: "Consistency" },
  { key: "weightResolution", label: "Resolution" },
  { key: "weightRecency", label: "Recency" },
  { key: "weightAiConfidence", label: "AI Confidence" },
];

export function LearningSettingsForm({ settings }: { settings: LearningSettings }) {
  const [state, formAction, pending] = useActionState<LearningSettingsFormState, FormData>(updateLearningSettings, {});
  const { showToast } = useToast();

  useEffect(() => {
    if (state.success) showToast({ tone: "success", title: "Conversation Settings saved" });
    else if (state.error) showToast({ tone: "danger", title: "Could not save", description: state.error });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire only when a new action result arrives
  }, [state]);

  return (
    <form action={formAction} className="space-y-4">
      <Card>
        <SectionHeader
          title="Conversation Learning"
          description="The master switch — off by default. Existing WhatsApp automation is unaffected either way."
        />
        <SwitchField
          name="conversationLearningEnabled"
          label="Enable conversation learning"
          description="Session segmentation + pattern detection"
          defaultChecked={settings.conversationLearningEnabled}
        />
        <div className="mt-4 max-w-xs">
          <Field label="Session Gap (minutes)" hint="Inactivity gap that closes a conversation session.">
            <Input name="sessionGapMinutes" type="number" min={1} max={1440} defaultValue={settings.sessionGapMinutes} />
          </Field>
        </div>
      </Card>

      <Card>
        <SectionHeader
          title="Pattern Review Floor"
          description="A pattern is only ever surfaced once it clears every one of these — a single conversation can never qualify, no matter how it scores."
        />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <Field label="Min Occurrences" hint="Times a pattern must recur.">
            <Input name="minOccurrenceForCandidate" type="number" min={1} max={1000} defaultValue={settings.minOccurrenceForCandidate} />
          </Field>
          <Field label="Min Distinct Groups" hint="Different groups it must appear in.">
            <Input
              name="minDistinctGroupsForCandidate"
              type="number"
              min={1}
              max={1000}
              defaultValue={settings.minDistinctGroupsForCandidate}
            />
          </Field>
          <Field label="Min Distinct Clients" hint="Different clients it must come from.">
            <Input
              name="minDistinctClientsForCandidate"
              type="number"
              min={1}
              max={1000}
              defaultValue={settings.minDistinctClientsForCandidate}
            />
          </Field>
          <Field label="Candidate Expiry (days)" hint="Idle this long without review → EXPIRED.">
            <Input name="candidateExpiryDays" type="number" min={1} max={3650} defaultValue={settings.candidateExpiryDays} />
          </Field>
        </div>
      </Card>

      <Card>
        <SectionHeader
          title="Confidence Weights"
          description="Relative weights blended into each pattern's 0-100 confidence score — they don't need to sum to any particular total."
        />
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
          {WEIGHT_FIELDS.map((w) => (
            <Field key={w.key} label={w.label}>
              <Input name={w.key} type="number" min={0} max={1000} defaultValue={settings[w.key] as number} />
            </Field>
          ))}
        </div>
      </Card>

      <Card>
        <SectionHeader
          title="Unknown Pattern Alerts"
          description="Off by default. When on, a recurring question no existing rule handles triggers one WhatsApp alert to your configured support group(s) — reusing the same destinations as Automation Settings' notification groups and the WhatsApp Account Routing page's 'Unknown Pattern Alerts' row."
        />
        <Alert tone="info" title="One alert per pattern, not per message">
          If 50 customers send the same unhandled question, this sends one alert (not 50) —
          re-alerting for the same pattern is limited by the cooldown below.
        </Alert>
        <div className="mt-4 flex flex-col gap-4 md:flex-row md:items-end">
          <label className="flex items-center gap-2 text-sm text-[color:var(--color-foreground)]">
            <Switch
              name="unknownPatternNotificationsEnabled"
              defaultChecked={settings.unknownPatternNotificationsEnabled}
            />
            Enable Unknown Pattern alerts
          </label>
          <div className="max-w-xs">
            <Field label="Cooldown (minutes)" hint="Minimum time between two alerts for the same pattern.">
              <Input
                name="unknownPatternCooldownMinutes"
                type="number"
                min={1}
                max={10080}
                defaultValue={settings.unknownPatternCooldownMinutes}
              />
            </Field>
          </div>
        </div>
      </Card>

      <Card>
        <SectionHeader title="Auto-Approval Policy" />
        <Alert tone="warning" title="Off by default — understand this before enabling">
          When on, a pattern that clears the confidence bar below is automatically turned into a
          real automation rule with no human review step. That rule is still always created as a
          Draft — it has zero effect on live WhatsApp automation until a human separately switches
          it to Active on the Rules page — but the drafting and the confidence judgment happen
          without anyone looking at it first.
        </Alert>
        <div className="mt-4 flex flex-col gap-4 md:flex-row md:items-end">
          <label className="flex items-center gap-2 text-sm text-[color:var(--color-foreground)]">
            <Switch name="autoApprovalEnabled" defaultChecked={settings.autoApprovalEnabled} />
            Enable auto-approval
          </label>
          <div className="max-w-xs">
            <Field label="Auto-Approval Confidence" hint="At/above this score, auto-approve (if enabled).">
              <Input
                name="autoApprovalMinConfidence"
                type="number"
                min={0}
                max={100}
                defaultValue={settings.autoApprovalMinConfidence}
              />
            </Field>
          </div>
        </div>
      </Card>

      {state.error ? <p className="text-sm text-[color:var(--color-danger)]">{state.error}</p> : null}

      <Button type="submit" loading={pending}>
        Save Conversation Settings
      </Button>
    </form>
  );
}
