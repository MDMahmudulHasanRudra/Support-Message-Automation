import Link from "@/components/ProjectLink";
import { Alert, PageHeader, SectionHeader } from "@/components/ui";
import { pageAccess } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { prisma } from "@/server/db";
import { activeDisabledFeatures } from "@/server/projectFeatures";
import { aiEngineOn, listRecentSocialAiRequests } from "@/server/social/ai";
import { formatInZone } from "../socialUi";
import { AiStudio } from "./AiStudio";

export const metadata = { title: "AI content" };

/**
 * The AI Content Studio (SOCIAL_STUDIO.md §AI): the project's own AI (the Response model under AI
 * Learning → AI Models) suggests ideas, captions, hashtags, rewrites, platform versions, campaign plans
 * and reviews. Product-aware only with products the person chooses, while the catalogue is on and they
 * may see it. Everything is a suggestion that still goes through approval.
 */
export default async function SocialAiPage({ searchParams }: { searchParams: Promise<{ request?: string }> }) {
  const { session, canManage: canEdit } = await pageAccess("social.view", "social.edit", "SOCIAL_STUDIO");
  const sp = await searchParams;
  const [engine, recent, disabled, canSeeProducts] = await Promise.all([aiEngineOn(), listRecentSocialAiRequests(20), activeDisabledFeatures(), hasPermission(session, "commerce.view")]);
  const products =
    !disabled.has("PRODUCT_CATALOG") && canSeeProducts
      ? await prisma.product.findMany({ where: { status: "ACTIVE" }, orderBy: { name: "asc" }, take: 300, select: { id: true, name: true } })
      : null;
  const initial = sp.request ? (recent.find((r) => r.id === sp.request) ?? null) : null;
  return (
    <div>
      <PageHeader title="AI content" description="Ideas, captions, hashtags, rewrites and reviews from this project's AI. Suggestions only: you choose, edit and send them for approval." />
      {!engine ? (
        <Alert tone="warning" title="The AI Engine is switched off for this project, so requests will not be answered.">
          <Link href="/ai-learning/settings" className="link">
            AI Settings
          </Link>
        </Alert>
      ) : null}
      <div className="mt-4">
        <AiStudio canEdit={canEdit} products={products} initial={initial} />
      </div>
      <section className="mt-10">
        <SectionHeader title="Recent requests" />
        {recent.length === 0 ? (
          <p className="text-sm text-[color:var(--color-muted-foreground)]">None yet.</p>
        ) : (
          <ul className="divide-y divide-[var(--color-border)] rounded-[var(--radius-lg)] border border-[var(--color-border)] text-sm">
            {recent.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
                <span className="min-w-0 truncate">
                  <Link href={`/social/ai?request=${r.id}`} className="hover:underline">
                    {r.kind.toLowerCase().replace(/_/g, " ")}: {r.brief || "—"}
                  </Link>
                </span>
                <span className="text-xs text-[color:var(--color-muted-foreground)]">
                  {r.status.toLowerCase()} · {r.requestedByUsername} · {formatInZone(r.createdAt, "Asia/Dhaka")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
