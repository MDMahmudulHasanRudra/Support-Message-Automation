"use client";

import { useActionState, useEffect, useState } from "react";
import { Alert, Button, Card, Field, GroupPicker, Input, SectionHeader, Select, SwitchField, Textarea, type PickableGroup, useToast } from "@/components/ui";
import { ReplyLanguageField } from "./ReplyLanguageField";
import { UnableToUnderstandFields } from "./UnableToUnderstandFields";
import { updateAiSettings, type AiSettingsFormState } from "@/server/actions/aiSettings";
import type { AiSettings } from "@prisma/client";

/**
 * `notImplemented` marks a switch that is saved and read by NOTHING at runtime — verified by
 * grepping every worker/engine/ai-client reader for each column. They are shown, and shown as
 * inert, rather than quietly removed: the columns exist, an operator may already have toggled
 * one, and a switch that silently does nothing is the failure this project keeps deleting.
 *
 * "Screenshot Response" is the one with a real consequence if believed. There is no image
 * understanding anywhere in this pipeline — a photo arrives as the literal text "[Image]". The
 * AI now hands those to a person instead of answering them (see isMediaOnlyBody), so this switch
 * genuinely does nothing in either position.
 */
const ENGINE_TOGGLES: Array<{ key: keyof AiSettings; label: string; notImplemented?: true }> = [
  { key: "aiEngineEnabled", label: "AI Engine" },
  { key: "learningEnabled", label: "Learning" },
  { key: "autoResponseEnabled", label: "Auto Response" },
  { key: "screenshotResponseEnabled", label: "Screenshot Response", notImplemented: true },
  { key: "chatLearningEnabled", label: "Chat Learning", notImplemented: true },
  { key: "softwareLearningEnabled", label: "Software Learning", notImplemented: true },
  { key: "requirementLearningEnabled", label: "Requirement Learning", notImplemented: true },
  { key: "announcementAiEnabled", label: "Announcement AI", notImplemented: true },
];

const MODE_COPY: Record<string, { title: string; detail: string }> = {
  STRICT_KNOWLEDGE_ONLY: {
    title: "Only what your team has verified.",
    detail:
      "Nothing covering the question means nobody gets an answer from AI — it goes to a person. The safe choice, and the right one until the knowledge base has some substance to it.",
  },
  KNOWLEDGE_PLUS_FORGE: {
    title: "Verified knowledge, and the product's own source when that runs out.",
    detail:
      "When nothing covers a question, AI reads the source behind the relevant module, works out the answer, and replies. What it learns is saved, so the same question is answered instantly next time. A hard question takes noticeably longer, and answers written this way become reusable without a person reading them first — the disclosure check that strips anything naming code, tables or internals stands in for that review. Needs Product Knowledge connected.",
  },
  KNOWLEDGE_PLUS_GENERAL: {
    title: "Verified knowledge, plus ordinary questions answered from general knowledge.",
    detail:
      "“What is PPPoE?”, “how does a static IP work?” — the kind of thing any informed person would answer the same way for any company. Anything about your business still needs verified knowledge.",
  },
  KNOWLEDGE_FORGE_GENERAL: {
    title: "Every source available.",
    detail:
      "Verified knowledge first, then the product's own source when nothing covers the question, and general knowledge for questions that are not about your company at all. The most complete answers and the slowest on hard questions. Needs Product Knowledge connected.",
  },
};

export function AiSettingsForm({
  settings,
  groups,
}: {
  settings: AiSettings;
  groups: PickableGroup[];
}) {
  const [state, formAction, pending] = useActionState<AiSettingsFormState, FormData>(updateAiSettings, {});
  const [responseMode, setResponseMode] = useState(settings.aiResponseMode as string);
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
          description="AI Engine and Auto Response together gate the live AI reply layer. The switches marked “not implemented yet” are saved but read by nothing at runtime — changing them has no effect in either position."
        />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {ENGINE_TOGGLES.map((t) => (
            <SwitchField
              key={t.key}
              name={t.key}
              label={t.notImplemented ? `${t.label} — not implemented yet` : t.label}
              defaultChecked={Boolean(settings[t.key])}
            />
          ))}
        </div>
      </Card>

      <Card>
        <SectionHeader title="Learning Thresholds" description="Percentages (0-100). Only Human Review is live today — it decides whether a Conversation Learning pattern is surfaced for review. The other three are saved but read by nothing." />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <Field label="Duplicate Similarity — not implemented yet" hint="Saved, but no code reads it. Duplicate knowledge is currently detected by exact title match only.">
            <Input name="duplicateSimilarityThreshold" type="number" min={0} max={100} defaultValue={settings.duplicateSimilarityThreshold} />
          </Field>
          <Field label="Learning Confidence — not implemented yet" hint="Saved, but no code reads it.">
            <Input name="learningConfidenceThreshold" type="number" min={0} max={100} defaultValue={settings.learningConfidenceThreshold} />
          </Field>
          <Field label="Auto Approval — not implemented yet" hint="Saved, but no code reads it. The live auto-approval bar is on Settings → Conversation Learning.">
            <Input name="autoApprovalThreshold" type="number" min={0} max={100} defaultValue={settings.autoApprovalThreshold} />
          </Field>
          <Field label="Human Review" hint="LIVE. A Conversation Learning pattern scoring below this is not surfaced for review.">
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
          title="What AI is allowed to answer"
          description="A model knowing an answer is not the same as this software having the authority to give it. This decides where that line sits."
        />

        <div className="space-y-4">
          <Field label="Response mode">
            <Select
              name="aiResponseMode"
              value={responseMode}
              onChange={(event) => setResponseMode(event.target.value)}
            >
              <option value="STRICT_KNOWLEDGE_ONLY">Verified knowledge only</option>
              <option value="KNOWLEDGE_PLUS_FORGE">Knowledge + read the product source</option>
              <option value="KNOWLEDGE_PLUS_GENERAL">Knowledge + general questions</option>
              <option value="KNOWLEDGE_FORGE_GENERAL">Everything — knowledge, product source, and general</option>
            </Select>
          </Field>

          <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-sunken)] p-4">
            <p className="text-[13px] font-medium text-[color:var(--color-foreground)]">
              {MODE_COPY[responseMode]?.title}
            </p>
            <p className="mt-1 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
              {MODE_COPY[responseMode]?.detail}
            </p>
          </div>

          <Alert tone="info" title="What every mode has in common">
            Your <strong>knowledge base is used in all four</strong> — everything the system learns
            from conversations, imports and the scheduled product sync lands there, so there is no
            separate mode for those.
            <br />
            <br />
            And in every mode, a question about <strong>your</strong> business — how your software
            behaves, your pricing, policies, support hours, or anything about a customer&apos;s own
            account — is answered only from verified knowledge, and otherwise goes to a person.
            There is no setting that lets the model invent your company&apos;s answer, because a
            fluent guess about your refund window is worse than no answer at all: it sounds
            official.
          </Alert>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field
              label="Minimum confidence for a general answer"
              hint="Applies only to answers given without verified knowledge behind them. Normally higher than the main threshold — there is no team material supporting these, only the model's confidence in itself."
            >
              <Input
                name="generalAnswerMinConfidence"
                type="number"
                min={0}
                max={100}
                defaultValue={settings.generalAnswerMinConfidence}
              />
            </Field>

            <div className="md:col-span-2">
              <SwitchField
                name="communicationStyleLearningEnabled"
                defaultChecked={settings.communicationStyleLearningEnabled}
                label="Learn how the team writes"
                description="Studies the replies your executives actually send and describes their manner — greetings, formality, length, how they acknowledge a problem — so AI answers sound like your team. It learns manner only, never product facts, and nothing applies until you approve it on the Communication Style page."
              />
            </div>

          <ReplyLanguageField defaultValue={settings.defaultReplyLanguage} />
          </div>
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
        <div className="mb-4">
          <SwitchField
            name="mentionTeamOnHandover"
            defaultChecked={settings.mentionTeamOnHandover}
            label="Also tag a team member in the customer's own group"
            description="Posts one message in the conversation itself, @mentioning the group's assigned member — or whoever opted into handover alerts if there is none. The customer sees that somebody has been called, and the person is asked where the work actually is. Off by default: it puts an extra message in front of the customer."
          />
        </div>

        <UnableToUnderstandFields
          enabled={settings.unableToUnderstandReplyEnabled}
          text={settings.unableToUnderstandReplyText}
          repeatMinutes={settings.unableToUnderstandRepeatMinutes}
        />

        <Field label="Send takeover alerts to these WhatsApp groups">
          <GroupPicker
            name="takeoverNotifyGroupIds"
            groups={groups}
            defaultSelected={settings.takeoverNotifyGroupIds}
            emptyMeaning="Nothing selected — takeover alerts go to the general notification group from Settings, exactly as they do now."
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
