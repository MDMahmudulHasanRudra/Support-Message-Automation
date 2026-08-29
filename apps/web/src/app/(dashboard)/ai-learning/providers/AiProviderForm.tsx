"use client";

import { useActionState, useState } from "react";
import { KeyRound } from "lucide-react";
import {
  AI_PROVIDER_PROFILES,
  SELECTABLE_AI_PROVIDER_KINDS,
  type AiProviderKind,
} from "@support-automation/shared";
import { Alert, Button, Card, Field, Input, SectionHeader, Select } from "@/components/ui";
import type { AiProviderFormState } from "@/server/actions/aiProviders";

export interface AiProviderFormDefaults {
  name?: string;
  kind?: string;
  apiUrl?: string;
  hasExistingKey?: boolean;
}

/**
 * The connection methods and their endpoints come from the shared catalog
 * (packages/shared/src/aiProviders.ts), the same one the server action validates against and
 * the client resolver builds requests from — so what this form suggests is always what the
 * request actually uses.
 *
 * Picking a type rewrites the endpoint and key fields to match it. That is the whole point:
 * "add OpenRouter" should not also mean "go and look up their base URL".
 */
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
  const initialKind = (defaults.kind as AiProviderKind) ?? "ANTHROPIC";
  const [kind, setKind] = useState<AiProviderKind>(initialKind);
  // Only overwritten when the type changes, so an endpoint typed by hand survives a re-render.
  const [apiUrl, setApiUrl] = useState(defaults.apiUrl ?? "");

  const profile = AI_PROVIDER_PROFILES[kind];
  const keyRequired = profile.requiresApiKey && !defaults.hasExistingKey;

  function handleKindChange(next: AiProviderKind) {
    setKind(next);
    // Only prefill when the field is empty or still holds another type's default, so a
    // deliberately customised endpoint is never silently replaced.
    const isUntouched =
      apiUrl === "" ||
      SELECTABLE_AI_PROVIDER_KINDS.some((k) => AI_PROVIDER_PROFILES[k].defaultApiUrl === apiUrl);
    if (isUntouched) setApiUrl(AI_PROVIDER_PROFILES[next].defaultApiUrl ?? "");
  }

  return (
    <form action={formAction} className="space-y-4">
      <Card>
        <SectionHeader title="Provider" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Name" required>
            <Input name="name" defaultValue={defaults.name} placeholder="e.g. OpenRouter — Production" required />
          </Field>

          <Field label="Type" hint={profile.description}>
            <Select
              name="kind"
              value={kind}
              onChange={(event) => handleKindChange(event.target.value as AiProviderKind)}
            >
              {SELECTABLE_AI_PROVIDER_KINDS.map((value) => (
                <option key={value} value={value}>
                  {AI_PROVIDER_PROFILES[value].label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="API URL" hint={profile.apiUrlHint || "Leave blank to use the provider's default endpoint."}>
            <Input
              name="apiUrl"
              value={apiUrl}
              onChange={(event) => setApiUrl(event.target.value)}
              placeholder={profile.defaultApiUrl ?? "https://api.anthropic.com"}
              className="font-[family-name:var(--font-mono)] text-xs"
            />
          </Field>

          <Field
            label={
              <span className="inline-flex items-center gap-1.5">
                <KeyRound className="size-3.5 text-[color:var(--color-muted-foreground)]" aria-hidden />
                API Key
              </span>
            }
            required={keyRequired}
            hint={
              !profile.requiresApiKey
                ? "Not needed — a self-hosted runtime accepts requests without one."
                : defaults.hasExistingKey
                  ? "Leave blank to keep the current key."
                  : "Stored encrypted — never shown again in full."
            }
          >
            <Input
              name="apiKey"
              type="password"
              autoComplete="off"
              disabled={!profile.requiresApiKey}
              placeholder={
                !profile.requiresApiKey ? "Not required" : defaults.hasExistingKey ? "••••••••" : ""
              }
              className="font-[family-name:var(--font-mono)] tracking-wide"
            />
          </Field>
        </div>

        <div className="mt-4">
          <Field label="Example model id" hint="Set the actual model per job on the AI Models page.">
            <Input
              readOnly
              value={profile.exampleModelId}
              className="font-[family-name:var(--font-mono)] text-xs"
              tabIndex={-1}
            />
          </Field>
        </div>
      </Card>

      {kind === "OLLAMA" ? (
        <Alert tone="info" title="Reaching Ollama from Docker">
          This app runs in a container, so <code>127.0.0.1</code> means the container itself, not
          your machine. Use <code>http://host.docker.internal:11434/v1</code> on Windows or macOS,
          or your host&apos;s LAN IP on Linux. Test the connection after saving to confirm it
          resolves.
        </Alert>
      ) : null}

      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}

      <Button type="submit" loading={pending}>
        {submitLabel}
      </Button>
    </form>
  );
}
