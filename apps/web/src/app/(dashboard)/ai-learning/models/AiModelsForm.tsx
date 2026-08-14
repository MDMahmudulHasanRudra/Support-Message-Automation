"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { Eye, FileText, GraduationCap, Layers, MessageSquare, type LucideIcon } from "lucide-react";
import { Button, Card, Input, Select } from "@/components/ui";
import { clearAiModelConfig, setAiModelConfig, type AiModelFormState } from "@/server/actions/aiModels";

const JOB_ICONS: Record<string, LucideIcon> = {
  LEARNING: GraduationCap,
  RESPONSE: MessageSquare,
  VISION: Eye,
  DOCUMENT: FileText,
  EMBEDDING: Layers,
};

export interface ProviderOption {
  id: string;
  name: string;
  status: string;
}

export interface ModelJobRowData {
  job: string;
  label: string;
  description: string;
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

function ModelJobRow({ row, providers }: { row: ModelJobRowData; providers: ProviderOption[] }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<AiModelFormState, FormData>(setAiModelConfig, {});
  const Icon = JOB_ICONS[row.job];

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
            <p className="text-sm font-medium text-[color:var(--color-foreground)]">{row.label}</p>
            <p className="text-xs text-[color:var(--color-muted-foreground)]">{row.description}</p>
          </div>
        </div>
        <form action={formAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="job" value={row.job} />
          <Select name="providerId" defaultValue={row.providerId ?? ""} className="w-48">
            <option value="">Select provider…</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.status !== "ACTIVE" ? " (inactive)" : ""}
              </option>
            ))}
          </Select>
          <Input name="modelId" defaultValue={row.modelId ?? ""} placeholder="e.g. claude-sonnet-5" className="w-48" />
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
      {state.error ? <p className="mt-2 text-sm text-[color:var(--color-danger)]">{state.error}</p> : null}
    </Card>
  );
}
