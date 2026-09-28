import { requireAccess } from "@/server/authorize";
import { PageHeader } from "@/components/ui";
import { createAiProvider } from "@/server/actions/aiProviders";
import { AiProviderForm } from "../AiProviderForm";

export default async function NewAiProviderPage() {
  await requireAccess("ai_settings.edit");
  return (
    <div>
      <PageHeader title="Add AI Provider" />
      <AiProviderForm action={createAiProvider} submitLabel="Add Provider" />
    </div>
  );
}
