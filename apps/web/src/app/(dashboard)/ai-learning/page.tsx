/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import Link from "next/link";
import {
  ArrowRight,
  BookOpen,
  Cpu,
  KeyRound,
  Settings as SettingsIcon,
  type LucideIcon,
} from "lucide-react";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Badge, Card, EmptyState, HelpButton, HelpSection, PageHeader, SectionHeader, StatTile } from "@/components/ui";

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
        actions={
          <HelpButton moduleTitle="AI Dashboard">
            <HelpSection title="Please read this before configuring anything in AI Learning">
              <p>
                Everything in this entire module — Knowledge Base, Providers, Models, and the Settings
                toggles below — is <strong>configuration only</strong>. Nothing here currently affects
                how the WhatsApp bot behaves or what it sends to customers. It's safe to fill in now
                and will presumably be used once later phases ship, but as of today, turning a switch
                ON or adding Knowledge Base entries has zero live effect. The one exception is the
                Providers page's "Test Connection" button, which does make a real API call, purely to
                verify a stored key works.
              </p>
            </HelpSection>
            <HelpSection title="What each stat/status shows">
              <p>
                The Knowledge counts are simple totals by status. "AI Status" just displays whatever
                you've toggled on the AI Settings page — it's a read-only mirror, not a separate
                control. "Active provider(s) configured" counts AI Providers currently marked ACTIVE.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />

      <SectionHeader title="Sections" description="Jump into a specific area of the AI Learning module." />
      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <HubLink
          href="/ai-learning/knowledge-base"
          icon={BookOpen}
          label="Knowledge Base"
          description={`${totalKnowledge} entr${totalKnowledge === 1 ? "y" : "ies"}`}
        />
        <HubLink
          href="/ai-learning/providers"
          icon={KeyRound}
          label="AI Providers"
          description={`${providerCount} active`}
        />
        <HubLink
          href="/ai-learning/models"
          icon={Cpu}
          label="AI Models"
          description="Assign provider/model per job"
        />
        <HubLink
          href="/ai-learning/settings"
          icon={SettingsIcon}
          label="AI Settings"
          description="Master switches & thresholds"
        />
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatTile label="Total Knowledge" value={totalKnowledge} />
        <StatTile label="Active Knowledge" value={activeKnowledge} tone="success" />
        <StatTile label="Inactive Knowledge" value={inactiveKnowledge} tone="warning" />
        <StatTile label="Archived Knowledge" value={archivedKnowledge} />
      </div>

      <Card className="mb-6">
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

function HubLink({
  href,
  icon: Icon,
  label,
  description,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  description: string;
}) {
  return (
    <Link href={href} className="group block h-full">
      <Card className="flex h-full items-start gap-3 transition-shadow duration-200 hover:border-[var(--color-primary)]/40 hover:shadow-[var(--shadow-md)]">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--color-primary-soft)] text-[color:var(--color-primary)]">
          <Icon className="size-4.5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-[color:var(--color-foreground)]">{label}</p>
          <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">{description}</p>
        </div>
        <ArrowRight
          className="mt-1 size-4 shrink-0 text-[color:var(--color-muted-foreground)] transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-[color:var(--color-primary)]"
          aria-hidden
        />
      </Card>
    </Link>
  );
}
