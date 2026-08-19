"use client";

import { useActionState, useEffect } from "react";
import { Button, Card, Field, Input, SectionHeader, SwitchField, useToast } from "@/components/ui";
import { updateAiSettings, type AiSettingsFormState } from "@/server/actions/aiSettings";
import type { AiSettings } from "@prisma/client";

const ENGINE_TOGGLES: Array<{ key: keyof AiSettings; label: string }> = [
  { key: "aiEngineEnabled", label: "AI Engine" },
  { key: "learningEnabled", label: "Learning" },
  { key: "autoResponseEnabled", label: "Auto Response" },
  { key: "screenshotResponseEnabled", label: "Screenshot Response" },
  { key: "chatLearningEnabled", label: "Chat Learning" },
  { key: "softwareLearningEnabled", label: "Software Learning" },
  { key: "requirementLearningEnabled", label: "Requirement Learning" },
  { key: "announcementAiEnabled", label: "Announcement AI" },
];

export function AiSettingsForm({ settings }: { settings: AiSettings }) {
  const [state, formAction, pending] = useActionState<AiSettingsFormState, FormData>(updateAiSettings, {});
  const { showToast } = useToast();

  useEffect(() => {
    if (state.success) showToast({ tone: "success", title: "AI Settings saved" });
    else if (state.error) showToast({ tone: "danger", title: "Could not save", description: state.error });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire only when a new action result arrives
  }, [state]);

  return (
    <form action={formAction} className="space-y-4">
      <Card>
        <SectionHeader
          title="Master Controls"
          description="Every switch defaults OFF. AI Engine and Auto Response together gate the live Hybrid AI Automation fallback layer — the rest are reserved for later phases."
        />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {ENGINE_TOGGLES.map((t) => (
            <SwitchField key={t.key} name={t.key} label={t.label} defaultChecked={Boolean(settings[t.key])} />
          ))}
        </div>
      </Card>

      <Card>
        <SectionHeader title="Learning Thresholds" description="Percentages (0-100) — used by later phases' duplicate/confidence checks." />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <Field label="Duplicate Similarity" hint="At/above this, treat as duplicate.">
            <Input name="duplicateSimilarityThreshold" type="number" min={0} max={100} defaultValue={settings.duplicateSimilarityThreshold} />
          </Field>
          <Field label="Learning Confidence" hint="Below this, needs human review.">
            <Input name="learningConfidenceThreshold" type="number" min={0} max={100} defaultValue={settings.learningConfidenceThreshold} />
          </Field>
          <Field label="Auto Approval" hint="At/above this, can skip human approval (if enabled).">
            <Input name="autoApprovalThreshold" type="number" min={0} max={100} defaultValue={settings.autoApprovalThreshold} />
          </Field>
          <Field label="Human Review" hint="Below this, reject/manual review only.">
            <Input name="humanReviewThreshold" type="number" min={0} max={100} defaultValue={settings.humanReviewThreshold} />
          </Field>
        </div>
      </Card>

      <Card>
        <SectionHeader
          title="Hybrid AI Automation Fallback"
          description="Live and active: these already gate real customer-facing behavior."
        />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field
            label="Auto-Response Confidence Threshold"
            hint="AI only runs after the deterministic rule engine finds no match. At/above this confidence, AI may auto-reply; below it, or on any failure, a human is asked for help instead. Once a pattern becomes an approved, activated rule, AI is never called for it again."
          >
            <Input
              name="autoResponseConfidenceThreshold"
              type="number"
              min={0}
              max={100}
              defaultValue={settings.autoResponseConfidenceThreshold}
            />
          </Field>
          <Field
            label="AI Reply Cooldown (seconds)"
            hint="Reuses the same cooldown mechanism as per-rule auto-replies — blocks AI from replying to the same client again this soon. 0 disables it."
          >
            <Input name="aiReplyCooldownSeconds" type="number" min={0} defaultValue={settings.aiReplyCooldownSeconds} />
          </Field>
          <Field
            label="Human Takeover Cooldown (minutes)"
            hint="When a team member sends a message in an AI-enabled group, AI is paused for that group for this long — 'AI must not immediately interfere' once a human is engaged."
          >
            <Input name="humanTakeoverCooldownMinutes" type="number" min={0} defaultValue={settings.humanTakeoverCooldownMinutes} />
          </Field>
        </div>
      </Card>

      {state.error ? <p className="text-sm text-[color:var(--color-danger)]">{state.error}</p> : null}

      <Button type="submit" loading={pending}>
        Save AI Settings
      </Button>
    </form>
  );
}
