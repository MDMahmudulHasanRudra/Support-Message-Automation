"use client";

import { useState } from "react";
import { AUTO_REPLY_LANGUAGE } from "@support-automation/shared";
import { Field, Input, Select } from "@/components/ui";

/**
 * The language AI answers in, as a real dropdown rather than a text box.
 *
 * This was a `datalist`-backed input, which is a text box that happens to offer suggestions once
 * you start typing. Nothing on screen said the options existed, so the three that cover nearly
 * every case here were effectively hidden behind knowing to guess at them.
 *
 * "Other" keeps the field open: these fit this deployment, but a text box was the right instinct
 * for anyone serving a different language, and a fixed list would lock them out of their own
 * product. Picking Other reveals the input; picking a named option submits it directly.
 *
 * Automatic detection leads the list because it is the option most people want and the only one
 * that is not a language — see AUTO_REPLY_LANGUAGE for why it is a shared sentinel rather than a
 * string spelled out here.
 */

const AUTO = {
  value: AUTO_REPLY_LANGUAGE,
  label: "Auto — match the customer's language",
} as const;

const PRESETS = [
  { value: "Bengali (Bangla)", label: "Bangla — replies in Bengali script" },
  { value: "Banglish (Bengali written in Latin letters)", label: "Banglish — Bengali words, Latin letters" },
  { value: "English", label: "English" },
] as const;

const OTHER = "__other__";

/** The hint has to change with the choice: the two modes make opposite promises. */
function hintFor(choice: string): string {
  if (choice === AUTO_REPLY_LANGUAGE) {
    return "AI reads each message and answers in the same language and the same script — Bengali letters get Bengali letters back, Banglish gets Banglish, English gets English. Nothing is remembered between messages, so a customer who switches language is followed immediately. A bare greeting, a number or an emoji carries no signal at all; those get Banglish, which both a Bengali and an English reader can follow.";
  }
  return "AI answers in this unless the customer clearly wrote in another — it switches for a message in a different script, or a fluent English sentence, but a greeting, a number, or Bengali typed in Latin letters all stay in this language.";
}

export function ReplyLanguageField({ defaultValue }: { defaultValue: string }) {
  const isAuto = defaultValue === AUTO_REPLY_LANGUAGE;
  const matchesPreset = PRESETS.some((preset) => preset.value === defaultValue);
  const [choice, setChoice] = useState(isAuto || matchesPreset ? defaultValue : OTHER);

  return (
    <Field label="Default reply language" hint={hintFor(choice)}>
      <Select value={choice} onChange={(event) => setChoice(event.target.value)}>
        <option value={AUTO.value}>{AUTO.label}</option>
        {PRESETS.map((preset) => (
          <option key={preset.value} value={preset.value}>
            {preset.label}
          </option>
        ))}
        <option value={OTHER}>Other language…</option>
      </Select>

      {choice === OTHER ? (
        <div className="mt-2">
          <Input
            name="defaultReplyLanguage"
            // Only prefilled when the stored value was already a custom one — switching to Other
            // from a preset should be an empty box to type in, not the preset's name to delete.
            defaultValue={matchesPreset || isAuto ? "" : defaultValue}
            placeholder="Hindi, Arabic, Nepali…"
            maxLength={60}
            aria-label="Reply language"
            autoFocus
          />
          <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
            Name the language as you would say it. It is passed to the AI by name, so anything it
            recognises works.
          </p>
        </div>
      ) : (
        // The Select above is presentation only; this is what the form actually submits, so the
        // server action keeps reading one field whichever branch is showing.
        <input type="hidden" name="defaultReplyLanguage" value={choice} />
      )}
    </Field>
  );
}
