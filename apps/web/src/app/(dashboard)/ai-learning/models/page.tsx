/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import { prisma } from "@support-automation/db";
import type { AiModelJob } from "@prisma/client";
import { requireSession } from "@/server/auth";
import { HelpButton, HelpSection, PageHeader } from "@/components/ui";
import { AiModelsForm, type ModelJobRowData } from "./AiModelsForm";

/**
 * `live: false` means the slot is read by no code at all today. It stays on the page because the
 * enum value exists and removing it would be a schema change, but it is labelled honestly — an
 * admin should not spend a key working out why configuring the Vision model changed nothing.
 */
const JOBS: Array<{
  job: AiModelJob;
  label: string;
  description: string;
  live: boolean;
  anthropicOnly?: boolean;
}> = [
  {
    job: "LEARNING",
    label: "Learning Model",
    description:
      "Conversation Learning's AI analysis pass, the hourly group-knowledge builder, and the Knowledge Center's manual imports.",
    live: true,
  },
  {
    job: "RESPONSE",
    label: "Response Model",
    description:
      "The Hybrid AI Automation fallback — drafts the customer-facing reply when no rule matches an incoming message.",
    live: true,
  },
  {
    job: "ADMIN_ASSISTANT",
    label: "Admin Assistant Model",
    description: "The floating AI Admin Assistant chat on every dashboard page.",
    live: true,
    anthropicOnly: true,
  },
  {
    job: "VISION",
    label: "Vision Model",
    description: "Reserved for reading screenshots and images. Nothing reads this slot yet.",
    live: false,
  },
  {
    job: "DOCUMENT",
    label: "Document Model",
    description:
      "Reserved for a future document pipeline. Nothing reads this slot yet — manual imports use the Learning model.",
    live: false,
  },
  {
    job: "EMBEDDING",
    label: "Embedding Model",
    description:
      "Reserved for similarity search. Nothing reads this slot yet — knowledge retrieval matches on keywords, not embeddings.",
    live: false,
  },
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
      live: j.live,
      anthropicOnly: j.anthropicOnly ?? false,
      providerId: config?.providerId ?? null,
      modelId: config?.modelId ?? null,
    };
  });

  return (
    <div>
      <PageHeader
        title="AI Models"
        description="Assign which configured provider and model handles each job."
        actions={
          <HelpButton moduleTitle="AI Models">
            <HelpSection title="What this is">
              <p>
                Six fixed job slots, each pointing at one configured Provider plus one model id.
                Pick a provider, then use <strong>Browse models</strong> to load that provider's
                real catalogue and choose from it — that is the reliable way to avoid a typo, which
                otherwise saves cleanly and only fails at the first real call.
              </p>
              <p>
                If the list can't be loaded (the provider is offline, a local Ollama isn't running,
                no key is saved), the field stays a plain text box and you can still type and save
                any model id. A brand-new model that isn't in the catalogue yet is always saveable.
              </p>
            </HelpSection>
            <HelpSection title="Which jobs are actually live">
              <p>
                <strong>Learning</strong>, <strong>Response</strong> and{" "}
                <strong>Admin Assistant</strong> are all called by running code.
                Learning drives the Conversation Learning analysis job, the hourly group-knowledge
                builder and every Knowledge Center import. Response drafts the reply the Hybrid AI
                Automation fallback sends when no rule matches. Admin Assistant powers the floating
                chat widget.
              </p>
              <p>
                <strong>Vision</strong>, <strong>Document</strong> and <strong>Embedding</strong>{" "}
                are read by nothing today. They are marked "Not used yet" on the page — assigning a
                provider to them is harmless but has no effect.
              </p>
            </HelpSection>
            <HelpSection title="Admin Assistant needs Anthropic">
              <p>
                That one slot only accepts an <strong>Anthropic</strong> provider, and saving
                anything else is rejected. The assistant uses Anthropic's tool-calling API to run
                real read-only queries against your data; the OpenAI-compatible protocol expresses
                tools completely differently, so it isn't a matter of changing the endpoint. Every
                other slot works with any provider type, including OpenRouter and a local Ollama.
              </p>
            </HelpSection>
            <HelpSection title="Inactive providers">
              <p>
                A disabled provider still appears in the dropdown labelled "(inactive)" and can
                still be selected, but nothing will call it until it's re-enabled on the AI
                Providers page.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />
      <AiModelsForm
        rows={rows}
        providers={providers.map((p) => ({ id: p.id, name: p.name, status: p.status, kind: p.kind }))}
      />
    </div>
  );
}
