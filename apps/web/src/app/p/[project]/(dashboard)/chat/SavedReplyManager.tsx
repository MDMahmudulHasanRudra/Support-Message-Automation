"use client";

import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { Alert, Button, ConfirmDialog, Dialog, Field, Input, Textarea, useToast } from "@/components/ui";
import {
  createSavedReply,
  deleteSavedReply,
  updateSavedReply,
} from "@/server/actions/savedReplies";
import type { SavedReplyOption } from "./SavedReplyPicker";

/**
 * Create, edit and delete saved replies.
 *
 * Each row is its own form rather than one big form with an array of fields: saving one reply
 * should not risk re-submitting an unrelated half-edited one, and a per-row submit is also what
 * lets the server action stay a plain `(id, formData)` pair instead of parsing indexed names.
 */
export function SavedReplyManager({
  open,
  onClose,
  replies,
}: {
  open: boolean;
  onClose: () => void;
  replies: SavedReplyOption[];
}) {
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SavedReplyOption | null>(null);
  const [pending, startTransition] = useTransition();
  const { showToast } = useToast();

  function run(action: () => Promise<{ error?: string }>, success: string) {
    startTransition(async () => {
      const result = await action();
      if (result.error) {
        setError(result.error);
        return;
      }
      setError(null);
      showToast({ tone: "success", title: success });
    });
  }

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        title="Saved replies"
        description="The sentences your team retypes every day. Picking one drops it into the box — it is never sent on its own."
      >
        {error ? (
          <div className="mb-3">
            <Alert tone="danger">{error}</Alert>
          </div>
        ) : null}

        <div className="space-y-3">
          {replies.length === 0 ? (
            <p className="rounded-[var(--radius-md)] border border-dashed border-[var(--color-border-strong)] px-3 py-6 text-center text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
              Nothing saved yet. Good first ones are the replies you send without thinking —
              &ldquo;payment received&rdquo;, &ldquo;checking with the team&rdquo;, the steps for a
              password reset.
            </p>
          ) : (
            replies.map((reply) => (
              <form
                key={reply.id}
                action={(formData) => run(() => updateSavedReply(reply.id, formData), "Reply saved")}
                className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-2.5"
              >
                <Input
                  name="title"
                  defaultValue={reply.title}
                  maxLength={60}
                  aria-label={`Name for ${reply.title}`}
                  className="mb-2"
                />
                <Textarea
                  name="body"
                  defaultValue={reply.body}
                  rows={3}
                  maxLength={2000}
                  aria-label={`Text for ${reply.title}`}
                  className="resize-y"
                />
                <div className="mt-2 flex items-center gap-2">
                  <Button type="submit" size="sm" variant="secondary" disabled={pending}>
                    Save
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => setDeleting(reply)}
                    aria-label={`Delete ${reply.title}`}
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </Button>
                </div>
              </form>
            ))
          )}
        </div>

        <form
          action={(formData) => run(() => createSavedReply(formData), "Reply added")}
          className="mt-4 border-t border-[var(--color-border)] pt-4"
        >
          <Field label="New saved reply">
            <Input name="title" placeholder="Payment received" maxLength={60} required className="mb-2" />
            <Textarea
              name="body"
              rows={3}
              maxLength={2000}
              required
              placeholder="Payment ta amra peyechi. Apnar account update kore dewa hoyeche."
              className="resize-y"
            />
          </Field>
          <Button type="submit" className="mt-2" disabled={pending}>
            Add reply
          </Button>
        </form>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          const target = deleting;
          setDeleting(null);
          if (target) run(() => deleteSavedReply(target.id), "Reply deleted");
        }}
        loading={pending}
        title={`Delete “${deleting?.title ?? ""}”?`}
        description="It disappears from the picker. Messages already sent are unaffected."
        confirmLabel="Delete reply"
      />
    </>
  );
}
