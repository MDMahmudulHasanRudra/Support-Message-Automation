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
          description="Every switch defaults OFF. None of these gate real behavior yet — later phases will read them."
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

      {state.error ? <p className="text-sm text-[color:var(--color-danger)]">{state.error}</p> : null}

      <Button type="submit" loading={pending}>
        Save AI Settings
      </Button>
    </form>
  );
}
