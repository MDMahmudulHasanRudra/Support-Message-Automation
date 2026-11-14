"use client";

import { useActionState, useState, useTransition } from "react";
import { ChevronDown, ExternalLink, KeyRound, PlugZap } from "lucide-react";
import {
  AI_PROVIDER_PROFILES,
  SELECTABLE_AI_PROVIDER_KINDS,
  type AiProviderKind,
} from "@support-automation/shared";
import { Alert, Button, Card, Field, Input, SectionHeader } from "@/components/ui";
import { testAiProviderConnection, type AiProviderFormState } from "@/server/actions/aiProviders";

/** Where each vendor hands out an API key. Opened in a new tab; nothing is sent there. */
const KEY_PAGE: Partial<Record<AiProviderKind, { url: string; label: string }>> = {
  ANTHROPIC: { url: "https://console.anthropic.com/settings/keys", label: "Get a key from the Anthropic Console" },
  OPENAI: { url: "https://platform.openai.com/api-keys", label: "Get a key from OpenAI" },
  OPENROUTER: { url: "https://openrouter.ai/keys", label: "Get a key from OpenRouter" },
  GOOGLE: { url: "https://aistudio.google.com/apikey", label: "Get a key from Google AI Studio" },
};

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
  providerId,
}: {
  action: (prevState: AiProviderFormState, formData: FormData) => Promise<AiProviderFormState>;
  defaults?: AiProviderFormDefaults;
  submitLabel?: string;
  /** Set on the edit page only — a provider must exist before there is anything to test. */
  providerId?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const [testing, startTest] = useTransition();
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const initialKind = (defaults.kind as AiProviderKind) ?? "ANTHROPIC";
  const [kind, setKind] = useState<AiProviderKind>(initialKind);
  // Only overwritten when the type changes, so an endpoint typed by hand survives a re-render.
  const [apiUrl, setApiUrl] = useState(defaults.apiUrl ?? AI_PROVIDER_PROFILES[initialKind].defaultApiUrl ?? "");
  // The name follows the chosen vendor until somebody types one.
  const [name, setName] = useState(defaults.name ?? AI_PROVIDER_PROFILES[initialKind].label);
  const [nameEdited, setNameEdited] = useState(Boolean(defaults.name));
  const [advanced, setAdvanced] = useState(initialKind === "OLLAMA");

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
    if (!nameEdited) setName(AI_PROVIDER_PROFILES[next].label);
    // A self-hosted runtime has no default address that works from a container: show it.
    if (next === "OLLAMA") setAdvanced(true);
    // A verdict about the previous vendor's key and endpoint says nothing about this one's.
    setTestResult(null);
  }

  function runTest() {
    if (!providerId) return;
    setTestResult(null);
    startTest(async () => {
      const result = await testAiProviderConnection(providerId);
      setTestResult({
        ok: result.ok,
        text: result.ok ? (result.message ?? "The connection works.") : (result.error ?? "The test failed."),
      });
    });
  }

  return (
    <form action={formAction} className="space-y-4">
      <Card>
        <SectionHeader title="1. Choose your AI provider" />
        <input type="hidden" name="kind" value={kind} />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="AI provider">
          {SELECTABLE_AI_PROVIDER_KINDS.map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={kind === value}
              onClick={() => handleKindChange(value)}
              className={`rounded-[var(--radius-md)] border px-3 py-2.5 text-left transition-colors ${
                kind === value
                  ? "border-[var(--color-accent)] bg-[var(--color-accent-bg)]"
                  : "border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-border-strong)]"
              }`}
            >
              <span className="block text-[13px] font-semibold text-[color:var(--color-foreground)]">{AI_PROVIDER_PROFILES[value].label}</span>
            </button>
          ))}
        </div>
        <p className="mt-2 text-[12.5px] leading-relaxed text-[color:var(--color-muted-foreground)]">{profile.description}</p>

        <div className="mt-5">
          <p className="mb-2 text-[13px] font-semibold text-[color:var(--color-foreground)]">2. {profile.requiresApiKey ? "Paste its API key" : "Nothing to paste"}</p>
          {profile.requiresApiKey ? (
            <Field
              label={
                <span className="inline-flex items-center gap-1.5">
                  <KeyRound className="size-3.5 text-[color:var(--color-muted-foreground)]" aria-hidden />
                  API key
                </span>
              }
              required={keyRequired}
              hint={defaults.hasExistingKey ? "Leave blank to keep the current key." : "Stored encrypted — never shown again in full."}
            >
              <Input
                name="apiKey"
                type="password"
                autoComplete="off"
                placeholder={defaults.hasExistingKey ? "••••••••" : ""}
                className="font-[family-name:var(--font-mono)] tracking-wide"
              />
            </Field>
          ) : (
            <p className="text-[12.5px] text-[color:var(--color-muted-foreground)]">A self-hosted runtime accepts requests without a key. Check its address below.</p>
          )}
          {KEY_PAGE[kind] ? (
            <a
              href={KEY_PAGE[kind]!.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-[12.5px] font-medium text-[color:var(--color-accent)] hover:underline"
            >
              {KEY_PAGE[kind]!.label}
              <ExternalLink className="size-3" aria-hidden />
            </a>
          ) : null}
        </div>

        <button
          type="button"
          onClick={() => setAdvanced((a) => !a)}
          aria-expanded={advanced}
          className="mt-5 inline-flex items-center gap-1 text-[12.5px] font-medium text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
        >
          <ChevronDown className={`size-3.5 transition-transform ${advanced ? "rotate-180" : ""}`} aria-hidden />
          Name and address
        </button>
        {/* Always submitted; filled for the chosen vendor, shown when asked for. */}
        <div className={advanced ? "mt-3 grid grid-cols-1 gap-4 md:grid-cols-2" : "hidden"}>
          <Field label="Name" required hint="How it is listed here, e.g. “OpenRouter — Production”.">
            <Input
              name="name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameEdited(true);
              }}
              required
            />
          </Field>
          <Field label="API URL" hint={profile.apiUrlHint || "Leave as it is to use the provider's own address."}>
            <Input
              name="apiUrl"
              value={apiUrl}
              onChange={(event) => setApiUrl(event.target.value)}
              placeholder={profile.defaultApiUrl ?? "https://api.anthropic.com"}
              className="font-[family-name:var(--font-mono)] text-xs"
            />
          </Field>
          <p className="text-[12px] text-[color:var(--color-muted-foreground)] md:col-span-2">
            Example model: <code className="font-[family-name:var(--font-mono)]">{profile.exampleModelId}</code>. Choose the model for each job on the AI Models page.
          </p>
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

      {testResult ? (
        <Alert tone={testResult.ok ? "success" : "danger"} title={testResult.ok ? "Connection verified" : "Test failed"}>
          {testResult.text}
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={pending}>
          {submitLabel}
        </Button>
        {providerId ? (
          <>
            {/* Saving redirects to the list, so without this the only way to test was to save,
                navigate back, and find the row again. This tests what is SAVED — a key typed above
                but not yet submitted is not part of the request, and the label has to say so
                rather than let a green result be read as approval of unsaved edits. */}
            <Button type="button" variant="secondary" loading={testing} onClick={runTest}>
              <PlugZap className="size-4" aria-hidden />
              Test saved connection
            </Button>
            <span className="text-xs text-[color:var(--color-muted-foreground)]">
              Tests the credentials currently saved, not the edits above — save first, then test.
            </span>
          </>
        ) : null}
      </div>
    </form>
  );
}
