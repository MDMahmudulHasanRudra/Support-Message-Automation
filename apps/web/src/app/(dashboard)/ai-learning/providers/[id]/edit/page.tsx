import { notFound } from "next/navigation";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { PageHeader } from "@/components/ui";
import { updateAiProvider } from "@/server/actions/aiProviders";
import { AiProviderForm, type AiProviderFormDefaults } from "../../AiProviderForm";

export default async function EditAiProviderPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;
  const provider = await prisma.aiProvider.findUnique({ where: { id } });
  if (!provider) notFound();

  const defaults: AiProviderFormDefaults = {
    name: provider.name,
    kind: provider.kind,
    apiUrl: provider.apiUrl ?? undefined,
    hasExistingKey: true,
  };

  return (
    <div>
      <PageHeader title={`Edit Provider: ${provider.name}`} />
      <AiProviderForm action={updateAiProvider.bind(null, provider.id)} defaults={defaults} submitLabel="Save Changes" />
    </div>
  );
}
