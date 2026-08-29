"use client";

import { useActionState, useEffect } from "react";
import { Alert, Button, Card, Field, Input, SectionHeader, Select, SwitchField, Textarea, useToast } from "@/components/ui";
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

      <Card>
        <SectionHeader
          title="Automation by AI"
          description="Which conversations the AI may answer, and whether it turns what it learns into reusable rules. AI only ever runs after the rule engine finds no match — a rule that matched always wins."
        />

        <div className="space-y-4">
          <Field
            label="Answer in"
            hint="Widening this does not make AI answer more often in a given conversation — it only changes which groups it is allowed to answer in at all."
          >
            <Select name="aiAutomationScope" defaultValue={settings.aiAutomationScope}>
              <option value="PER_GROUP">Only groups I switch on individually</option>
              <option value="ALL_MONITORED_GROUPS">Every monitored group</option>
            </Select>
          </Field>

          {settings.aiAutomationScope === "ALL_MONITORED_GROUPS" ? (
            <Alert tone="warning" title="AI can answer in every monitored group">
              Any group you need a human to always handle should be marked{" "}
              <strong>Exclude from AI</strong> on the Groups page. That exclusion overrides this
              setting.
            </Alert>
          ) : null}

          <SwitchField
            name="aiRuleGenerationEnabled"
            label="Write rules from good answers"
            description="When AI answers confidently, draft a matching automation rule so the next customer asking the same thing is handled by the rule engine instead — instantly, and at no API cost. Drafts wait in Rule Proposals; nothing goes live until you approve it and then activate the rule."
            defaultChecked={settings.aiRuleGenerationEnabled}
          />

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field
              label="Minimum confidence to draft a rule"
              hint="Deliberately higher than the reply threshold: answering once at 90% is fine, but turning that answer into a standing rule deserves a higher bar."
            >
              <Input
                name="aiRuleGenerationMinConfidence"
                type="number"
                min={0}
                max={100}
                defaultValue={settings.aiRuleGenerationMinConfidence}
              />
            </Field>
          </div>
        </div>
      </Card>

      <Card>
        <SectionHeader
          title="When AI cannot handle it"
          description="Every time AI declines, is unsure, or fails, one alert is sent so a person can take over. Replying in that group then pauses AI there for the takeover cooldown above."
        />
        <Field
          label="Send takeover alerts to these WhatsApp groups"
          hint="One group id per line. Leave blank to use the general notification group from Settings — existing setups keep alerting exactly where they already do."
        >
          <Textarea
            name="takeoverNotifyGroupIds"
            rows={3}
            defaultValue={settings.takeoverNotifyGroupIds.join("\n")}
            placeholder="1234567890-1234567890@g.us"
            className="font-[family-name:var(--font-mono)] text-xs"
          />
        </Field>
      </Card>

      <Card>
        <SectionHeader
          title="Knowledge from conversations"
          description="Reads the group conversations already stored here and distils them into knowledge base entries — what each group asks about, and what answers resolved it."
        />
        <div className="space-y-4">
          <SwitchField
            name="requireKnowledgeForAiReply"
            label="Only answer from verified knowledge"
            description="With this on, AI hands off to a person whenever nothing in the verified knowledge base covers the question, instead of answering from the model's own general knowledge. The right setting for a product whose behaviour nobody outside your company could know — but expect more handoffs until the knowledge base fills up."
            defaultChecked={settings.requireKnowledgeForAiReply}
          />
          <SwitchField
            name="knowledgeFromChatEnabled"
            label="Build knowledge from group chats"
            description="One group per hour, oldest first, picking up where the last run left off. Entries arrive unverified for review — a model's reading of a chat log is evidence, not fact. Nothing is ever sent to a customer from this."
            defaultChecked={settings.knowledgeFromChatEnabled}
          />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field
              label="Minimum new messages per group"
              hint="A group with less new conversation than this is skipped — there is not enough there to draw a reliable conclusion from."
            >
              <Input
                name="knowledgeMinMessagesPerGroup"
                type="number"
                min={1}
                defaultValue={settings.knowledgeMinMessagesPerGroup}
              />
            </Field>
          </div>
        </div>
      </Card>

      {state.error ? <p className="text-sm text-[color:var(--color-danger)]">{state.error}</p> : null}

      <Button type="submit" loading={pending}>
        Save AI Settings
      </Button>
    </form>
  );
}
