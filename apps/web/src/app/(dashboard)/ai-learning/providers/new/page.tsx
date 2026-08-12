import { requireSession } from "@/server/auth";
import { PageHeader } from "@/components/ui";
import { createAiProvider } from "@/server/actions/aiProviders";
import { AiProviderForm } from "../AiProviderForm";

export default async function NewAiProviderPage() {
  await requireSession();
  return (
    <div>
      <PageHeader title="Add AI Provider" />
      <AiProviderForm action={createAiProvider} submitLabel="Add Provider" />
    </div>
  );
}
