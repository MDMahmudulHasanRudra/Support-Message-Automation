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
import { formatDateTime } from "@/lib/date";

export default async function AiLearningDashboardPage() {
  await requireSession();

  const [
    settings,
    totalKnowledge,
    activeKnowledge,
    inactiveKnowledge,
    archivedKnowledge,
    providerCount,
    recentItems,
    aiRequestCount,
    aiRepliedCount,
    humanFallbackCount,
    confidenceAgg,
    tokensAgg,
    ruleMatchCount,
  ] = await Promise.all([
    prisma.aiSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } }),
    prisma.aiKnowledgeItem.count(),
    prisma.aiKnowledgeItem.count({ where: { status: "ACTIVE" } }),
    prisma.aiKnowledgeItem.count({ where: { status: "INACTIVE" } }),
    prisma.aiKnowledgeItem.count({ where: { status: "ARCHIVED" } }),
    prisma.aiProvider.count({ where: { status: "ACTIVE" } }),
    prisma.aiKnowledgeItem.findMany({ orderBy: { updatedAt: "desc" }, take: 8 }),
    // "AI Requests" excludes AI_UNAVAILABLE specifically — the one outcome where no API call was
    // actually attempted (resolveAiClient() returned null before any completion request went out).
    prisma.aiFallbackDecision.count({ where: { NOT: { reason: "AI_UNAVAILABLE" } } }),
    prisma.aiFallbackDecision.count({ where: { outcome: "AI_REPLIED" } }),
    prisma.aiFallbackDecision.count({ where: { outcome: "HUMAN_FALLBACK" } }),
    prisma.aiFallbackDecision.aggregate({ _avg: { confidenceScore: true } }),
    prisma.aiFallbackDecision.aggregate({ _sum: { tokensUsed: true } }),
    // The cost-reduction counter: every one of these is a message a rule already handled,
    // deterministically, with zero AI cost — the mechanism this whole feature exists to grow.
    prisma.automationExecution.count({ where: { ruleId: { not: null } } }),
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
        title="AI Learning"
        description="Phase 1 foundation: AI provider/model configuration and a manually-curated Knowledge Base. Software/chat/document learning and AI-generated responses come in later phases."
        actions={
          <HelpButton moduleTitle="AI Learning">
            <HelpSection title="Please read this before configuring anything in AI Learning">
              <p>
                Knowledge Base and Models are still configuration only, with no live effect yet.
                Providers and Settings are different: assigning an ACTIVE provider to the{" "}
                <strong>Response</strong> model slot, with AI Engine and Auto Response both ON on the
                Settings page, activates the live Hybrid AI Automation fallback layer — see the
                Settings page's own help for exactly what that does. The Providers page's "Test
                Connection" button always makes a real API call, purely to verify a stored key works.
              </p>
            </HelpSection>
            <HelpSection title="What each stat/status shows">
              <p>
                The Knowledge counts are simple totals by status. "AI Status" just displays whatever
                you've toggled on the AI Settings page — it's a read-only mirror, not a separate
                control. "Active provider(s) configured" counts AI Providers currently marked ACTIVE.
                "AI Fallback Activity" below is a live, all-time count straight from
                AiFallbackDecision/AutomationExecution — never a separately-tracked, potentially
                stale counter.
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

      <Card className="mb-6">
        <SectionHeader
          title="AI Fallback Activity"
          description="All-time, live from AiFallbackDecision/AutomationExecution — never a separately-tracked counter."
        />
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
          <StatTile label="AI Requests" value={aiRequestCount} />
          <StatTile label="AI Replies" value={aiRepliedCount} tone="success" />
          <StatTile label="Human Fallbacks" value={humanFallbackCount} tone="warning" />
          <StatTile
            label="Avg. Confidence"
            value={confidenceAgg._avg.confidenceScore != null ? `${Math.round(confidenceAgg._avg.confidenceScore)}%` : "—"}
          />
          <StatTile label="Tokens Used" value={tokensAgg._sum.tokensUsed ?? 0} />
          <StatTile label="Rule Matches (AI avoided)" value={ruleMatchCount} tone="success" />
        </div>
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
                  className="text-[color:var(--color-foreground)] underline decoration-dotted decoration-[var(--color-border-strong)] underline-offset-2 hover:decoration-[var(--color-foreground)]"
                >
                  {item.title}
                </Link>
                <span className="shrink-0 text-xs text-[color:var(--color-muted-foreground)]">
                  {formatDateTime(item.updatedAt)}
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
          className="mt-1 size-4 shrink-0 text-[color:var(--color-muted-foreground)] transition-transform duration-150 group-hover:translate-x-0.5 group-hover:decoration-[var(--color-foreground)]"
          aria-hidden
        />
      </Card>
    </Link>
  );
}
