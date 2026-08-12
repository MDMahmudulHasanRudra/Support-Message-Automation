import { notFound } from "next/navigation";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { PageHeader } from "@/components/ui";
import { updateKnowledgeItem } from "@/server/actions/aiKnowledge";
import { KnowledgeForm, type KnowledgeFormDefaults } from "../../KnowledgeForm";

export default async function EditKnowledgeItemPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;
  const item = await prisma.aiKnowledgeItem.findUnique({ where: { id } });
  if (!item) notFound();

  const defaults: KnowledgeFormDefaults = {
    title: item.title,
    category: item.category,
    question: item.question ?? undefined,
    answer: item.answer,
    procedure: item.procedure ?? undefined,
    software: item.software ?? undefined,
    module: item.module ?? undefined,
    softwareVersion: item.softwareVersion ?? undefined,
  };

  return (
    <div>
      <PageHeader title={`Edit Knowledge: ${item.title}`} description={`Currently version ${item.currentVersion}.`} />
      <KnowledgeForm action={updateKnowledgeItem.bind(null, item.id)} defaults={defaults} submitLabel="Save New Version" isEdit />
    </div>
  );
}
