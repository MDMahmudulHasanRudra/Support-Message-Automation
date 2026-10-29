"use client";

import { useState, useTransition } from "react";
import { X } from "lucide-react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { Button, Input, useToast } from "@/components/ui";
import { deleteCategory, saveCategory } from "@/server/actions/commerce";

/** Add and remove product categories. Removing one keeps its products, uncategorised. */
export function CategoryManager({ categories, canManage }: { categories: Array<{ id: string; name: string; count: number }>; canManage: boolean }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [name, setName] = useState("");
  const [pending, startTransition] = useTransition();

  function run(fn: () => Promise<{ error?: string; success?: string }>, after?: () => void) {
    startTransition(async () => {
      const r = await fn();
      showToast({ tone: r.error ? "danger" : "success", title: r.error ?? r.success ?? "Done" });
      if (!r.error) after?.();
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {categories.length === 0 ? <span className="text-sm text-[color:var(--color-muted-foreground)]">No categories yet.</span> : null}
        {categories.map((c) => (
          <span key={c.id} className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] px-3 py-1 text-xs">
            {c.name}
            <span className="tabular text-[color:var(--color-muted-foreground)]">{c.count}</span>
            {canManage ? (
              <button
                type="button"
                aria-label={`Remove category ${c.name}`}
                className="cursor-pointer text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-danger)]"
                disabled={pending}
                onClick={() => run(() => deleteCategory(c.id))}
              >
                <X className="size-3" aria-hidden />
              </button>
            ) : null}
          </span>
        ))}
      </div>
      {canManage ? (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => saveCategory(name), () => setName(""));
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New category" maxLength={120} className="w-56" />
          <Button type="submit" variant="secondary" size="md" loading={pending}>
            Add
          </Button>
        </form>
      ) : null}
    </div>
  );
}
