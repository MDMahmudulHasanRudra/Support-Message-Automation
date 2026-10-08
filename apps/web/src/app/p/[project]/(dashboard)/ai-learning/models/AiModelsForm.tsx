"use client";

import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { useActionState, useState } from "react";

import { Bot, Eye, FileText, GraduationCap, Keyboard, Layers, ListTree, MessageSquare, type LucideIcon } from "lucide-react";
import type { AiModelListEntry } from "@support-automation/shared";
import { Badge, Button, Card, Input, Select } from "@/components/ui";
import { clearAiModelConfig, setAiModelConfig, type AiModelFormState } from "@/server/actions/aiModels";
import { listAiProviderModels } from "@/server/actions/aiProviders";

const JOB_ICONS: Record<string, LucideIcon> = {
  LEARNING: GraduationCap,
  RESPONSE: MessageSquare,
  VISION: Eye,
  DOCUMENT: FileText,
  EMBEDDING: Layers,
  ADMIN_ASSISTANT: Bot,
};

export interface ProviderOption {
  id: string;
  name: string;
  status: string;
  kind: string;
}

export interface ModelJobRowData {
  job: string;
  label: string;
  description: string;
  /** False for a slot no code reads yet — labelled as such rather than quietly implying it works. */
  live: boolean;
  /** True only for ADMIN_ASSISTANT; see setAiModelConfig()'s guard for why. */
  anthropicOnly: boolean;
  providerId: string | null;
  modelId: string | null;
}

export function AiModelsForm({ rows, providers }: { rows: ModelJobRowData[]; providers: ProviderOption[] }) {
  return (
    <div className="space-y-3">
      {rows.map((row) => (
        <ModelJobRow key={row.job} row={row} providers={providers} />
      ))}
    </div>
  );
}

/**
 * The model id is still free text at the schema level, and deliberately stays free text here
 * whenever the provider's catalogue can't be reached — refusing to save a valid model id because
 * a listing call failed would be a worse failure than the typo the picker exists to prevent. So
 * the list is an opt-in upgrade over the text box, never a gate in front of it.
 *
 * Fetching is tied to a discrete action (picking a provider, or pressing Browse models), never to
 * typing: OpenRouter alone lists several hundred models, and a per-keystroke fetch would hammer
 * the provider for nothing.
 */
function ModelJobRow({ row, providers }: { row: ModelJobRowData; providers: ProviderOption[] }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<AiModelFormState, FormData>(setAiModelConfig, {});
  const Icon = JOB_ICONS[row.job];

  const [providerId, setProviderId] = useState(row.providerId ?? "");
  const [modelId, setModelId] = useState(row.modelId ?? "");
  const [models, setModels] = useState<AiModelListEntry[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [listing, setListing] = useState(false);

  const selected = providers.find((p) => p.id === providerId) ?? null;
  const wrongKind = row.anthropicOnly && selected !== null && selected.kind !== "ANTHROPIC";

  async function loadModels(id: string) {
    if (!id) {
      setListError("Pick a provider first — the model list comes from the provider's own API.");
      return;
    }
    setListing(true);
    setListError(null);
    try {
      const result = await listAiProviderModels(id);
      if (result.models.length === 0) {
        setModels(null);
        setListError(
          `Couldn't load this provider's model list: ${result.error ?? "it returned no models."} You can still type any model id and save it.`,
        );
        return;
      }
      setModels(result.models);
    } catch {
      // The action already turns provider failures into prose; this only catches a lost
      // connection to our own server, which must still leave the text box usable.
      setModels(null);
      setListError("Couldn't reach the server to load the model list. You can still type any model id and save it.");
    } finally {
      setListing(false);
    }
  }

  function handleProviderChange(next: string) {
    setProviderId(next);
    // The previous provider's catalogue says nothing about this one's.
    setModels(null);
    setListError(null);
    if (next) void loadModels(next);
  }

  // A model id that isn't in the catalogue must still be selectable, otherwise switching to the
  // list would silently rewrite a working configuration — including a model released after the
  // provider's list endpoint was last updated.
  const options: AiModelListEntry[] =
    models && modelId && !models.some((m) => m.id === modelId)
      ? [{ id: modelId, label: `${modelId} — saved, not in the provider's list` }, ...models]
      : (models ?? []);

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          {Icon ? (
            <span className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--color-primary-soft)] text-[color:var(--color-primary)]">
              <Icon className="size-4.5" aria-hidden />
            </span>
          ) : null}
          <div>
            <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-[color:var(--color-foreground)]">
              {row.label}
              {row.live ? (
                <Badge color="green" dot>
                  In use
                </Badge>
              ) : (
                <Badge color="gray">Not used yet</Badge>
              )}
              {row.anthropicOnly ? <Badge color="blue">Anthropic only</Badge> : null}
            </p>
            <p className="text-xs text-[color:var(--color-muted-foreground)]">{row.description}</p>
          </div>
        </div>
        <form action={formAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="job" value={row.job} />
          <Select
            name="providerId"
            value={providerId}
            onChange={(event) => handleProviderChange(event.target.value)}
            className="w-48"
          >
            <option value="">Select provider…</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.status !== "ACTIVE" ? " (inactive)" : ""}
                {row.anthropicOnly && p.kind !== "ANTHROPIC" ? ` — ${p.kind}, not supported` : ""}
              </option>
            ))}
          </Select>

          {models ? (
            <Select
              name="modelId"
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
              className="w-64"
            >
              <option value="">Select model…</option>
              {options.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label === m.id ? m.id : `${m.label} (${m.id})`}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              name="modelId"
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
              placeholder="e.g. claude-sonnet-4-5"
              className="w-64 font-[family-name:var(--font-mono)] text-xs"
            />
          )}

          {models ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setModels(null);
                setListError(null);
              }}
            >
              <Keyboard className="size-3.5" aria-hidden />
              Type it instead
            </Button>
          ) : (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              loading={listing}
              onClick={() => void loadModels(providerId)}
            >
              <ListTree className="size-3.5" aria-hidden />
              Browse models
            </Button>
          )}

          <Button type="submit" size="sm" loading={pending}>
            Save
          </Button>
          {row.providerId ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                clearAiModelConfig(row.job).then(() => router.refresh());
              }}
            >
              Clear
            </Button>
          ) : null}
        </form>
      </div>

      {wrongKind ? (
        <p className="mt-2 text-sm text-[color:var(--color-warning-fg)]">
          {row.label} needs an Anthropic provider — it uses Anthropic&apos;s tool-calling API, which
          isn&apos;t just a different endpoint. Saving {selected?.name} will be rejected.
        </p>
      ) : null}
      {listError ? (
        <p className="mt-2 text-xs text-[color:var(--color-muted-foreground)]">{listError}</p>
      ) : null}
      {state.error ? <p className="mt-2 text-sm text-[color:var(--color-danger)]">{state.error}</p> : null}
    </Card>
  );
}
