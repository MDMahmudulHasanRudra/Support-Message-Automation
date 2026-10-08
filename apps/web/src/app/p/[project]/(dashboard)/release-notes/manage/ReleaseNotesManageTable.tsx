"use client";

import { useState, useTransition } from "react";
import Link from "@/components/ProjectLink";
import { Eye, Pencil, Trash2 } from "lucide-react";
import type { ReleaseNoteStatus, ReleaseNoteType } from "@prisma/client";
import { Badge, Button, ConfirmDialog, EmptyState, Table, Td, Th, useToast } from "@/components/ui";
import { formatDate } from "@/lib/date";
import {
  RELEASE_STATUS_BADGE_COLOR,
  RELEASE_STATUS_LABEL,
  RELEASE_TYPE_BADGE_COLOR,
  RELEASE_TYPE_LABEL,
} from "@/lib/releaseNotes";
import {
  deleteReleaseNoteDraft,
  transitionReleaseNoteStatus,
  type ReleaseNoteTransition,
} from "@/server/actions/releaseNotes";

export interface ReleaseNoteManageRow {
  id: string;
  version: string;
  title: string;
  releaseDate: string;
  releaseType: ReleaseNoteType;
  status: ReleaseNoteStatus;
  createdByLabel: string;
  updatedAt: string;
}

/** Which transitions make sense to offer FROM each status, and how the button reads. */
const AVAILABLE_TRANSITIONS: Record<ReleaseNoteStatus, Array<{ transition: ReleaseNoteTransition; label: string }>> = {
  DRAFT: [{ transition: "PUBLISH", label: "Publish" }],
  PUBLISHED: [
    { transition: "ARCHIVE", label: "Archive" },
    { transition: "UNPUBLISH", label: "Unpublish" },
  ],
  ARCHIVED: [{ transition: "REPUBLISH", label: "Re-publish" }],
};

export function ReleaseNotesManageTable({ rows }: { rows: ReleaseNoteManageRow[] }) {
  const [pending, startTransition] = useTransition();
  const [deleting, setDeleting] = useState<ReleaseNoteManageRow | null>(null);
  const { showToast } = useToast();

  function handleTransition(row: ReleaseNoteManageRow, transition: ReleaseNoteTransition, label: string) {
    startTransition(async () => {
      const result = await transitionReleaseNoteStatus(row.id, transition);
      if (result.error) {
        showToast({ tone: "danger", title: result.error });
        return;
      }
      showToast({ tone: "success", title: `"${row.version}" ${label.toLowerCase()}ed` });
    });
  }

  function handleDelete() {
    if (!deleting) return;
    const row = deleting;
    startTransition(async () => {
      const result = await deleteReleaseNoteDraft(row.id);
      setDeleting(null);
      if (result.error) {
        showToast({ tone: "danger", title: result.error });
        return;
      }
      showToast({ tone: "success", title: `Draft "${row.version}" deleted` });
    });
  }

  if (rows.length === 0) {
    return <EmptyState>No release notes match these filters.</EmptyState>;
  }

  return (
    <>
      <Table>
        <thead>
          <tr>
            <Th>Version</Th>
            <Th>Title</Th>
            <Th>Type</Th>
            <Th>Status</Th>
            <Th>Release date</Th>
            <Th>Created by</Th>
            <Th> </Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <Td className="font-medium">v{row.version}</Td>
              <Td className="max-w-xs truncate">{row.title}</Td>
              <Td>
                <Badge color={RELEASE_TYPE_BADGE_COLOR[row.releaseType]}>{RELEASE_TYPE_LABEL[row.releaseType]}</Badge>
              </Td>
              <Td>
                <Badge color={RELEASE_STATUS_BADGE_COLOR[row.status]} dot>
                  {RELEASE_STATUS_LABEL[row.status]}
                </Badge>
              </Td>
              <Td className="whitespace-nowrap text-xs">{formatDate(new Date(row.releaseDate))}</Td>
              <Td className="text-[color:var(--color-muted-foreground)]">{row.createdByLabel}</Td>
              <Td>
                <div className="flex flex-wrap justify-end gap-1.5">
                  <Link
                    href={`/release-notes/${row.id}`}
                    className="inline-flex size-7 items-center justify-center rounded-[var(--radius-sm)] text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)]"
                    title="Preview"
                  >
                    <Eye className="size-3.5" aria-hidden />
                  </Link>
                  <Link
                    href={`/release-notes/manage/${row.id}/edit`}
                    className="inline-flex size-7 items-center justify-center rounded-[var(--radius-sm)] text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)]"
                    title="Edit"
                  >
                    <Pencil className="size-3.5" aria-hidden />
                  </Link>
                  {AVAILABLE_TRANSITIONS[row.status].map(({ transition, label }) => (
                    <Button
                      key={transition}
                      size="sm"
                      variant="secondary"
                      disabled={pending}
                      onClick={() => handleTransition(row, transition, label)}
                    >
                      {label}
                    </Button>
                  ))}
                  {row.status === "DRAFT" ? (
                    <Button size="sm" variant="ghost" disabled={pending} onClick={() => setDeleting(row)}>
                      <Trash2 className="size-3.5" aria-hidden />
                    </Button>
                  ) : null}
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={handleDelete}
        title={deleting ? `Delete draft "v${deleting.version}"?` : ""}
        description="This draft was never published, so nothing else references it. This cannot be undone."
        confirmLabel="Delete"
        tone="danger"
        loading={pending}
      />
    </>
  );
}
