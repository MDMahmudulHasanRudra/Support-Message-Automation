import { prisma } from "@support-automation/db";
import type { AiModelJob } from "@prisma/client";
import { requireSession } from "@/server/auth";
import { PageHeader } from "@/components/ui";
import { AiModelsForm, type ModelJobRowData } from "./AiModelsForm";

const JOBS: Array<{ job: AiModelJob; label: string; description: string }> = [
  { job: "LEARNING", label: "Learning Model", description: "Used when a future phase extracts knowledge from a new source." },
  { job: "RESPONSE", label: "Response Model", description: "Used when a future phase generates a customer-facing answer." },
  { job: "VISION", label: "Vision Model", description: "Used when a future phase reads screenshots/images." },
  { job: "DOCUMENT", label: "Document Model", description: "Used when a future phase processes uploaded documents." },
  { job: "EMBEDDING", label: "Embedding Model", description: "Used for similarity/duplicate detection once ingestion exists." },
];

export default async function AiModelsPage() {
  await requireSession();

  const [providers, configs] = await Promise.all([
    prisma.aiProvider.findMany({ orderBy: { name: "asc" } }),
    prisma.aiModelConfig.findMany(),
  ]);

  const configByJob = new Map(configs.map((c) => [c.job, c]));
  const rows: ModelJobRowData[] = JOBS.map((j) => {
    const config = configByJob.get(j.job);
    return {
      job: j.job,
      label: j.label,
      description: j.description,
      providerId: config?.providerId ?? null,
      modelId: config?.modelId ?? null,
    };
  });

  return (
    <div>
      <PageHeader
        title="AI Models"
        description="Assign which configured provider/model handles each job. None of these are called yet — later phases will read this configuration."
      />
      <AiModelsForm
        rows={rows}
        providers={providers.map((p) => ({ id: p.id, name: p.name, status: p.status }))}
      />
    </div>
  );
}
