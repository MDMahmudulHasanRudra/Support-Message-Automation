import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Badge, type BadgeColor, Button, Card, PageHeader, SectionHeader, Table, Td, Th } from "@/components/ui";
import { KnowledgeStatusActions, RestoreVersionButton } from "./KnowledgeActions";

export default async function KnowledgeItemPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;

  const item = await prisma.aiKnowledgeItem.findUnique({
    where: { id },
    include: {
      createdBy: { select: { name: true, email: true } },
      versions: { orderBy: { version: "desc" }, include: { createdBy: { select: { name: true, email: true } } } },
    },
  });
  if (!item) notFound();

  return (
    <div>
      <PageHeader
        title={item.title}
        description={`${item.category.replace(/_/g, " ")} · Version ${item.currentVersion}`}
        actions={
          <Link href={`/ai-learning/knowledge-base/${item.id}/edit`}>
            <Button variant="secondary">Edit</Button>
          </Link>
        }
      />

      <Card className="mb-4">
        <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <Field label="Status" value={<Badge color={statusColor(item.status)} dot>{item.status}</Badge>} />
          <Field label="Source" value={item.aiGenerated ? "AI Generated" : "Manual"} />
          <Field label="Created by" value={item.createdBy?.name ?? item.createdBy?.email ?? "—"} />
          <Field label="Software" value={[item.software, item.softwareVersion].filter(Boolean).join(" ") || "—"} />
        </dl>
        <div className="mt-4">
          <KnowledgeStatusActions itemId={item.id} status={item.status} />
        </div>
      </Card>

      <Card className="mb-4">
        <SectionHeader title="Content" />
        {item.question ? (
          <div className="mb-3">
            <p className="text-xs font-medium text-[color:var(--color-muted-foreground)]">Question / Intent</p>
            <p className="text-sm text-[color:var(--color-foreground)]">{item.question}</p>
          </div>
        ) : null}
        <div className="mb-3">
          <p className="text-xs font-medium text-[color:var(--color-muted-foreground)]">Answer</p>
          <p className="whitespace-pre-wrap text-sm text-[color:var(--color-foreground)]">{item.answer}</p>
        </div>
        {item.procedure ? (
          <div>
            <p className="text-xs font-medium text-[color:var(--color-muted-foreground)]">Procedure</p>
            <p className="whitespace-pre-wrap text-sm text-[color:var(--color-foreground)]">{item.procedure}</p>
          </div>
        ) : null}
      </Card>

      <Card>
        <SectionHeader title={`Version History (${item.versions.length})`} />
        <Table>
          <thead>
            <tr>
              <Th>Version</Th>
              <Th>Change Summary</Th>
              <Th>By</Th>
              <Th>When</Th>
              <Th>Manage</Th>
            </tr>
          </thead>
          <tbody>
            {item.versions.map((v) => (
              <tr key={v.id}>
                <Td className="tabular-nums">
                  {v.version}
                  {v.version === item.currentVersion ? <Badge color="blue">Current</Badge> : null}
                </Td>
                <Td className="max-w-md">{v.changeSummary ?? "—"}</Td>
                <Td>{v.createdBy?.name ?? v.createdBy?.email ?? "—"}</Td>
                <Td>{v.createdAt.toLocaleString()}</Td>
                <Td>
                  {v.version !== item.currentVersion ? (
                    <RestoreVersionButton itemId={item.id} version={v.version} />
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <p className="mt-4 text-xs">
        <Link
          href="/ai-learning/knowledge-base"
          className="text-[color:var(--color-muted-foreground)] underline hover:text-[color:var(--color-foreground)]"
        >
          Back to Knowledge Base
        </Link>
      </p>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-[color:var(--color-muted-foreground)]">{label}</dt>
      <dd className="mt-0.5 text-[color:var(--color-foreground)]">{value}</dd>
    </div>
  );
}

function statusColor(status: string): BadgeColor {
  if (status === "ACTIVE") return "green";
  if (status === "ARCHIVED") return "gray";
  return "yellow";
}
