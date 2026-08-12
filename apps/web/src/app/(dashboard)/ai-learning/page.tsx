import Link from "next/link";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Badge, Card, EmptyState, PageHeader, SectionHeader, StatTile } from "@/components/ui";

export default async function AiLearningDashboardPage() {
  await requireSession();

  const [settings, totalKnowledge, activeKnowledge, inactiveKnowledge, archivedKnowledge, providerCount, recentItems] =
    await Promise.all([
      prisma.aiSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } }),
      prisma.aiKnowledgeItem.count(),
      prisma.aiKnowledgeItem.count({ where: { status: "ACTIVE" } }),
      prisma.aiKnowledgeItem.count({ where: { status: "INACTIVE" } }),
      prisma.aiKnowledgeItem.count({ where: { status: "ARCHIVED" } }),
      prisma.aiProvider.count({ where: { status: "ACTIVE" } }),
      prisma.aiKnowledgeItem.findMany({ orderBy: { updatedAt: "desc" }, take: 8 }),
    ]);

  const engineFlags: Array<{ label: string; enabled: boolean }> = [
    { label: "AI Engine", enabled: settings.aiEngineEnabled },
    { label: "Learning", enabled: settings.learningEnabled },
    { label: "Auto Response", enabled: settings.autoResponseEnabled },
    { label: "Screenshot Response", enabled: settings.screenshotResponseEnabled },
  ];

  return (
    <div>
      <PageHeader
        title="AI Dashboard"
        description="Phase 1 foundation: AI provider/model configuration and a manually-curated Knowledge Base. Software/chat/document learning and AI-generated responses come in later phases."
      />

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Total Knowledge" value={totalKnowledge} />
        <StatTile label="Active Knowledge" value={activeKnowledge} tone="success" />
        <StatTile label="Inactive Knowledge" value={inactiveKnowledge} tone="warning" />
        <StatTile label="Archived Knowledge" value={archivedKnowledge} />
      </div>

      <Card className="mb-4">
        <SectionHeader title="AI Status" />
        <div className="flex flex-wrap gap-2">
          {engineFlags.map((f) => (
            <Badge key={f.label} color={f.enabled ? "green" : "gray"} dot>
              {f.label}: {f.enabled ? "ENABLED" : "DISABLED"}
            </Badge>
          ))}
        </div>
        <p className="mt-3 text-xs text-[color:var(--color-muted-foreground)]">
          {providerCount} active provider{providerCount === 1 ? "" : "s"} configured. Manage in{" "}
          <Link href="/ai-learning/providers" className="underline">
            AI Providers
          </Link>
          .
        </p>
      </Card>

      <Card>
        <SectionHeader title="Recently Updated Knowledge" />
        {recentItems.length === 0 ? (
          <EmptyState>
            No knowledge yet.{" "}
            <Link href="/ai-learning/knowledge-base/new" className="underline">
              Add the first entry
            </Link>
            .
          </EmptyState>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {recentItems.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <Link
                  href={`/ai-learning/knowledge-base/${item.id}`}
                  className="text-[color:var(--color-foreground)] underline decoration-dotted decoration-[var(--color-border-strong)] underline-offset-2 hover:text-[color:var(--color-primary)]"
                >
                  {item.title}
                </Link>
                <span className="shrink-0 text-xs text-[color:var(--color-muted-foreground)]">
                  {item.updatedAt.toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
