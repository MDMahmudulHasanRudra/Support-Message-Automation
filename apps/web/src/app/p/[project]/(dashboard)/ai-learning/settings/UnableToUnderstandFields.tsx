"use client";

import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button, Field, Input, SwitchField, Textarea } from "@/components/ui";
import {
  DEFAULT_UNABLE_TO_UNDERSTAND_REPLY,
  UNABLE_TO_UNDERSTAND_MAX_LENGTH,
  UNABLE_TO_UNDERSTAND_REPEAT_MAX,
} from "@support-automation/shared";

/**
 * AI Unable-to-Understand Fallback — part of the AI Settings form, saved with it.
 *
 * The box always shows the wording that would be sent: the admin's own, or the default when none is
 * saved. Saving the default (or a blank box) stores "use the default", so a later improvement to
 * the built-in wording still reaches a deployment that never changed it. The preview is the exact
 * text, shown as the customer would see it in WhatsApp.
 */
export function UnableToUnderstandFields({
  enabled,
  text,
  repeatMinutes,
}: {
  enabled: boolean;
  text: string | null;
  repeatMinutes: number;
}) {
  const [draft, setDraft] = useState(text ?? DEFAULT_UNABLE_TO_UNDERSTAND_REPLY);
  const trimmed = draft.trim();
  const isDefault = !trimmed || trimmed === DEFAULT_UNABLE_TO_UNDERSTAND_REPLY;
  const tooLong = trimmed.length > UNABLE_TO_UNDERSTAND_MAX_LENGTH;
  const preview = trimmed || DEFAULT_UNABLE_TO_UNDERSTAND_REPLY;

  return (
    <div className="mb-5 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-sunken)]/50 p-4">
      <SwitchField
        name="unableToUnderstandReplyEnabled"
        defaultChecked={enabled}
        label="AI Unable-to-Understand Fallback"
        description="When AI genuinely has no reliable answer — an image it cannot see, nothing verified covers the question, it is not confident, or it declines — send the customer this message so they know the support team will follow up. Never sent when a rate limit, cooldown or AI outage stopped the reply, and never to a plain “ok” or “thanks”. The team is still alerted as above."
      />

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[1fr_20rem]">
        <Field
          label="Fallback message"
          hint={`Sent exactly as written. ${trimmed.length.toLocaleString("en-US")} / ${UNABLE_TO_UNDERSTAND_MAX_LENGTH.toLocaleString("en-US")} characters${isDefault ? " · using the default" : ""}.`}
          error={
            tooLong
              ? `Too long — ${trimmed.length.toLocaleString("en-US")} of ${UNABLE_TO_UNDERSTAND_MAX_LENGTH.toLocaleString("en-US")} characters. Shorten it before saving.`
              : undefined
          }
        >
          <Textarea
            name="unableToUnderstandReplyText"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={5}
            aria-invalid={tooLong || undefined}
          />
          <div className="mt-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={draft === DEFAULT_UNABLE_TO_UNDERSTAND_REPLY}
              onClick={() => setDraft(DEFAULT_UNABLE_TO_UNDERSTAND_REPLY)}
            >
              <RotateCcw className="size-3.5" aria-hidden />
              Restore default message
            </Button>
          </div>
        </Field>

        <div>
          <p className="mb-1.5 text-xs font-medium text-[color:var(--color-muted-foreground)]">Preview — what the customer sees</p>
          <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
            <div className="ml-auto max-w-[92%] rounded-[var(--radius-lg)] rounded-tr-[var(--radius-xs)] bg-[var(--color-accent-bg)] px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap text-[color:var(--color-foreground)]">
              {preview}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field
          label="Don't repeat it in the same conversation for (minutes)"
          hint="Someone sending several unclear messages in a row hears it once, not once per message. 0 sends it for every such message."
        >
          <Input
            name="unableToUnderstandRepeatMinutes"
            type="number"
            min={0}
            max={UNABLE_TO_UNDERSTAND_REPEAT_MAX}
            defaultValue={repeatMinutes}
          />
        </Field>
      </div>
    </div>
  );
}
