import { notFound } from "next/navigation";
import { requireSession } from "@/server/auth";
import { requirePermission } from "@/server/permissions";
import { getReleaseNoteForEditing } from "@/server/releaseNotesReports";
import { Badge, ButtonLink, PageHeader } from "@/components/ui";
import { RELEASE_STATUS_BADGE_COLOR, RELEASE_STATUS_LABEL } from "@/lib/releaseNotes";
import { updateReleaseNote } from "@/server/actions/releaseNotes";
import { ReleaseNoteForm, type ReleaseNoteFormDefaults } from "../../ReleaseNoteForm";

export default async function EditReleaseNotePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  await requirePermission(session, "release_notes.manage");

  const { id } = await params;
  const found = await getReleaseNoteForEditing(id);
  if (!found) notFound();
  const { release, revisionCount } = found;

  const defaults: ReleaseNoteFormDefaults = {
    version: release.version,
    title: release.title,
    summary: release.summary ?? undefined,
    releaseDate: release.releaseDate.toISOString().slice(0, 10),
    releaseType: release.releaseType,
    whatsNew: release.whatsNew.join("\n"),
    improvements: release.improvements.join("\n"),
    bugFixes: release.bugFixes.join("\n"),
    security: release.security.join("\n"),
    breakingChanges: release.breakingChanges.join("\n"),
    knownIssues: release.knownIssues.join("\n"),
    technicalNotes: release.technicalNotes.join("\n"),
    affectedModules: release.affectedModules,
  };

  const isPublic = release.status === "PUBLISHED" || release.status === "ARCHIVED";

  return (
    <div>
      <PageHeader
        title={`Edit v${release.version}`}
        description={
          isPublic
            ? "This release is public. Saving here keeps a full history of what it said before your edit."
            : "This draft is not visible to anyone else yet."
        }
        actions={
          <>
            <Badge color={RELEASE_STATUS_BADGE_COLOR[release.status]} dot>
              {RELEASE_STATUS_LABEL[release.status]}
            </Badge>
            <ButtonLink href={`/release-notes/${release.id}`} variant="secondary">
              Preview
            </ButtonLink>
          </>
        }
      />

      {revisionCount > 0 ? (
        <p className="mb-5 -mt-4 text-xs text-[color:var(--color-muted-foreground)]">
          Edited {revisionCount} time{revisionCount === 1 ? "" : "s"} since it was first published.
        </p>
      ) : null}

      <ReleaseNoteForm action={updateReleaseNote.bind(null, release.id)} defaults={defaults} submitLabel="Save Changes" />
    </div>
  );
}
