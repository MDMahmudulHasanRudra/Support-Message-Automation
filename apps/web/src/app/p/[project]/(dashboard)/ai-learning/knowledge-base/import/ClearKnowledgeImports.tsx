"use client";

import { useState, useTransition } from "react";
import { Eraser, Trash2 } from "lucide-react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { Button, ConfirmDialog, useToast } from "@/components/ui";
import { clearKnowledgeImports } from "@/server/actions/knowledgeImport";

/** Clears finished knowledge imports from the list (Administrator only; the action checks again). Entries are kept. */
export function ClearKnowledgeImports({ id, count }: { id?: string; count?: number }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, start] = useTransition();
  const all = id === undefined;
  return (
    <>
      {all ? (
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)} disabled={!count}>
          <Eraser className="size-3.5" aria-hidden /> Clear finished{count ? ` (${count})` : ""}
        </Button>
      ) : (
        <Button variant="ghost" size="sm" className="!px-1.5 !text-[color:var(--color-danger-fg)]" onClick={() => setOpen(true)} title="Clear from the list" aria-label="Clear from the list">
          <Trash2 className="size-3.5" aria-hidden />
        </Button>
      )}
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        loading={busy}
        tone="danger"
        title={all ? `Clear ${count} finished import${count === 1 ? "" : "s"}?` : "Clear this import from the list?"}
        description="Only the record of the import is removed, with the source text kept for Retry. Every knowledge entry it produced stays in the knowledge base. Imports still waiting or running are kept."
        confirmLabel="Clear"
        onConfirm={() =>
          start(async () => {
            const r = await clearKnowledgeImports(all ? "finished" : [id]);
            showToast({ tone: r.ok ? "success" : "danger", title: r.message });
            setOpen(false);
            router.refresh();
          })
        }
      />
    </>
  );
}
