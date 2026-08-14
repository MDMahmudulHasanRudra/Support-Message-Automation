/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import Link from "next/link";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Button, HelpButton, HelpSection, PageHeader } from "@/components/ui";
import { formatDateTime } from "@/lib/date";
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
    lastTestedAtLabel: p.lastTestedAt ? formatDateTime(p.lastTestedAt) : null,
    lastTestOk: p.lastTestOk,
    lastTestError: p.lastTestError,
  }));

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
                  Stores API credentials for AI services (Anthropic, OpenAI, Google, or a custom
                  endpoint) so they can be assigned to a job on the AI Models page. Your API key is
                  encrypted at rest and never displayed again in full after you save it — when editing,
                  leave the key field blank to keep the existing one unchanged.
                </p>
              </HelpSection>
              <HelpSection title="Test Connection">
                <p>
                  The one genuinely live action on this page — makes a real, minimal API call to verify
                  the stored key/URL actually works, and records pass/fail with a timestamp.
                  Currently only implemented for the ANTHROPIC provider type; testing an OpenAI/Google/
                  Custom provider will say connection testing isn't implemented yet for that type (the
                  stored key itself is still fine, only the test button is a no-op for those types today).
                </p>
              </HelpSection>
              <HelpSection title="Deleting a provider">
                <p>
                  Permanent — there's no undo. Any AI Model job currently assigned to it will need to be
                  reassigned to a different provider on the AI Models page.
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
