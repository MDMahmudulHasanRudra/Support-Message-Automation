/* eslint-disable react/no-unescaped-entities -- long-form Help prose reads better with real apostrophes */
import Link from "next/link";
import { prisma } from "@support-automation/db";
import { isForgeConfigured } from "@support-automation/forge-client";
import { requireSession } from "@/server/auth";
import { formatDateTime } from "@/lib/date";
import { Alert, Card, HelpButton, HelpSection, PageHeader,
  SectionHeader, StatTile } from "@/components/ui";
import { ForgeSettingsCard } from "./ForgeSettingsCard";

/**
 * Where an admin points this support system at the product it answers questions about.
 *
 * The page leads with what has actually been learned rather than with the switches, because the
 * question an operator arrives with is "does the assistant know about billing yet", not "is the
 * integration enabled".
 */
export default async function ForgeIntegrationPage() {
  await requireSession();

  const configured = isForgeConfigured();
  const settings = await prisma.forgeSettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });

  const [verifiedCount, pendingCount, blockedRecently, researchPending, researchAnswered, modules] = await Promise.all([
    prisma.aiKnowledgeItem.count({
      where: { source: { startsWith: "FORGE" }, humanVerified: true, status: "ACTIVE" },
    }),
    prisma.aiKnowledgeItem.count({ where: { source: { startsWith: "FORGE" }, humanVerified: false } }),
    prisma.systemLog.count({
      where: {
        scope: "forge",
        level: "WARN",
        // eslint-disable-next-line react-hooks/purity -- server component runs fresh per request; not subject to render-purity rules
        createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60_000) },
      },
    }),
    prisma.forgeResearchTask.count({ where: { status: "PENDING" } }),
    prisma.forgeResearchTask.count({ where: { status: "ANSWERED" } }),
    prisma.aiKnowledgeItem.groupBy({
      by: ["module"],
      where: { source: { startsWith: "FORGE" } },
      _count: { module: true },
      orderBy: { _count: { module: "desc" } },
      take: 12,
    }),
  ]);

  const topUnanswered = await prisma.forgeResearchTask.findMany({
    where: { status: { in: ["PENDING", "NO_ANSWER"] } },
    orderBy: [{ askedCount: "desc" }, { createdAt: "desc" }],
    take: 5,
    select: { id: true, question: true, askedCount: true, status: true, error: true },
  });

  return (
    <div>
      <PageHeader
        title="Product Knowledge (Softify Forge)"
        description="Teaches this support system about ISPDIGITAL by reading its own documentation and code, so the assistant can answer customer questions about the product."
        actions={
          <HelpButton moduleTitle="Product Knowledge">
            <HelpSection title="Where the answers come from">
              <p>
                Three tiers, in order of authority. First, the user guides your team wrote for
                customers — authoritative, so they can go live without review. Second, for product
                areas nobody has documented, the AI reads the code behind that area and writes a
                user guide for it. Third, when a customer asks something nothing covers, that
                question is researched against the code so the next person to ask gets an answer.
              </p>
            </HelpSection>
            <HelpSection title="What a customer can never see">
              <p>
                Everything produced here passes a disclosure check before it is stored. Anything
                naming source code, database tables, internal record names, API endpoints,
                infrastructure, servers or credentials is dropped and never saved — not even as a
                draft. The customer-facing assistant only ever reads verified knowledge; it has no
                access to the repository at all.
              </p>
            </HelpSection>
            <HelpSection title="Why code-derived answers wait for review">
              <p>
                A guide your team wrote is a statement of fact. A model's reading of source code is
                evidence. Tiers two and three always land in Pending Review, whatever the settings
                say, so a person decides what is fit to tell a customer.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />

      {!configured ? (
        <div className="mb-5">
          <Alert tone="warning">
            Forge is not configured. Set <code>FORGE_API_KEY</code> and <code>FORGE_API_URL</code> in
            the environment and restart, then this page can connect. See <code>FORGE_SETUP.md</code>.
          </Alert>
        </div>
      ) : null}

      {settings.lastSyncError ? (
        <div className="mb-5">
          <Alert tone="danger">{settings.lastSyncError}</Alert>
        </div>
      ) : null}

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Answers the AI can use" value={verifiedCount} hint="Verified and active" />
        <StatTile
          label="Waiting for review"
          value={pendingCount}
          hint={pendingCount > 0 ? "Code-derived — needs a human" : "Nothing pending"}
        />
        <StatTile
          label="Blocked this week"
          value={blockedRecently}
          hint="Would have exposed internals"
        />
        <StatTile
          label="Questions researched"
          value={`${researchAnswered}${researchPending > 0 ? ` (+${researchPending} queued)` : ""}`}
          hint="Gaps found from real customers"
        />
      </div>

      {pendingCount > 0 ? (
        <div className="mb-5">
          <Alert tone="info">
            {pendingCount} {pendingCount === 1 ? "entry is" : "entries are"} waiting for a human to
            check before the assistant may use {pendingCount === 1 ? "it" : "them"}.{" "}
            <Link className="link" href="/ai-learning/knowledge-base/review">
              Open the review queue
            </Link>
            .
          </Alert>
        </div>
      ) : null}

      <ForgeSettingsCard
        configured={configured}
        settings={{
          enabled: settings.enabled,
          projectId: settings.projectId,
          projectName: settings.projectName,
          syncUserGuides: settings.syncUserGuides,
          syncModuleGuides: settings.syncModuleGuides,
          researchUnanswered: settings.researchUnanswered,
          autoVerifyUserGuides: settings.autoVerifyUserGuides,
        }}
        lastSyncCompletedAt={settings.lastSyncCompletedAt ? formatDateTime(settings.lastSyncCompletedAt) : null}
      />

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card>
      <SectionHeader title="What the assistant has learned" description="Entries by product area." />
          {modules.length === 0 ? (
            <p className="text-[13px] text-[color:var(--color-muted-foreground)]">
              Nothing yet. Turn the integration on and run a sync.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {modules.map((row) => (
                <li key={row.module ?? "none"} className="flex items-center justify-between gap-3 text-[13px]">
                  <span className="min-w-0 truncate text-[color:var(--color-foreground)]">
                    {row.module ?? "General"}
                  </span>
                  <span className="tabular shrink-0 text-[color:var(--color-muted-foreground)]">
                    {row._count.module}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
      <SectionHeader title="Questions customers asked that nothing covered" description="Most-asked first. These are the real gaps in your documentation." />
          {topUnanswered.length === 0 ? (
            <p className="text-[13px] text-[color:var(--color-muted-foreground)]">
              No gaps recorded. This fills in as customers ask things the knowledge base cannot answer.
            </p>
          ) : (
            <ul className="space-y-2.5">
              {topUnanswered.map((task) => (
                <li key={task.id} className="text-[13px]">
                  <p className="text-[color:var(--color-foreground)]">{task.question}</p>
                  <p className="mt-0.5 text-[11px] text-[color:var(--color-muted-foreground)]">
                    Asked {task.askedCount} {task.askedCount === 1 ? "time" : "times"}
                    {task.status === "NO_ANSWER" && task.error ? ` — ${task.error}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
