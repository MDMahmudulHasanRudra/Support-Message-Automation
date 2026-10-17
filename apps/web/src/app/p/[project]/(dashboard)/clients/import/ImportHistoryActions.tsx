"use client";

import { useState, useTransition } from "react";
import { Eraser, Trash2 } from "lucide-react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { Button, ConfirmDialog, useToast } from "@/components/ui";
import { clearClientImports } from "@/server/actions/clientImport";

/**
 * Clearing import history (only for someone allowed to delete in Clients; the action checks again).
 * One row, or every finished one. The clients an import brought in are never touched.
 */
export function ClearImports({ id, count, afterClear }: { id?: string; count?: number; afterClear?: string }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, start] = useTransition();
  const all = id === undefined;
  return (
    <>
      {all ? (
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)} disabled={!count}>
          <Eraser className="size-3.5" aria-hidden /> Clear finished history{count ? ` (${count})` : ""}
        </Button>
      ) : (
        <Button variant="ghost" size="sm" className="!text-[color:var(--color-danger-fg)] hover:!bg-[var(--color-danger-bg)]" onClick={() => setOpen(true)}>
          <Trash2 className="size-3.5" aria-hidden /> Clear
        </Button>
      )}
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        loading={busy}
        tone="danger"
        title={all ? `Clear ${count} finished import${count === 1 ? "" : "s"} from the history?` : "Clear this import from the history?"}
        description="Only the record of the import is removed. Every client it created or updated stays exactly as it is. An import still running, or a preview from today, is kept."
        confirmLabel="Clear"
        onConfirm={() =>
          start(async () => {
            const r = await clearClientImports(all ? "finished" : [id]);
            showToast({ tone: r.ok ? "success" : "danger", title: r.message });
            setOpen(false);
            if (r.ok && afterClear) router.push(afterClear);
            else router.refresh();
          })
        }
      />
    </>
  );
}
