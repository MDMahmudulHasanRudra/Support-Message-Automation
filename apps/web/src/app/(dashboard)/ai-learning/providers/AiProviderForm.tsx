"use client";

import { useActionState } from "react";
import { Button, Card, Field, Input, SectionHeader, Select } from "@/components/ui";
import type { AiProviderFormState } from "@/server/actions/aiProviders";

const PROVIDER_KINDS = ["ANTHROPIC", "OPENAI", "GOOGLE", "CUSTOM"];

export interface AiProviderFormDefaults {
  name?: string;
  kind?: string;
  apiUrl?: string;
  hasExistingKey?: boolean;
}

export function AiProviderForm({
  action,
  defaults = {},
  submitLabel = "Save",
}: {
  action: (prevState: AiProviderFormState, formData: FormData) => Promise<AiProviderFormState>;
  defaults?: AiProviderFormDefaults;
  submitLabel?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});

  return (
    <form action={formAction} className="space-y-4">
      <Card>
        <SectionHeader title="Provider" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Name" required>
            <Input name="name" defaultValue={defaults.name} placeholder="e.g. Anthropic — Production" required />
          </Field>
          <Field label="Type">
            <Select name="kind" defaultValue={defaults.kind ?? "ANTHROPIC"}>
              {PROVIDER_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="API URL" hint="Optional — leave blank to use the provider's default endpoint.">
            <Input name="apiUrl" defaultValue={defaults.apiUrl} placeholder="https://api.anthropic.com" />
          </Field>
          <Field
            label="API Key"
            required={!defaults.hasExistingKey}
            hint={defaults.hasExistingKey ? "Leave blank to keep the current key." : "Stored encrypted — never shown again in full."}
          >
            <Input name="apiKey" type="password" autoComplete="off" placeholder={defaults.hasExistingKey ? "••••••••" : ""} />
          </Field>
        </div>
      </Card>

      {state.error ? <p className="text-sm text-[color:var(--color-danger)]">{state.error}</p> : null}

      <Button type="submit" loading={pending}>
        {submitLabel}
      </Button>
    </form>
  );
}
