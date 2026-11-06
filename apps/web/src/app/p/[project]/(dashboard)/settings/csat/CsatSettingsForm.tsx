"use client";

import { useState, useTransition } from "react";
import { CSAT_COOLDOWN_MAX_DAYS, CSAT_QUESTION_MAX_LENGTH, DEFAULT_CSAT_QUESTION } from "@support-automation/shared";
import { Button, Field, Input, SwitchField, Textarea, useToast } from "@/components/ui";
import { saveCsatSettingsAction } from "@/server/actions/csat";

export interface CsatSettingsFormValues {
  whatsappPersonalEnabled: boolean;
  webchatEnabled: boolean;
  messengerEnabled: boolean;
  instagramEnabled: boolean;
  telegramEnabled: boolean;
  questionText: string | null;
  cooldownDays: number;
}

const CHANNELS: Array<{ key: keyof Omit<CsatSettingsFormValues, "questionText" | "cooldownDays">; label: string; description: string }> = [
  {
    key: "webchatEnabled",
    label: "Website chat",
    description: "The visitor sees a rating card (1–5 and an optional comment) in the widget. Nothing is sent as a message.",
  },
  {
    key: "messengerEnabled",
    label: "Facebook Messenger",
    description: "Sent as a message only inside Meta's 24-hour window, never with the Human Agent tag. The customer answers with a number.",
  },
  {
    key: "instagramEnabled",
    label: "Instagram DM",
    description: "Same rules as Messenger.",
  },
  {
    key: "telegramEnabled",
    label: "Telegram",
    description: "One-to-one chats only, never a Telegram group.",
  },
  {
    key: "whatsappPersonalEnabled",
    label: "WhatsApp personal chats",
    description:
      "One-to-one chats only — never a WhatsApp group. Sent from the number that holds the chat, through the outbound queue with every automatic-reply rule: the kill switch, MANUAL_ONLY and the rate limits that protect the number.",
  },
];

export function CsatSettingsForm({ initial, canManage }: { initial: CsatSettingsFormValues; canManage: boolean }) {
  const { showToast } = useToast();
  const [values, setValues] = useState(initial);
  const [question, setQuestion] = useState(initial.questionText ?? "");
  const [cooldown, setCooldown] = useState(String(initial.cooldownDays));
  const [busy, start] = useTransition();
  const disabled = !canManage || busy;

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await saveCsatSettingsAction({ ...values, questionText: question, cooldownDays: cooldown });
          showToast("error" in r ? { tone: "danger", title: "Nothing was saved", description: r.error } : { tone: "success", title: "Saved" });
        });
      }}
    >
      <fieldset className="space-y-3">
        <legend className="mb-2 text-[13px] font-semibold">Ask after a conversation is resolved on</legend>
        {CHANNELS.map((c) => (
          <SwitchField
            key={c.key}
            label={c.label}
            description={c.description}
            checked={values[c.key]}
            disabled={disabled}
            onChange={(e) => setValues((v) => ({ ...v, [c.key]: e.target.checked }))}
          />
        ))}
      </fieldset>

      <Field
        label="Question"
        hint={`Leave empty to use the built-in question (Bangla and English). The website chat card shows a shorter built-in question. At most ${CSAT_QUESTION_MAX_LENGTH} characters.`}
      >
        <Textarea value={question} maxLength={CSAT_QUESTION_MAX_LENGTH} placeholder={DEFAULT_CSAT_QUESTION} disabled={disabled} onChange={(e) => setQuestion(e.target.value)} />
      </Field>

      <Field label="Ask the same customer at most once every (days)" hint={`0 = after every resolution. At most ${CSAT_COOLDOWN_MAX_DAYS}.`}>
        <Input type="number" min={0} max={CSAT_COOLDOWN_MAX_DAYS} value={cooldown} disabled={disabled} onChange={(e) => setCooldown(e.target.value)} className="max-w-32" />
      </Field>

      {canManage ? (
        <Button type="submit" disabled={busy}>
          Save
        </Button>
      ) : null}
    </form>
  );
}
