import { requireSession } from "@/server/auth";
import { requirePermission } from "@/server/permissions";
import { PageHeader } from "@/components/ui";
import { createReleaseNoteDraft } from "@/server/actions/releaseNotes";
import { ReleaseNoteForm } from "../ReleaseNoteForm";

export default async function NewReleaseNotePage() {
  const session = await requireSession();
  await requirePermission(session, "release_notes.manage");

  return (
    <div>
      <PageHeader title="New Release" description="Saved as a draft — nothing here is visible to users until you publish it." />
      <ReleaseNoteForm action={createReleaseNoteDraft} submitLabel="Create Draft" />
    </div>
  );
}
