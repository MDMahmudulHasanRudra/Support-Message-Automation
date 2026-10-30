"use client";

import { useState, useTransition } from "react";
import { Bookmark, X } from "lucide-react";
import Link, { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { Button, Checkbox, Input, useToast } from "@/components/ui";
import { deleteListView, saveListView } from "@/server/actions/listSavedViews";
import type { SavedViewItem } from "@/server/listSavedViewsReader";

/**
 * Saved filters for a list page: one click back to "Drafts to confirm" or "Low stock shirts". The
 * filters are the page's own query string, so a saved view is the same as a bookmark of the URL.
 */
export function SavedViewsBar({ page, views, currentQuery, canShare }: { page: string; views: SavedViewItem[]; currentQuery: string; canShare: boolean }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);

  const run = (fn: () => Promise<{ error?: string; success?: string }>, after?: () => void) =>
    startTransition(async () => {
      const r = await fn();
      showToast({ tone: r.error ? "danger" : "success", title: r.error ?? r.success ?? "Done" });
      if (!r.error) after?.();
      router.refresh();
    });

  if (views.length === 0 && !currentQuery) return null;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
      <Bookmark className="size-4 text-[color:var(--color-muted-foreground)]" aria-hidden />
      {views.map((v) => {
        const active = v.query === currentQuery;
        return (
          <span
            key={v.id}
            className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs ${active ? "border-[var(--color-accent)] font-semibold" : "border-[var(--color-border)]"}`}
          >
            <Link href={`${page}?${v.query}`} className="hover:underline">
              {v.name}
            </Link>
            {v.shared ? <span className="text-[color:var(--color-muted-foreground)]">· shared</span> : null}
            {v.mine || (v.shared && canShare) ? (
              <button type="button" aria-label={`Delete view ${v.name}`} className="cursor-pointer text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-danger)]" disabled={pending} onClick={() => run(() => deleteListView(v.id))}>
                <X className="size-3" aria-hidden />
              </button>
            ) : null}
          </span>
        );
      })}
      {currentQuery ? (
        naming ? (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => saveListView(page, name, currentQuery, shared), () => {
                setNaming(false);
                setName("");
                setShared(false);
              });
            }}
          >
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name this view" maxLength={60} className="h-8 w-48" autoFocus />
            {canShare ? (
              <label className="flex items-center gap-1 text-xs">
                <Checkbox checked={shared} onChange={(e) => setShared(e.target.checked)} /> Share with the team
              </label>
            ) : null}
            <Button type="submit" size="sm" loading={pending}>
              Save
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setNaming(false)}>
              Cancel
            </Button>
          </form>
        ) : views.some((v) => v.query === currentQuery) ? null : (
          <Button size="sm" variant="ghost" onClick={() => setNaming(true)}>
            Save this view
          </Button>
        )
      ) : null}
    </div>
  );
}
