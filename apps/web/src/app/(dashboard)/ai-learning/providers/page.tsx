import Link from "next/link";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Button, PageHeader } from "@/components/ui";
import { AiProvidersTable, type AiProviderRow } from "./AiProvidersTable";

export default async function AiProvidersPage() {
  await requireSession();
  const providers = await prisma.aiProvider.findMany({
    include: { _count: { select: { models: true } } },
    orderBy: { createdAt: "asc" },
  });

  const rows: AiProviderRow[] = providers.map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    status: p.status,
    modelCount: p._count.models,
    lastTestedAtLabel: p.lastTestedAt ? p.lastTestedAt.toLocaleString() : null,
    lastTestOk: p.lastTestOk,
    lastTestError: p.lastTestError,
  }));

  return (
    <div>
      <PageHeader
        title="AI Providers"
        description="API keys are encrypted at rest and never shown again in full."
        actions={
          <Link href="/ai-learning/providers/new">
            <Button>Add Provider</Button>
          </Link>
        }
      />
      <AiProvidersTable providers={rows} />
    </div>
  );
}
