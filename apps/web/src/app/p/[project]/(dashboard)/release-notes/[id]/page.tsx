import Link from "@/components/ProjectLink";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireSession } from "@/server/auth";
import { requirePermission, hasPermission } from "@/server/permissions";
import { getReleaseNoteForViewer, authorLabel } from "@/server/releaseNotesReports";
import { Alert, ButtonLink, Card, PageHeader } from "@/components/ui";
import { formatDate } from "@/lib/date";
import { ReleaseNoteMeta, ReleaseNoteSections } from "../ReleaseNoteDisplay";

/**
 * One release, in full — the historical record staying reachable forever.
 *
 * Doubles as the admin's "preview before publishing": `getReleaseNoteForViewer()` only widens past
 * PUBLISHED/ARCHIVED when `canManage` is true, so a draft's preview is this exact render with a
 * banner on top, never a second implementation that could drift from what readers actually see.
 */
export default async function ReleaseNoteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  await requirePermission(session, "release_notes.view");
  const canManage = await hasPermission(session, "release_notes.manage");

  const { id } = await params;
  const release = await getReleaseNoteForViewer(id, canManage);
  if (!release) notFound();

  return (
    <div>
      <PageHeader
        title={`v${release.version}`}
        actions={
          canManage ? <ButtonLink href={`/release-notes/manage/${release.id}/edit`}>Edit</ButtonLink> : undefined
        }
      />

      {release.status === "DRAFT" ? (
        <div className="mb-6">
          <Alert tone="warning" title="Draft — not yet published">
            Only visible to you because you can manage release notes. Nobody else can reach this page yet.
          </Alert>
        </div>
      ) : release.status === "ARCHIVED" ? (
        <div className="mb-6">
          <Alert tone="neutral" title="Archived">
            This release has been retired from the current changelog view, but stays reachable here — it still
            happened.
          </Alert>
        </div>
      ) : null}

      <Card>
        <ReleaseNoteMeta release={release} showStatus />
        <div className="mt-6 border-t border-[var(--color-border)] pt-6">
          <ReleaseNoteSections release={release} />
        </div>
        <div className="mt-6 flex flex-wrap gap-x-6 gap-y-1 border-t border-[var(--color-border)] pt-4 text-xs text-[color:var(--color-muted-foreground)]">
          <span>Created by {authorLabel(release.createdBy)}</span>
          {release.publishedAt ? (
            <span>
              Published by {authorLabel(release.publishedBy)} on {formatDate(release.publishedAt)}
            </span>
          ) : null}
        </div>
      </Card>

      <div className="mt-5">
        <Link
          href="/release-notes"
          className="inline-flex items-center gap-1.5 text-sm text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          Back to Release Notes
        </Link>
      </div>
    </div>
  );
}
