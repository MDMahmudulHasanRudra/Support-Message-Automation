import Link from "@/components/ProjectLink";
import { Megaphone } from "lucide-react";
import { requireSession } from "@/server/auth";
import { requirePermission, hasPermission } from "@/server/permissions";
import { getPublishedReleaseNotes } from "@/server/releaseNotesReports";
import { Badge, ButtonLink, Card, EmptyState, PageHeader, SectionHeader } from "@/components/ui";
import { formatDate } from "@/lib/date";
import { RELEASE_TYPE_BADGE_COLOR, RELEASE_TYPE_LABEL } from "@/lib/releaseNotes";
import { ReleaseNoteMeta, ReleaseNoteSections } from "./ReleaseNoteDisplay";

/**
 * The changelog every user can read — a permanent historical record of what shipped, in the
 * product's own words rather than a git log. `getPublishedReleaseNotes()` is the one read path
 * this page uses, and it already hard-codes PUBLISHED-and-ARCHIVED-only; there is no DRAFT here
 * under any condition, including for an admin (an admin previewing an unpublished draft goes
 * through `/release-notes/[id]` instead, which is the one page allowed to widen that).
 *
 * The newest release renders in FULL — every section it actually has content in — and everything
 * older collapses to a single line each below it, matching how a changelog is actually read: people
 * come here to see what is new right now, and occasionally to check when something specific shipped.
 */
export default async function ReleaseNotesPage() {
  const session = await requireSession();
  await requirePermission(session, "release_notes.view");
  const canManage = await hasPermission(session, "release_notes.manage");

  const releases = await getPublishedReleaseNotes();
  const [latest, ...older] = releases;

  return (
    <div>
      <PageHeader
        title="Release Notes"
        description="Latest updates and improvements."
        actions={canManage ? <ButtonLink href="/release-notes/manage">Manage Releases</ButtonLink> : undefined}
      />

      {!latest ? (
        <Card>
          <EmptyState icon={<Megaphone className="size-5" aria-hidden />}>
            No releases have been published yet.
            {canManage ? (
              <>
                {" "}
                <Link href="/release-notes/manage/new" className="underline underline-offset-2">
                  Create the first one
                </Link>
                .
              </>
            ) : null}
          </EmptyState>
        </Card>
      ) : (
        <>
          <Card className="mb-8">
            <ReleaseNoteMeta release={latest} />
            <div className="mt-6 border-t border-[var(--color-border)] pt-6">
              <ReleaseNoteSections release={latest} />
            </div>
          </Card>

          {older.length > 0 ? (
            <div>
              <SectionHeader title="Older Releases" />
              <Card className="divide-y divide-[var(--color-border)] p-0">
                {older.map((release) => (
                  <Link
                    key={release.id}
                    href={`/release-notes/${release.id}`}
                    className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-4 transition-colors duration-[var(--duration-fast)] first:rounded-t-[var(--radius-xl)] last:rounded-b-[var(--radius-xl)] hover:bg-[var(--color-surface-sunken)]"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <Badge color="blue">v{release.version}</Badge>
                      <Badge color={RELEASE_TYPE_BADGE_COLOR[release.releaseType]}>
                        {RELEASE_TYPE_LABEL[release.releaseType]}
                      </Badge>
                      <span className="truncate text-sm font-medium text-[color:var(--color-foreground)]">
                        {release.title}
                      </span>
                    </div>
                    <span className="text-xs text-[color:var(--color-muted-foreground)]">
                      {formatDate(release.releaseDate)}
                    </span>
                  </Link>
                ))}
              </Card>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
