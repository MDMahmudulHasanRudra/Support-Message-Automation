"use client";

import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { CHAT_CATEGORY_COLORS, MAX_CHAT_CATEGORY_NAME } from "@support-automation/shared";
import { Alert, Button, ConfirmDialog, Dialog, Field, Input, useToast } from "@/components/ui";
import {
  createChatCategory,
  deleteChatCategory,
  renameChatCategory,
} from "@/server/actions/chatOrganisation";
import type { ChatCategorySummary } from "@/server/chatInbox";
import { categoryDotClass } from "./categoryColors";

/**
 * Create, rename, recolour and delete the inbox's folders.
 *
 * A dialog rather than its own page: you reach for it while looking at the list you are
 * organising, and losing that context to a full navigation is the thing that makes people stop
 * bothering to tidy. Everything here is small enough to fit.
 */
export function CategoryManager({
  open,
  onClose,
  categories,
}: {
  open: boolean;
  onClose: () => void;
  categories: ChatCategorySummary[];
}) {
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ChatCategorySummary | null>(null);
  const [pending, startTransition] = useTransition();
  const { showToast } = useToast();

  function handleCreate(formData: FormData) {
    startTransition(async () => {
      const result = await createChatCategory(formData);
      if (result.error) {
        setError(result.error);
        return;
      }
      setError(null);
      showToast({ tone: "success", title: "Category created" });
    });
  }

  function handleRename(id: string, formData: FormData) {
    startTransition(async () => {
      const result = await renameChatCategory(id, formData);
      if (result.error) {
        setError(result.error);
        return;
      }
      setError(null);
      showToast({ tone: "success", title: "Category saved" });
    });
  }

  function handleDelete(category: ChatCategorySummary) {
    setDeleting(null);
    startTransition(async () => {
      const result = await deleteChatCategory(category.id);
      if (result.error) {
        showToast({ tone: "danger", title: result.error });
        return;
      }
      showToast({
        tone: "success",
        title: `“${category.name}” deleted`,
        // Said explicitly because "delete a folder with 40 things in it" is exactly when somebody
        // needs to know the things survived.
        description: result.updated
          ? `${result.updated} conversation${result.updated === 1 ? "" : "s"} became uncategorised.`
          : undefined,
      });
    });
  }

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        title="Categories"
        description="Folders for the chat inbox. They change what you see here and nothing else — monitoring and AI are untouched."
      >
        {error ? (
          <div className="mb-3">
            <Alert tone="danger">{error}</Alert>
          </div>
        ) : null}

        <div className="space-y-2">
          {categories.length === 0 ? (
            <p className="rounded-[var(--radius-md)] border border-dashed border-[var(--color-border-strong)] px-3 py-6 text-center text-[13px] text-[color:var(--color-muted-foreground)]">
              No categories yet. Create one below, then use <strong>Select</strong> in the list to file
              conversations into it.
            </p>
          ) : (
            categories.map((category) => (
              <form
                key={category.id}
                action={(formData) => handleRename(category.id, formData)}
                className="flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] p-2"
              >
                <span className={`size-2.5 shrink-0 rounded-full ${categoryDotClass(category.color)}`} aria-hidden />
                <Input
                  name="name"
                  defaultValue={category.name}
                  maxLength={MAX_CHAT_CATEGORY_NAME}
                  aria-label={`Rename ${category.name}`}
                  className="min-w-0 flex-1"
                />
                <ColorSelect name="color" defaultValue={category.color} />
                <span className="tabular text-[11px] text-[color:var(--color-muted-foreground)]">
                  {category.count}
                </span>
                <Button type="submit" size="sm" variant="secondary" disabled={pending}>
                  Save
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => setDeleting(category)}
                  aria-label={`Delete ${category.name}`}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </Button>
              </form>
            ))
          )}
        </div>

        <form action={handleCreate} className="mt-4 border-t border-[var(--color-border)] pt-4">
          <Field label="New category" hint={`Up to ${MAX_CHAT_CATEGORY_NAME} characters.`}>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                name="name"
                placeholder="Billing, VIP clients, Escalated…"
                maxLength={MAX_CHAT_CATEGORY_NAME}
                className="min-w-0 flex-1"
                required
              />
              <ColorSelect name="color" defaultValue="blue" />
              <Button type="submit" disabled={pending}>
                Add
              </Button>
            </div>
          </Field>
        </form>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && handleDelete(deleting)}
        loading={pending}
        title={`Delete “${deleting?.name ?? ""}”?`}
        description={
          deleting
            ? `${deleting.count} conversation${deleting.count === 1 ? "" : "s"} will become uncategorised. Nothing is deleted or unmonitored — only the folder goes.`
            : ""
        }
        confirmLabel="Delete category"
      />
    </>
  );
}

/** The fixed palette — see packages/shared/src/chatCategories.ts for why it is not a colour picker. */
function ColorSelect({ name, defaultValue }: { name: string; defaultValue: string }) {
  return (
    <select
      name={name}
      defaultValue={defaultValue}
      aria-label="Colour"
      className="h-8 shrink-0 rounded-[var(--radius-xs)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[12px] capitalize text-[color:var(--color-foreground)] outline-none focus-visible:border-[var(--color-primary)]"
    >
      {CHAT_CATEGORY_COLORS.map((color) => (
        <option key={color} value={color}>
          {color}
        </option>
      ))}
    </select>
  );
}
