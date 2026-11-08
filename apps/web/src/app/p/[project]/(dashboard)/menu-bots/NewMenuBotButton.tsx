"use client";

import { useState, useTransition } from "react";
import { FilePlus2, Plus } from "lucide-react";
import { Alert, Button, Dialog } from "@/components/ui";
import { useProjectRouter } from "@/components/ProjectLink";
import { createMenuBot } from "@/server/actions/menuBots";

type Template = { id: string; name: string; description: string; language: string };

export function NewMenuBotButton({ templates }: { templates: Template[] }) {
  const router = useProjectRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const create = (templateId?: string) =>
    start(async () => {
      const r = await createMenuBot({ templateId });
      if ("error" in r) setError(r.error);
      else router.push(`/menu-bots/${r.id}`);
    });

  const card = "flex w-full flex-col rounded-[var(--radius-md)] border border-[var(--color-border)] p-3 text-left transition-colors hover:border-[var(--color-border-strong)] hover:bg-[var(--color-neutral-bg)] disabled:opacity-60";

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="size-4" aria-hidden />
        New menu bot
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} size="lg" title="New menu bot" description="Start from a template and change the wording to yours. It stays a draft until you switch it on.">
        <div className="grid gap-2 sm:grid-cols-2">
          {templates.map((t) => (
            <button key={t.id} type="button" disabled={pending} onClick={() => create(t.id)} className={card}>
              <span className="flex items-center justify-between gap-2">
                <span className="truncate text-[13.5px] font-semibold">{t.name}</span>
                <span className="shrink-0 text-[12px] text-[color:var(--color-muted-foreground)]">{t.language}</span>
              </span>
              <span className="mt-0.5 text-[12.5px] text-[color:var(--color-muted-foreground)]">{t.description}</span>
            </button>
          ))}
          <button type="button" disabled={pending} onClick={() => create()} className={card}>
            <span className="flex items-center gap-1.5 text-[13.5px] font-semibold">
              <FilePlus2 className="size-3.5" aria-hidden />
              Start empty
            </span>
            <span className="mt-0.5 text-[12.5px] text-[color:var(--color-muted-foreground)]">Build your own menu from the first step.</span>
          </button>
        </div>
        {error ? (
          <div className="mt-3">
            <Alert tone="danger">{error}</Alert>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}
