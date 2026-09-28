import { prisma } from "@/server/db";
import { notFound } from "next/navigation";

import { requireAccess } from "@/server/authorize";
import { PageHeader } from "@/components/ui";
import { updateAiProvider } from "@/server/actions/aiProviders";
import { AiProviderForm, type AiProviderFormDefaults } from "../../AiProviderForm";

export default async function EditAiProviderPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAccess("ai_settings.edit");
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
      <AiProviderForm
        action={updateAiProvider.bind(null, provider.id)}
        defaults={defaults}
        submitLabel="Save Changes"
        providerId={provider.id}
      />
    </div>
  );
}
