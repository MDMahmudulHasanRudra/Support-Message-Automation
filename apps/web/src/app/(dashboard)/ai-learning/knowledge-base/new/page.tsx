import { requireSession } from "@/server/auth";
import { PageHeader } from "@/components/ui";
import { createKnowledgeItem } from "@/server/actions/aiKnowledge";
import { KnowledgeForm } from "../KnowledgeForm";

export default async function NewKnowledgeItemPage() {
  await requireSession();
  return (
    <div>
      <PageHeader title="Add Knowledge" />
      <KnowledgeForm action={createKnowledgeItem} submitLabel="Create" />
    </div>
  );
}
