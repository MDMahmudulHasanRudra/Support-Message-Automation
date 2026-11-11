"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Archive, Copy, Pencil, Trash2, Undo2 } from "lucide-react";
import { Button, ButtonLink, ConfirmDialog, useToast } from "@/components/ui";
import { deleteModuleTemplate, duplicateModuleTemplate, setModuleTemplateArchived } from "@/server/actions/moduleTemplates";

/** Edit / duplicate / archive for one template card. Each action checks the permission itself. */
export function TemplateRowActions({ templateKey, canManage, editable, archived = false }: { templateKey: string; canManage: boolean; editable: boolean; archived?: boolean }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [confirmDelete, setConfirmDelete] = useState(false);
  if (!canManage) return null;

  const run = (fn: () => Promise<{ error?: string; success?: string; id?: string }>, then?: (id: string) => void) =>
    startTransition(async () => {
      const r = await fn();
      if (r.error) {
        showToast({ tone: "danger", title: r.error });
        return;
      }
      showToast({ tone: "success", title: r.success ?? "Done." });
      if (then && r.id) then(r.id);
      else router.refresh();
    });

  if (archived) {
    return (
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => setModuleTemplateArchived(templateKey, false))}>
          <Undo2 className="size-3.5" aria-hidden />
          Restore
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirmDelete(true)}>
          <Trash2 className="size-3.5" aria-hidden />
          Delete
        </Button>
        <ConfirmDialog
          open={confirmDelete}
          onClose={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            run(() => deleteModuleTemplate(templateKey));
          }}
          title="Delete this template?"
          description="It is removed for good. Projects created with it keep their modules, and their history still names it."
          confirmLabel="Delete template"
          tone="danger"
          loading={pending}
        />
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-2">
      {editable ? (
        <ButtonLink href={`/admin/module-templates/${templateKey}`} size="sm" variant="secondary">
          <Pencil className="size-3.5" aria-hidden />
          Edit
        </ButtonLink>
      ) : null}
      <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => duplicateModuleTemplate(templateKey), (id) => router.push(`/admin/module-templates/${id}`))}>
        <Copy className="size-3.5" aria-hidden />
        Duplicate
      </Button>
      {editable ? (
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => setModuleTemplateArchived(templateKey, true))}>
          <Archive className="size-3.5" aria-hidden />
          Archive
        </Button>
      ) : null}
    </div>
  );
}
