/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import Link from "next/link";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Button, HelpButton, HelpSection, PageHeader } from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import { AiProvidersTable, type AiProviderRow } from "./AiProvidersTable";

/**
 * Mirrors PROVIDER_HEALTH_LOG_SCOPE in packages/ai-client/src/providerHealth.ts. apps/web can't
 * import that package (it pulls in the worker's client stack), so the string is repeated here the
 * same way testAiProviderConnection() repeats the request shape rather than importing it.
 */
const PROVIDER_HEALTH_LOG_SCOPE = "ai-provider";

/** Long enough to catch "it's been flaky all morning", short enough that a cleared blip ages out. */
const TRANSIENT_WINDOW_HOURS = 24;

export default async function AiProvidersPage() {
  await requireSession();

  const now = new Date();
  const since = new Date(now.getTime() - TRANSIENT_WINDOW_HOURS * 60 * 60_000);
  const [providers, transientLogs] = await Promise.all([
    prisma.aiProvider.findMany({
      include: { _count: { select: { models: true } } },
      orderBy: { createdAt: "asc" },
    }),
    // Filtered in JS rather than with a JSON path predicate: this is a bounded, recent slice, and
    // the provider id lives inside `metadata` alongside the transient flag we also need to read.
    prisma.systemLog.findMany({
      where: { scope: PROVIDER_HEALTH_LOG_SCOPE, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 500,
      select: { metadata: true, createdAt: true },
    }),
  ]);

  const transientByProvider = new Map<string, { count: number; latest: Date }>();
  for (const log of transientLogs) {
    const meta = log.metadata as { providerId?: unknown; transient?: unknown } | null;
    if (meta?.transient !== true || typeof meta.providerId !== "string") continue;
    const existing = transientByProvider.get(meta.providerId);
    // Logs come back newest-first, so the first one seen for a provider is its latest.
    if (existing) existing.count += 1;
    else transientByProvider.set(meta.providerId, { count: 1, latest: log.createdAt });
  }

  const rows: AiProviderRow[] = providers.map((p) => {
    const transient = transientByProvider.get(p.id);
    return {
      id: p.id,
      name: p.name,
      kind: p.kind,
      status: p.status,
      modelCount: p._count.models,
      lastVerdictAtLabel: p.lastTestedAt ? formatDateTime(p.lastTestedAt) : null,
      lastVerdictOk: p.lastTestOk,
      lastVerdictError: p.lastTestError,
      transientCount: transient?.count ?? 0,
      transientLatestLabel: transient ? formatDateTime(transient.latest) : null,
      transientWindowHours: TRANSIENT_WINDOW_HOURS,
    };
  });

  return (
    <div>
      <PageHeader
        title="AI Providers"
        description="API keys are encrypted at rest and never shown again in full."
        actions={
          <>
            <HelpButton moduleTitle="AI Providers">
              <HelpSection title="What this is">
                <p>
                  Stores the credentials for an AI service so a job on the AI Models page can use
                  it. Four connection types work end to end: <strong>Anthropic</strong> (Claude
                  direct), <strong>OpenAI</strong> (or any endpoint speaking the same protocol),{" "}
                  <strong>OpenRouter</strong> (one key, many vendors' models) and{" "}
                  <strong>Ollama</strong> (a model on your own hardware — no API key needed, and the
                  only type saved without one).
                </p>
                <p>
                  Your API key is encrypted at rest and never displayed again in full. When editing,
                  leave the key field blank to keep the existing one. Changing a provider's{" "}
                  <em>type</em> always discards the saved key, because a key issued by one vendor is
                  meaningless — and unsafe to send — to another.
                </p>
              </HelpSection>
              <HelpSection title="Test Connection">
                <p>
                  Works for every type on this page. It authenticates first (so "your key is wrong"
                  never gets reported as "that model doesn't exist"), then sends a genuine two-token
                  completion using whichever model this provider is actually assigned on the AI
                  Models page. That end-to-end call is the only check that proves a completion will
                  work; a reachable host proves nothing, since OpenRouter's model catalogue answers
                  200 to a garbage key and Ollama has no authentication at all.
                </p>
                <p>
                  If no model is assigned yet, the test verifies the credentials and says so rather
                  than claiming more than it checked.
                </p>
              </HelpSection>
              <HelpSection title="Reading the Last verdict column">
                <p>
                  This is the last <strong>definitive</strong> verdict on the provider's
                  credentials, endpoint and model — from whichever came last, the Test Connection
                  button or a real AI call made while answering a customer or building knowledge.
                  Before, it moved only when someone pressed Test, so a provider that had been
                  rejecting every request for a week still showed green.
                </p>
                <p>
                  A rate limit, an outage or a dropped connection deliberately does{" "}
                  <em>not</em> turn it red. Those say nothing about whether the key or the model id
                  is right, and colouring a blip like a misconfiguration would teach you to ignore
                  the badge. They're counted separately as "temporary failures", and every one is in
                  System Logs under the <code>ai-provider</code> scope.
                </p>
              </HelpSection>
              <HelpSection title="Deleting a provider">
                <p>
                  Permanent — there's no undo. Any AI Model job currently assigned to it will need
                  to be reassigned on the AI Models page.
                </p>
              </HelpSection>
            </HelpButton>
            <Link href="/ai-learning/providers/new">
              <Button>Add Provider</Button>
            </Link>
          </>
        }
      />
      <AiProvidersTable providers={rows} />
    </div>
  );
}
