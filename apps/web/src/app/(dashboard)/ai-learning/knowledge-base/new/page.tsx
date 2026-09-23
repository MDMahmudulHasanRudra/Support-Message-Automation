import { requireAccess } from "@/server/authorize";
import { PageHeader } from "@/components/ui";
import { createKnowledgeItem } from "@/server/actions/aiKnowledge";
import { KnowledgeForm } from "../KnowledgeForm";

export default async function NewKnowledgeItemPage() {
  await requireAccess("ai_learning.manage");
  return (
    <div>
      <PageHeader title="Add Knowledge" />
      <KnowledgeForm action={createKnowledgeItem} submitLabel="Create" />
    </div>
  );
}
